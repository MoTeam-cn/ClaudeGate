#!/usr/bin/env node
/**
 * 号池 / API Key / 守卫策略 / 配额 / 面板 的测试。
 * 运行：node test/pool.test.ts
 */

import http from "node:http";
import { cleanupDir } from "./helpers/tmp.ts";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

import { createGateway } from "../src/server.ts";
import { createMockUpstream } from "./helpers/mock-upstream.ts";
import { request, getText, asRecord } from "./helpers/client.ts";
import type { Account, ApiKeyRecord } from "../src/types.ts";
import type { AddressInfo } from "node:net";

let pass = 0;
let fail = 0;
const failures: string[] = [];

function ok(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    pass++;
    console.log("  PASS  " + name);
  } else {
    fail++;
    const line = name + (detail ? " :: " + detail : "");
    failures.push(line);
    console.log("  FAIL  " + line);
  }
}
function eq(name: string, actual: unknown, expected: unknown): void {
  ok(name, actual === expected, "expected=" + JSON.stringify(expected) + " actual=" + JSON.stringify(actual));
}
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

const watchdog = setTimeout(() => {
  console.log("\n!! 测试超时（60s），已中断");
  process.exit(3);
}, 60000);

const cleanup: Array<() => Promise<void>> = [];
const dataDirs: string[] = [];

function newDir(tag: string): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "cg-pool-" + tag + "-"));
  dataDirs.push(d);
  return d;
}

/** 可切换状态码的假上游，用来验证故障转移与冷却 */
function createFlakyUpstream(): {
  setStatus(n: number): void;
  hits: string[];
  listen(): Promise<number>;
  close(): Promise<void>;
} {
  let status = 200;
  const hits: string[] = [];
  const server = http.createServer((req, res) => {
    req.on("data", () => undefined);
    req.on("end", () => {
      hits.push(String(req.headers.authorization ?? req.headers["x-api-key"] ?? "?"));
      if (status >= 400) {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "mock " + status } }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        id: "msg_ok",
        model: "claude-sonnet-4-5-20250929",
        content: [{ type: "text", text: "ok" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 3, output_tokens: 2 }
      }));
    });
  });
  return {
    setStatus(n) {
      status = n;
    },
    hits,
    listen(): Promise<number> {
      return new Promise((r) => server.listen(0, "127.0.0.1", () => r((server.address() as AddressInfo).port)));
    },
    close(): Promise<void> {
      if (typeof server.closeAllConnections === "function") server.closeAllConnections();
      return new Promise((r) => server.close(() => r()));
    }
  };
}

const upstream = createMockUpstream();
const upPort = await upstream.listen();
cleanup.push(() => upstream.close());

const flaky = createFlakyUpstream();
const flakyPort = await flaky.listen();
cleanup.push(() => flaky.close());

const ADMIN = "admin-token-xyz";
const gw = createGateway({
  PORT: "0",
  HOST: "127.0.0.1",
  DATA_DIR: newDir("main"),
  SECRET: "pool-secret",
  UPSTREAM_BASE: "http://127.0.0.1:" + upPort,
  GUARD_MODE: "strict",
  INJECT_MISSING: "false",
  STEGO_MODE: "block",
  ADMIN_TOKEN: ADMIN,
  LOG_LEVEL: "error"
});
const addr = await gw.listen(0, "127.0.0.1");
cleanup.push(() => gw.close());

const CC: Record<string, string> = {
  "user-agent": "claude-cli/2.1.293 (external, cli)",
  "x-app": "cli",
  "anthropic-version": "2023-06-01",
  "x-claude-code-session-id": "0f8fad5b-d9cb-469f-a165-70867728950e",
  "content-type": "application/json"
};
const BODY = { model: "claude-sonnet-4-5-20250929", max_tokens: 32, messages: [{ role: "user", content: "hi" }] };

