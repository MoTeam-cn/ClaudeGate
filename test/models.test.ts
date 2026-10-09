#!/usr/bin/env node
/**
 * 模型目录测试。
 *
 * 覆盖三件事：
 *   1. 从 Claude Code 的目录文档里解析模型（形状可能变，解析要能扛）
 *   2. 远端拉取 + 内存缓存 + 磁盘兜底，/v1/models 不按请求出网
 *   3. 两个消息接口都拒绝清单外的模型
 *
 * 运行：node test/models.test.ts
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import { createGateway } from "../src/server.ts";
import { parseCatalog, builtinEntries, normalizeModelId } from "../src/model-catalog.ts";
import { MODEL_CATALOG, MODEL_ALIASES } from "../src/constants.ts";
import { signGatewayToken } from "../src/tokens.ts";
import { cleanupDir } from "./helpers/tmp.ts";
import { request } from "./helpers/client.ts";
import type { AddressInfo } from "node:net";

let pass = 0;
let fail = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, detail?: string): void {
  if (cond) { pass++; console.log("  PASS  " + name); }
  else { fail++; const l = name + (detail ? " :: " + detail : ""); failures.push(l); console.log("  FAIL  " + l); }
}
function eq(name: string, a: unknown, b: unknown): void {
  ok(name, a === b, "expected=" + JSON.stringify(b) + " actual=" + JSON.stringify(a));
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const watchdog = setTimeout(() => { console.log("\n!! 超时"); process.exit(3); }, 60000);

/* ================= A. 解析 ================= */
console.log("\n=== A. 目录解析 ===");

/* Claude Code 二进制里编译进去的那份 seed 就是这形状 */
const seed = {
  version: 7,
  models: [
    { id: "claude-haiku-4-5", family: "haiku", display_name: "Haiku 4.5",
      provider_ids: { first_party: "claude-haiku-4-5-20251001", bedrock: "us.anthropic.x" } },
    { id: "claude-opus-5", family: "opus", display_name: "Opus 5",
      provider_ids: { first_party: "claude-opus-5" } },
    { id: "not-a-model", family: "x", display_name: "噪音" }
  ]
};
const p1 = parseCatalog(seed);
eq("抠出两个模型", p1.entries.length, 2);
eq("读到了 version", p1.version, 7);
eq("家族 id 保留", p1.entries[0].id, "claude-haiku-4-5");
eq("first_party 单独存", p1.entries[0].firstParty, "claude-haiku-4-5-20251001");
eq("显示名保留", p1.entries[0].label, "Haiku 4.5");
eq("family 保留", p1.entries[0].family, "haiku");

/* 形状变了也得认：换个嵌套、换个字段名 */
const nested = { data: { catalog: { entries: [
  { id: "claude-sonnet-5", displayName: "Sonnet 5" }
] } } };
const p2 = parseCatalog(nested);
eq("嵌套结构也能挖到", p2.entries.length, 1);
eq("displayName 认", p2.entries[0].label, "Sonnet 5");
eq("没有 provider_ids 时 first_party 退回 id", p2.entries[0].firstParty, "claude-sonnet-5");
eq("没有 version 就是 null", p2.version, null);

eq("空文档不炸", parseCatalog({}).entries.length, 0);
eq("null 不炸", parseCatalog(null).entries.length, 0);
eq("字符串不炸", parseCatalog("nope").entries.length, 0);

/* 环状引用不能让它无限递归 —— 用深度上限兜住 */
const cyc: Record<string, unknown> = { id: "claude-opus-5", name: "x" };
cyc.self = cyc;
const p3 = parseCatalog(cyc);
eq("环状引用只收一次", p3.entries.length, 1);

/* ================= B. 内置兜底清单 ================= */
console.log("\n=== B. 内置清单 ===");
const builtin = builtinEntries();
ok("内置清单不为空", builtin.length >= 20, "长度=" + builtin.length);
ok("含 Opus 5", builtin.some((e) => e.id === "claude-opus-5"));
ok("含 Opus 5.5", builtin.some((e) => e.id === "claude-opus-5-5"));
ok("含 Sonnet 5", builtin.some((e) => e.id === "claude-sonnet-5"));
ok("含 Sonnet 5.5", builtin.some((e) => e.id === "claude-sonnet-5-5"));
ok("含 Haiku 5.5", builtin.some((e) => e.id === "claude-haiku-5-5"));
ok("含 Opus 4.8", builtin.some((e) => e.id === "claude-opus-4-8"));
ok("老模型也还在", builtin.some((e) => e.id === "claude-3-5-haiku"));
ok("每个都有 label", builtin.every((e) => !!e.label));
ok("每个都有 firstParty", builtin.every((e) => !!e.firstParty));
ok("id 不重复", new Set(builtin.map((e) => e.id)).size === builtin.length);