/* ============ A. 号池 CRUD ============ */
console.log("\n=== A. 号池 CRUD ===");
const a1 = gw.accounts.create({ label: "号一", kind: "oauth", accessToken: "tok-1", refreshToken: "ref-1", expiresAt: Math.floor(Date.now() / 1000) + 7200 });
eq("创建后数量", gw.accounts.list().length, 1);
eq("类型", a1.kind, "oauth");
ok("ID 前缀", a1.id.startsWith("acc_"), a1.id);
eq("状态默认 active", a1.status, "active");
const a1u = gw.accounts.update(a1.id, { label: "号一改", weight: 3 });
eq("更新备注", a1u?.label, "号一改");
eq("更新权重", a1u?.weight, 3);
gw.accounts.setStatus(a1.id, "disabled");
eq("停用生效", gw.accounts.get(a1.id)?.status, "disabled");
gw.accounts.setStatus(a1.id, "active");
gw.accounts.markError(a1.id, "boom", 60000);
ok("标记错误后有冷却", (gw.accounts.get(a1.id)?.cooldownUntil ?? 0) > 0);
eq("错误计数", gw.accounts.get(a1.id)?.errorCount, 1);
gw.accounts.markOk(a1.id);
eq("复位后错误计数", gw.accounts.get(a1.id)?.errorCount, 0);
ok("复位后无冷却", !gw.accounts.get(a1.id)?.cooldownUntil);

const a2 = gw.accounts.create({ label: "号二", kind: "apikey", apiKey: "sk-ant-mock-2" });
eq("两个号", gw.accounts.list().length, 2);
eq("apiKey 类型", a2.kind, "apikey");
ok("删除返回真", gw.accounts.remove(a2.id));
eq("删除后数量", gw.accounts.list().length, 1);

/* ============ B. 调度器 ============ */
console.log("\n=== B. 调度器 ===");
const a3 = gw.accounts.create({ label: "号三", kind: "apikey", apiKey: "sk-ant-mock-3" });
gw.accounts.update(a1.id, { weight: 1 });
const p1 = gw.scheduler.pick({ sessionKey: "s1" });
const p1b = gw.scheduler.pick({ sessionKey: "s1" });
eq("同一会话粘性", p1?.id, p1b?.id);
const p2 = gw.scheduler.pick({ sessionKey: "s2" });
ok("新会话轮询到不同号", p1?.id !== p2?.id, String(p1?.id) + " vs " + String(p2?.id));
const bound = gw.scheduler.pick({ sessionKey: "s3", preferredAccountId: a3.id });
eq("绑定号优先", bound?.id, a3.id);
gw.accounts.setStatus(a3.id, "disabled");
const noDisabled = gw.scheduler.pick({ sessionKey: "s4", preferredAccountId: a3.id });
ok("停用号被跳过", noDisabled?.id !== a3.id, String(noDisabled?.id));
gw.accounts.setStatus(a3.id, "active");
gw.accounts.markError(a3.id, "cool", 600000);
const noCooling = gw.scheduler.pick({ sessionKey: "s5", preferredAccountId: a3.id });
ok("冷却号被跳过", noCooling?.id !== a3.id, String(noCooling?.id));
gw.accounts.markOk(a3.id);
const snap = gw.scheduler.snapshot();
eq("快照账号数", snap.accounts, 2);
eq("快照可用数", snap.active, 2);

/* ============ C. API Key ============ */
console.log("\n=== C. API Key ===");
const mk = gw.keys.create({ name: "cursor", fingerprintMode: "claude_code" });
const keyRec: ApiKeyRecord = mk.record;
ok("Key 明文前缀", mk.plaintext.startsWith("sk-gw-"), mk.plaintext.slice(0, 12));
ok("Key 明文长度", mk.plaintext.length > 20);
ok("展示前缀带省略号", keyRec.keyPrefix.includes("..."), keyRec.keyPrefix);
ok("按明文能查到", gw.keys.findByPlaintext(mk.plaintext)?.id === keyRec.id);
ok("错误明文查不到", gw.keys.findByPlaintext("sk-gw-nope") === null);
ok("明文不落库", !JSON.stringify(gw.keys.list()).includes(mk.plaintext.slice(10)));

const mkPass = gw.keys.create({ name: "cherry", fingerprintMode: "passthrough" });

/* 重置密钥：只换明文，名字 / 配额 / 指纹策略 / 创建时间都要原样保留 */
const mkReset = gw.keys.create({ name: "to-reset", fingerprintMode: "passthrough", rateLimitPerMin: 7 });
const beforeReset = gw.keys.get(mkReset.record.id);
const rs = gw.keys.resetSecret(mkReset.record.id);
ok("重置返回了新明文", !!rs && rs.plaintext.startsWith("sk-gw-"), rs ? rs.plaintext.slice(0, 12) : "null");
ok("新明文与旧的不同", !!rs && rs.plaintext !== mkReset.plaintext);
eq("旧明文立刻失效", gw.keys.findByPlaintext(mkReset.plaintext), null);
eq("新明文能查到", rs ? gw.keys.findByPlaintext(rs.plaintext)?.id : null, mkReset.record.id);
eq("主键没变", rs?.record.id, mkReset.record.id);
eq("名字保留", rs?.record.name, beforeReset?.name);
eq("指纹策略保留", rs?.record.fingerprintMode, beforeReset?.fingerprintMode);
eq("限流配置保留", rs?.record.rateLimitPerMin, beforeReset?.rateLimitPerMin);
eq("创建时间没变", rs?.record.createdAt, beforeReset?.createdAt);
eq("不存在的 id 返回 null", gw.keys.resetSecret("key_nope"), null);

/* ============ D. 鉴权与守卫策略 ============ */
console.log("\n=== D. 鉴权与守卫策略 ===");

const noKey = await request(addr.port, "/v1/messages", { headers: { "content-type": "application/json" }, body: BODY });
eq("无令牌 401", noKey.status, 401);

const badKey = await request(addr.port, "/v1/messages", { headers: { "content-type": "application/json", "x-api-key": "sk-gw-bogus" }, body: BODY });
eq("伪造 Key 401", badKey.status, 401);

const ccKeyNoHeaders = await request(addr.port, "/v1/messages", {
  headers: { "content-type": "application/json", "x-api-key": mk.plaintext },
  body: BODY
});
eq("claude_code Key 缺头 403", ccKeyNoHeaders.status, 403);
ok("403 说明指向指纹策略", JSON.stringify(ccKeyNoHeaders.json).includes("指纹"), ccKeyNoHeaders.text.slice(0, 160));

const ccKeyOk = await request(addr.port, "/v1/messages", {
  headers: { ...CC, "x-api-key": mk.plaintext },
  body: BODY
});
eq("claude_code Key 带头 200", ccKeyOk.status, 200);

const beforeCalls = upstream.calls;
const passKeyNoHeaders = await request(addr.port, "/v1/messages", {
  headers: { "content-type": "application/json", "x-api-key": mkPass.plaintext },
  body: BODY
});
eq("passthrough Key 缺头也放行", passKeyNoHeaders.status, 200);
ok("确实打到了上游", upstream.calls > beforeCalls);
const sentHeaders = upstream.last?.headers ?? {};
ok("注入了规范 UA", String(sentHeaders["user-agent"] ?? "").startsWith("claude-cli/"), String(sentHeaders["user-agent"]));
eq("注入了 x-app", String(sentHeaders["x-app"] ?? ""), "cli");
ok("注入了 session-id", !!sentHeaders["x-claude-code-session-id"], String(sentHeaders["x-claude-code-session-id"]));

gw.keys.update(keyRec.id, { enabled: false });
const disabled = await request(addr.port, "/v1/messages", { headers: { ...CC, "x-api-key": mk.plaintext }, body: BODY });
eq("停用 Key 401", disabled.status, 401);
gw.keys.update(keyRec.id, { enabled: true });

/* ============ E. 模型与协议白名单 ============ */
console.log("\n=== E. 模型与协议白名单 ===");
const protoKey = gw.keys.create({ name: "only-openai", allowedProtocols: ["openai"] });
const anthroOnOpenaiKey = await request(addr.port, "/v1/messages", {
  headers: { ...CC, "x-api-key": protoKey.plaintext },
  body: BODY
});
eq("协议白名单拦截 anthropic", anthroOnOpenaiKey.status, 403);
const openaiOnOpenaiKey = await request(addr.port, "/v1/chat/completions", {
  headers: { ...CC, "x-api-key": protoKey.plaintext },
  body: { model: "gpt-4o", messages: [{ role: "user", content: "hi" }] }
});
eq("协议白名单放行 openai", openaiOnOpenaiKey.status, 200);