/* 别名指向的目标必须真在清单里，否则别名就是个死链 */
const builtinIds = new Set<string>();
for (const e of builtin) { builtinIds.add(e.id); builtinIds.add(e.firstParty); builtinIds.add(e.id.replace(/-\d{8}$/, "")); builtinIds.add(e.firstParty.replace(/-\d{8}$/, "")); }
const deadAliases = Object.entries(MODEL_ALIASES).filter(([, to]) => !builtinIds.has(to) && !builtinIds.has(String(to).replace(/-\d{8}$/, "")));
ok("别名没有死链", deadAliases.length === 0, JSON.stringify(deadAliases.slice(0, 4)));

eq("normalizeModelId 去 [1m]", normalizeModelId("claude-opus-5[1m]"), "claude-opus-5");
eq("normalizeModelId 小写", normalizeModelId("  Claude-Opus-5  "), "claude-opus-5");

/* ================= C. 拉取与缓存 ================= */
console.log("\n=== C. 拉取与缓存 ===");

let catalogHits = 0;
/* 远端目录 = 完整清单 + 一个只在远端出现的模型。
   用完整清单才谈得上「校验认得别名」，否则内置清单会被这两个模型整个替换掉 */
const fullDoc = {
  version: 42,
  models: MODEL_CATALOG.map((m) => ({
    id: m.id, family: m.family, display_name: m.label,
    provider_ids: { first_party: m.firstParty }
  })).concat([
    { id: "claude-test-9", family: "test", display_name: "Test 9", provider_ids: { first_party: "claude-test-9-20260101" } }
  ])
};
/* 换一份精简的，用来验证「校验跟着当前快照走」 */
const slimDoc = { version: 43, models: [
  { id: "claude-test-9", family: "test", display_name: "Test 9", provider_ids: { first_party: "claude-test-9-20260101" } }
] };
let catalogDoc: unknown = fullDoc;
const catalogSrv = http.createServer((_req, res) => {
  catalogHits += 1;
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(catalogDoc));
});
const catPort = await new Promise<number>((r) => catalogSrv.listen(0, "127.0.0.1", () => r((catalogSrv.address() as AddressInfo).port)));

let upHits = 0;
const upstream = http.createServer((req, res) => {
  upHits += 1;
  const chunks: Buffer[] = [];
  req.on("data", (c: Buffer) => chunks.push(c));
  req.on("end", () => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ id: "m", type: "message", role: "assistant", model: "x",
      content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 } }));
  });
});
const upPort = await new Promise<number>((r) => upstream.listen(0, "127.0.0.1", () => r((upstream.address() as AddressInfo).port)));

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cg-cat-"));
const gw = createGateway({
  PORT: "0", HOST: "127.0.0.1", DATA_DIR: dataDir, SECRET: "cat-secret",
  UPSTREAM_BASE: "http://127.0.0.1:" + upPort,
  MODEL_CATALOG_URL: "http://127.0.0.1:" + catPort + "/catalog.json",
  GUARD_MODE: "strict", STEGO_MODE: "block", ADMIN_TOKEN: "cat-admin",
  LOG_LEVEL: "error", TRANSPORT: "https"
});
gw.accounts.create({ label: "c", kind: "oauth", accessToken: "oauth-access",
  refreshToken: "r", expiresAt: Math.floor(Date.now() / 1000) + 7200, scope: "user:inference" });
const port = await new Promise<number>((r) => gw.server.listen(0, "127.0.0.1", () => r((gw.server.address() as AddressInfo).port)));
const gwToken = signGatewayToken(gw.cfg, "default");