const modelKey = gw.keys.create({ name: "only-sonnet", allowedModels: ["claude-sonnet-4-5-20250929"] });
const badModel = await request(addr.port, "/v1/messages", {
  headers: { ...CC, "x-api-key": modelKey.plaintext },
  body: { model: "claude-opus-4-5-20251101", max_tokens: 8, messages: [{ role: "user", content: "hi" }] }
});
eq("模型白名单拦截", badModel.status, 403);
const goodModel = await request(addr.port, "/v1/messages", {
  headers: { ...CC, "x-api-key": modelKey.plaintext },
  body: BODY
});
eq("模型白名单放行", goodModel.status, 200);

/* ============ F. 配额 ============ */
console.log("\n=== F. 配额 ===");
const quotaOff = gw.keys.create({ name: "quota-off", quotaEnabled: false, rateLimitPerMin: 1 });
let allOk = true;
for (let i = 0; i < 3; i++) {
  const r = await request(addr.port, "/v1/messages", { headers: { ...CC, "x-api-key": quotaOff.plaintext }, body: BODY });
  if (r.status !== 200) allOk = false;
}
ok("配额开关关闭时不限流", allOk);

const quotaOn = gw.keys.create({ name: "quota-on", quotaEnabled: true, rateLimitPerMin: 2 });
const r1 = await request(addr.port, "/v1/messages", { headers: { ...CC, "x-api-key": quotaOn.plaintext }, body: BODY });
const r2 = await request(addr.port, "/v1/messages", { headers: { ...CC, "x-api-key": quotaOn.plaintext }, body: BODY });
const r3 = await request(addr.port, "/v1/messages", { headers: { ...CC, "x-api-key": quotaOn.plaintext }, body: BODY });
eq("第 1 次通过", r1.status, 200);
eq("第 2 次通过", r2.status, 200);
eq("第 3 次被限速", r3.status, 429);
ok("429 带限速码", JSON.stringify(r3.json).includes("rate_limit_exceeded"), r3.text.slice(0, 160));

const dailyKey = gw.keys.create({ name: "daily-2", quotaEnabled: true, dailyRequestLimit: 2 });
const d1 = await request(addr.port, "/v1/messages", { headers: { ...CC, "x-api-key": dailyKey.plaintext }, body: BODY });
const d2 = await request(addr.port, "/v1/messages", { headers: { ...CC, "x-api-key": dailyKey.plaintext }, body: BODY });
const d3 = await request(addr.port, "/v1/messages", { headers: { ...CC, "x-api-key": dailyKey.plaintext }, body: BODY });
eq("每日额度内第 1 次", d1.status, 200);
eq("每日额度内第 2 次", d2.status, 200);
eq("超出每日额度 429", d3.status, 429);
gw.quota.flush();
const usage = gw.keys.usage(dailyKey.record.id, new Date().toISOString().slice(0, 10));
eq("每日用量已记账", usage.requests, 2);
ok("token 用量已记账", usage.promptTokens + usage.completionTokens > 0, JSON.stringify(usage));

/* ============ G. 面板 API ============ */
console.log("\n=== G. 面板 API ===");
const noAdmin = await getText(addr.port, "/panel/api?action=overview");
eq("面板无令牌 401", noAdmin.status, 401);
const panelPage = await getText(addr.port, "/panel?key=" + ADMIN);
eq("面板页 200", panelPage.status, 200);
ok("面板页含面板标题", panelPage.text.includes("Claude Gateway"), panelPage.text.slice(0, 80));
ok("面板页不含管理员令牌明文", !panelPage.text.includes(ADMIN));

const ov = await getText(addr.port, "/panel/api?action=overview&key=" + ADMIN);
eq("概览 200", ov.status, 200);
const ovd = asRecord(asRecord(ov.json).data);
eq("概览号池总数", asRecord(ovd.pool).total, 2);
ok("概览含统计", typeof asRecord(ovd.stats).totalRequests === "number");

const accList = await getText(addr.port, "/panel/api?action=accounts&key=" + ADMIN);
eq("账号列表 200", accList.status, 200);
const accRows = asRecord(accList.json).data as Array<Record<string, unknown>>;
eq("账号列表长度", accRows.length, 2);
ok("账号视图不回传 access_token", !("accessToken" in (accRows[0] ?? {})), JSON.stringify(accRows[0]).slice(0, 200));
ok("账号视图不回传 apiKey 原文", !("apiKey" in (accRows[0] ?? {})));