const ccHeaders = (extra: Record<string, string> = {}): Record<string, string> => ({
  "content-type": "application/json", authorization: "Bearer " + gwToken,
  "user-agent": "claude-cli/2.1.293 (external, cli)", "x-app": "cli",
  "anthropic-version": "2023-06-01", "x-claude-code-session-id": "0f8fad5b-d9cb-469f-a165-70867728950e",
  ...extra
});

eq("起步用内置清单", gw.modelCatalog.get().source, "builtin");

/* 强制刷一次，拿到远端那份 */
const refreshed = await gw.modelCatalog.refresh();
eq("刷完来源是 remote", refreshed.source, "remote");
eq("读到远端 version", refreshed.version, 42);
eq("远端清单覆盖了内置", refreshed.entries.length, MODEL_CATALOG.length + 1);
ok("远端拉到测试模型", refreshed.entries.some((e) => e.id === "claude-test-9"));
ok("拉取确实打到了目录服务", catalogHits >= 1, "hits=" + catalogHits);

ok("磁盘缓存已落盘", fs.existsSync(path.join(dataDir, "model-catalog.json")));

/* 关键：/v1/models 读内存，不能因为这次请求出网 */
const hitsBefore = catalogHits;
const upBefore = upHits;
const modelsRes = await request(port, "/v1/models", { headers: ccHeaders({ "user-agent": "curl/8" }) });
eq("models 200", modelsRes.status, 200);
eq("models 用的是远端清单", refreshed.entries.length, MODEL_CATALOG.length + 1);
ok("列表里有远端那个模型", modelsRes.text.includes("claude-test-9"));
eq("这次请求没打目录服务", catalogHits, hitsBefore);
eq("这次请求没打上游", upHits, upBefore);

/* 再来几次也一样 */
await request(port, "/v1/models");
await request(port, "/v1/models");
eq("连续三次也不出网", catalogHits, hitsBefore);

/* 第二个实例从磁盘缓存起步，不用先出网 */
const gw2 = createGateway({
  PORT: "0", HOST: "127.0.0.1", DATA_DIR: dataDir, SECRET: "cat-secret2",
  UPSTREAM_BASE: "http://127.0.0.1:" + upPort,
  MODEL_CATALOG_URL: "http://127.0.0.1:" + catPort + "/catalog.json",
  GUARD_MODE: "strict", STEGO_MODE: "block", ADMIN_TOKEN: "cat-admin2",
  LOG_LEVEL: "error", TRANSPORT: "https", MODEL_CATALOG_TTL_MS: "999999999"
});
eq("第二个实例直接从缓存起步", gw2.modelCatalog.get().source, "cache");
ok("缓存里带着测试模型", gw2.modelCatalog.get().entries.some((e) => e.id === "claude-test-9"));
ok("TTL 内不会再刷", gw2.modelCatalog.ensure().source === "cache");
await gw2.close();

/* 目录服务挂了不能把网关带崩，也不能把清单清空 */
const dead = createGateway({
  PORT: "0", HOST: "127.0.0.1", DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), "cg-cat-dead-")), SECRET: "s",
  UPSTREAM_BASE: "http://127.0.0.1:" + upPort,
  MODEL_CATALOG_URL: "http://127.0.0.1:1/nope",
  GUARD_MODE: "strict", STEGO_MODE: "block", ADMIN_TOKEN: "a", LOG_LEVEL: "error", TRANSPORT: "https"
});
const deadRes = await dead.modelCatalog.refresh();
ok("拉不到时保留旧清单", deadRes.entries.length >= 20, "长度=" + deadRes.entries.length);
ok("拉不到时如实记原因", typeof deadRes.error === "string" && deadRes.error.length > 0, String(deadRes.error));
await dead.close();

/* ================= D. 消息接口的模型校验 ================= */
console.log("\n=== D. 模型校验 ===");

const MSG = { model: "claude-test-9", max_tokens: 16, messages: [{ role: "user", content: "hi" }] };
const goodAnt = await request(port, "/v1/messages", { headers: ccHeaders(), body: MSG });
eq("清单内的模型放行（anthropic）", goodAnt.status, 200);