const keyList = await getText(addr.port, "/panel/api?action=keys&key=" + ADMIN);
eq("Key 列表 200", keyList.status, 200);
ok("Key 列表长度大于 0", (asRecord(keyList.json).data as unknown[]).length > 0);

const created = await request(addr.port, "/panel/api?action=key.create&key=" + ADMIN, {
  method: "POST",
  body: { name: "panel-made", fingerprintMode: "passthrough", quotaEnabled: true, rateLimitPerMin: 10 }
});
eq("面板创建 Key 200", created.status, 200);
const createdPlain = String(asRecord(asRecord(created.json).data).plaintext ?? "");
ok("面板返回一次性明文", createdPlain.startsWith("sk-gw-"), createdPlain.slice(0, 12));
const createdUsage = await request(addr.port, "/v1/messages", { headers: { "content-type": "application/json", "x-api-key": createdPlain }, body: BODY });
eq("面板造的 Key 能用", createdUsage.status, 200);

const createdKey = asRecord(asRecord(created.json).data).key as Record<string, unknown>;
const createdId = String(createdKey.id ?? "");
const reset = await request(addr.port, "/panel/api?action=key.reset&key=" + ADMIN, {
  method: "POST",
  body: { id: createdId }
});
eq("面板重置 Key 200", reset.status, 200);
const resetPlain = String(asRecord(asRecord(reset.json).data).plaintext ?? "");
ok("返回一次性新明文", resetPlain.startsWith("sk-gw-"), resetPlain.slice(0, 12));
ok("新明文与旧的不同", resetPlain !== createdPlain);
const oldGone = await request(addr.port, "/v1/messages", { headers: { "content-type": "application/json", "x-api-key": createdPlain }, body: BODY });
eq("旧明文立刻失效", oldGone.status, 401);
const newWorks = await request(addr.port, "/v1/messages", { headers: { "content-type": "application/json", "x-api-key": resetPlain }, body: BODY });
eq("新明文能用", newWorks.status, 200);
const missing = await request(addr.port, "/panel/api?action=key.reset&key=" + ADMIN, { method: "POST", body: { id: "key_nope" } });
eq("不存在的 Key 返回 404", missing.status, 404);

const saved = await request(addr.port, "/panel/api?action=settings.save&key=" + ADMIN, {
  method: "POST",
  body: { stegoMode: "log", guardMode: "lenient", reqIdInResponse: "always" }
});
eq("保存设置 200", saved.status, 200);
eq("设置热生效 stegoMode", gw.cfg.stegoMode, "log");
eq("设置热生效 guardMode", gw.cfg.guardMode, "lenient");
eq("设置热生效 reqIdInResponse", gw.cfg.reqIdInResponse, "always");
await request(addr.port, "/panel/api?action=settings.save&key=" + ADMIN, {
  method: "POST",
  body: { stegoMode: "block", guardMode: "strict", reqIdInResponse: "error" }
});
eq("设置可还原", gw.cfg.stegoMode, "block");

/* ============ H. 请求日志与运行日志 ============ */
console.log("\n=== H. 日志 ===");
await sleep(120);
const reqLogs = await getText(addr.port, "/panel/api?action=logs.requests&limit=200&key=" + ADMIN);
eq("请求日志 200", reqLogs.status, 200);
const reqRows = asRecord(reqLogs.json).rows as Array<Record<string, unknown>>;
ok("请求日志有记录", reqRows.length > 0, String(reqRows.length));
ok("记录了被拦截的请求", reqRows.some((r) => r.outcome === "blocked"), JSON.stringify(reqRows.map((r) => r.outcome)));
ok("记录了账号归属", reqRows.some((r) => !!r.accountLabel));
ok("记录了 API Key 名", reqRows.some((r) => !!r.apiKeyName));
ok("记录了耗时", reqRows.some((r) => typeof r.durationMs === "number"));
ok("记录了 token 用量", reqRows.some((r) => Number(r.promptTokens) + Number(r.completionTokens) > 0));