const badAnt = await request(port, "/v1/messages", { headers: ccHeaders(), body: { ...MSG, model: "gpt-9-ultra" } });
eq("清单外的模型拒绝（anthropic）", badAnt.status, 400);
ok("是 invalid_request_error", badAnt.text.includes("invalid_request_error"), badAnt.text.slice(0, 160));
ok("报错说清了是哪个模型", badAnt.text.includes("gpt-9-ultra"), badAnt.text.slice(0, 160));
ok("报错指向 /v1/models", badAnt.text.includes("/v1/models"), badAnt.text.slice(0, 200));

const goodOai = await request(port, "/v1/chat/completions", {
  headers: ccHeaders(), body: { model: "claude-test-9", messages: [{ role: "user", content: "hi" }] } });
eq("清单内的模型放行（openai）", goodOai.status, 200);

const badOai = await request(port, "/v1/chat/completions", {
  headers: ccHeaders(), body: { model: "gpt-9-ultra", messages: [{ role: "user", content: "hi" }] } });
eq("清单外的模型拒绝（openai）", badOai.status, 400);
ok("openai 错误形态", badOai.text.includes("invalid_request_error"), badOai.text.slice(0, 160));

/* 别名、日期后缀、1M 后缀都得认 */
for (const m of ["sonnet", "opus", "gpt-4o", "claude-opus-5", "claude-opus-5-5", "claude-opus-5[1m]", "claude-test-9-20260101"]) {
  const r = await request(port, "/v1/messages", { headers: ccHeaders(), body: { ...MSG, model: m } });
  eq("认得 " + m, r.status, 200);
}

/* 把远端换成精简版，校验必须跟着变 —— 证明读的是当前快照而不是写死的清单 */
const beforeSlim = await request(port, "/v1/messages", { headers: ccHeaders(), body: { ...MSG, model: "claude-opus-5-5" } });
eq("换之前 opus-5-5 放行", beforeSlim.status, 200);
catalogDoc = slimDoc;
const slimmed = await gw.modelCatalog.refresh();
eq("换之后版本变了", slimmed.version, 43);
eq("换之后只剩一个模型", slimmed.entries.length, 1);
const afterSlim = await request(port, "/v1/messages", { headers: ccHeaders(), body: { ...MSG, model: "claude-opus-5-5" } });
eq("换之后 opus-5-5 被拒", afterSlim.status, 400);
const stillThere = await request(port, "/v1/messages", { headers: ccHeaders(), body: { ...MSG, model: "claude-test-9" } });
eq("换之后测试模型还在", stillThere.status, 200);
/* 恢复，免得影响后面的用例 */
catalogDoc = fullDoc;
await gw.modelCatalog.refresh();

/* ================= E. 关掉校验 ================= */
console.log("\n=== E. MODEL_VALIDATION=off ===");
const lax = createGateway({
  PORT: "0", HOST: "127.0.0.1", DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), "cg-cat-lax-")), SECRET: "lax",
  UPSTREAM_BASE: "http://127.0.0.1:" + upPort,
  MODEL_CATALOG_URL: "http://127.0.0.1:" + catPort + "/catalog.json",
  MODEL_VALIDATION: "off",
  GUARD_MODE: "strict", STEGO_MODE: "block", ADMIN_TOKEN: "lax-admin", LOG_LEVEL: "error", TRANSPORT: "https"
});
lax.accounts.create({ label: "l", kind: "oauth", accessToken: "oauth-access",
  refreshToken: "r", expiresAt: Math.floor(Date.now() / 1000) + 7200, scope: "user:inference" });
const laxPort = await new Promise<number>((r) => lax.server.listen(0, "127.0.0.1", () => r((lax.server.address() as AddressInfo).port)));
const laxToken = signGatewayToken(lax.cfg, "default");
const laxRes = await request(laxPort, "/v1/messages", {
  headers: { ...ccHeaders(), authorization: "Bearer " + laxToken }, body: { ...MSG, model: "totally-made-up" } });
eq("关掉校验后放行", laxRes.status, 200);
await lax.close();

/* ================= 收尾 ================= */
clearTimeout(watchdog);
await gw.close();
await new Promise<void>((r) => catalogSrv.close(() => r()));
await new Promise<void>((r) => upstream.close(() => r()));
cleanupDir(dataDir);

console.log("\n================================");
console.log("  PASS " + pass + "   FAIL " + fail);
if (failures.length) { console.log("  失败项："); for (const f of failures) console.log("   - " + f); }
process.exit(fail ? 1 : 0);