const blockedOnly = await getText(addr.port, "/panel/api?action=logs.requests&outcome=blocked&key=" + ADMIN);
const blockedRows = asRecord(blockedOnly.json).rows as Array<Record<string, unknown>>;
ok("按被拦截过滤有效", blockedRows.length > 0 && blockedRows.every((r) => r.outcome === "blocked"), String(blockedRows.length));
ok("被拦截项带原因", blockedRows.some((r) => !!r.blockReason));

const stegoBlocked = await request(addr.port, "/v1/messages", {
  headers: { ...CC, "x-api-key": mkPass.plaintext },
  body: { model: "claude-sonnet-4-5-20250929", max_tokens: 8, system: "Today\u2019s date is 2026-06-30.", messages: [{ role: "user", content: "hi" }] }
});
ok("隐写请求被拦截", stegoBlocked.status === 400, String(stegoBlocked.status));
await sleep(120);
const stegoLogs = await getText(addr.port, "/panel/api?action=logs.requests&outcome=blocked&search=stego_marker_detected&key=" + ADMIN);
const stegoRows = asRecord(stegoLogs.json).rows as Array<Record<string, unknown>>;
ok("隐写拦截进日志且带原因码", stegoRows.some((r) => r.blockReason === "stego_marker_detected"), JSON.stringify(stegoRows.slice(0, 2)));

const rtLogs = await getText(addr.port, "/panel/api?action=logs.runtime&limit=50&key=" + ADMIN);
eq("运行日志 200", rtLogs.status, 200);
ok("运行日志有记录", (asRecord(rtLogs.json).rows as unknown[]).length > 0);

const prune = await request(addr.port, "/panel/api?action=logs.prune&key=" + ADMIN, { method: "POST", body: { days: 1, maxRows: 100 } });
eq("日志清理 200", prune.status, 200);

/* ============ I. 故障转移 ============ */
console.log("\n=== I. 故障转移 ===");
const gw3 = createGateway({
  PORT: "0",
  HOST: "127.0.0.1",
  DATA_DIR: newDir("failover"),
  SECRET: "failover-secret",
  UPSTREAM_BASE: "http://127.0.0.1:" + flakyPort,
  GUARD_MODE: "strict",
  LOG_LEVEL: "error"
});
const addr3 = await gw3.listen(0, "127.0.0.1");
cleanup.push(() => gw3.close());
const f1 = gw3.accounts.create({ label: "坏号", kind: "apikey", apiKey: "sk-ant-bad" });
const f2 = gw3.accounts.create({ label: "好号", kind: "apikey", apiKey: "sk-ant-good" });
eq("故障转移场景两个号", gw3.accounts.list().length, 2);

const failKey = gw3.keys.create({ name: "failover", fingerprintMode: "passthrough" });
flaky.setStatus(429);
const failed = await request(addr3.port, "/v1/messages", { headers: { ...CC, "x-api-key": failKey.plaintext }, body: BODY });
ok("上游 429 原样回给客户端", failed.status === 429, String(failed.status));
await sleep(80);
const hitAccount = gw3.accounts.list().find((a: Account) => a.errorCount > 0);
ok("失败的号被记账", !!hitAccount, JSON.stringify(gw3.accounts.list().map((a) => ({ l: a.label, e: a.errorCount }))));
ok("失败的号进入冷却", !!hitAccount && !!hitAccount.cooldownUntil);
eq("坏号被选中并失败", hitAccount?.id, f1.id);
flaky.setStatus(200);
const afterFail = await request(addr3.port, "/v1/messages", { headers: { ...CC, "x-api-key": failKey.plaintext }, body: BODY });
eq("自动切到健康号后成功", afterFail.status, 200);
eq("确实换了号", flaky.hits.length >= 2 && flaky.hits[0] !== flaky.hits[1], true);
gw3.accounts.remove(f1.id);
gw3.accounts.remove(f2.id);

/* ============ 收尾 ============ */
for (const fn of cleanup) {
  try {
    await fn();
  } catch {
    /* 忽略 */
  }
}
for (const d of dataDirs) {
  try {
    cleanupDir(d);
  } catch {
    /* 忽略 */
  }
}

clearTimeout(watchdog);
console.log("\n================================");
console.log("  PASS " + pass + "   FAIL " + fail);
if (fail) {
  console.log("  失败项：");
  for (const f of failures) console.log("   - " + f);
}
console.log("================================\n");
process.exit(fail ? 1 : 0);
