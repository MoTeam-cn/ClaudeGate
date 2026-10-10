#!/usr/bin/env node
/**
 * 请求体身份校验测试。
 *
 * 覆盖：
 *   1. 单元判定：缺 system / 假归因头 / 缺身份行 / 身份行埋在中段
 *   2. 端到端：不带 Claude Code 身份的请求被 403，带了就放行
 *   3. IDENTITY_MODE=off 时不查
 *
 * 运行：node test/identity.test.ts
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import { createGateway } from "../src/server.ts";
import { checkIdentity, IDENTITY_LINES, systemDigest } from "../src/security/identity.ts";
import { BILLING_HEADER_PREFIX } from "../src/fingerprint/attribution.ts";
import { signGatewayToken } from "../src/tokens.ts";
import { cleanupDir } from "./helpers/tmp.ts";
import { request, ccSystem, TEST_BILLING } from "./helpers/client.ts";
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
const watchdog = setTimeout(() => { console.log("\n!! 超时"); process.exit(3); }, 45000);

/* ================= A. 单元判定 ================= */
console.log("\n=== A. 单元判定 ===");
eq("真 Claude Code 的 system 通过", checkIdentity({ system: ccSystem(), messages: [] }).ok, true);
eq("身份行三个变体都认",
  IDENTITY_LINES.every((l) => checkIdentity({ system: [TEST_BILLING, l], messages: [] }).ok), true);
eq("没有 system 被拒", checkIdentity({ messages: [] }).ok, false);
eq("system 是空数组被拒", checkIdentity({ system: [], messages: [] }).ok, false);
eq("system 是普通字符串被拒", checkIdentity({ system: "hello", messages: [] }).ok, false);
eq("system 只有归因头、没身份行被拒", checkIdentity({ system: [TEST_BILLING], messages: [] }).ok, false);
eq("只有身份行、没归因头被拒", checkIdentity({ system: [IDENTITY_LINES[0]] , messages: [] }).ok, false);
eq("空对象被拒", checkIdentity({}).ok, false);
eq("非对象被拒", checkIdentity(null).ok, false);

/* 关键绕过：只有前缀的空壳会把真正的归因头顶掉，必须判失败 */
const FAKE = BILLING_HEADER_PREFIX + " whatever";
eq("只有前缀的空壳归因头被拒", checkIdentity({ system: [FAKE, IDENTITY_LINES[0]], messages: [] }).ok, false);
eq("空壳 + 身份行也不行", checkIdentity({ system: [FAKE, IDENTITY_LINES[0]] , messages: [] }).ok, false);

/* 身份行埋在中段也要认（只要求存在，不要求下标） */
eq("身份行埋在中段也认",
  checkIdentity({ system: [TEST_BILLING, { type: "text", text: "别的东西" }, IDENTITY_LINES[2]], messages: [] }).ok, true);
eq("身份行首尾带空白也认",
  checkIdentity({ system: [TEST_BILLING, "  " + IDENTITY_LINES[1] + "\n"], messages: [] }).ok, true);
/* 线上那次 403 的形状：真客户端把身份行和日期行拼在同一块里 */
eq("身份行与日期行同块也认",
  checkIdentity({ system: [TEST_BILLING, IDENTITY_LINES[0] + "\n\nToday's date is 2026-10-10."], messages: [] }).ok, true);
eq("身份行前面还有别的文字也认",
  checkIdentity({ system: [TEST_BILLING, "前言\n" + IDENTITY_LINES[2]], messages: [] }).ok, true);
eq("日期行在前、身份行在后也认",
  checkIdentity({ system: [TEST_BILLING, "Today's date is 2026-10-10.\n" + IDENTITY_LINES[1]], messages: [] }).ok, true);
eq("摘要里能看到客户端实际发了什么",
  systemDigest(["abc", "def"]).indexOf("#0[3] abc") !== -1, true);
eq("身份行只写一半不认",
  checkIdentity({ system: [TEST_BILLING, "You are Claude Code."], messages: [] }).ok, false);

/* ================= B. 端到端 ================= */
console.log("\n=== B. 端到端 ===");
let upHits = 0;
const upstream = http.createServer((req, res) => {
  upHits += 1;
  req.resume();
  req.on("end", () => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ id: "m", type: "message", role: "assistant", model: "x",
      content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 } }));
  });
});
const upPort = await new Promise<number>((r) => upstream.listen(0, "127.0.0.1", () => r((upstream.address() as AddressInfo).port)));

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cg-id-"));
const gw = createGateway({
  PORT: "0", HOST: "127.0.0.1", DATA_DIR: dataDir, SECRET: "id-secret", CG_ENV_FILE: "",
  UPSTREAM_BASE: "http://127.0.0.1:" + upPort,
  MODEL_VALIDATION: "off", GUARD_MODE: "off", STEGO_MODE: "off",
  LOG_LEVEL: "error", TRANSPORT: "https"
});
gw.accounts.create({ label: "c", kind: "oauth", accessToken: "oauth-access",
  refreshToken: "r", expiresAt: Math.floor(Date.now() / 1000) + 7200, scope: "user:inference" });
const port = await new Promise<number>((r) => gw.server.listen(0, "127.0.0.1", () => r((gw.server.address() as AddressInfo).port)));
const gwToken = signGatewayToken(gw.cfg, "default");
const h = { "content-type": "application/json", authorization: "Bearer " + gwToken };
const MSG = { model: "claude-opus-5-5", max_tokens: 16, messages: [{ role: "user", content: "hi" }] };

const good = await request(port, "/v1/messages", { headers: h, body: MSG });
eq("带身份的请求放行", good.status, 200);

const hitsBefore = upHits;
const bare = await request(port, "/v1/messages", { headers: h, body: MSG, raw: true });
eq("不带 system 的裸请求 403", bare.status, 403);
eq("错误类型是 permission_error",
  ((bare.json as Record<string, unknown>).error as Record<string, unknown> | undefined)?.type, "permission_error");
eq("裸请求没打到上游", upHits, hitsBefore);

const fake = await request(port, "/v1/messages", { headers: h, raw: true,
  body: { ...MSG, system: [{ type: "text", text: FAKE }, { type: "text", text: IDENTITY_LINES[0] }] } });
eq("假归因头 403", fake.status, 403);

const noId = await request(port, "/v1/messages", { headers: h, raw: true,
  body: { ...MSG, system: [TEST_BILLING, { type: "text", text: "你是一个助手" }] } });
eq("有归因头但没身份行 403", noId.status, 403);

/* IDENTITY_MODE=off 时完全不查 */
const lax = createGateway({
  PORT: "0", HOST: "127.0.0.1", DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), "cg-id2-")),
  SECRET: "id2", CG_ENV_FILE: "", UPSTREAM_BASE: "http://127.0.0.1:" + upPort,
  MODEL_VALIDATION: "off", GUARD_MODE: "off", STEGO_MODE: "off", IDENTITY_MODE: "off",
  LOG_LEVEL: "error", TRANSPORT: "https"
});
lax.accounts.create({ label: "c", kind: "oauth", accessToken: "oauth-access",
  refreshToken: "r", expiresAt: Math.floor(Date.now() / 1000) + 7200, scope: "user:inference" });
const laxPort = await new Promise<number>((r) => lax.server.listen(0, "127.0.0.1", () => r((lax.server.address() as AddressInfo).port)));
const laxToken = signGatewayToken(lax.cfg, "default");
const off = await request(laxPort, "/v1/messages",
  { headers: { ...h, authorization: "Bearer " + laxToken }, body: MSG, raw: true });
eq("IDENTITY_MODE=off 时不查", off.status, 200);

clearTimeout(watchdog);
console.log("\n" + (fail === 0 ? "全部通过" : failures.join("\n")));
console.log("PASS " + pass + "   FAIL " + fail);
cleanupDir(dataDir);
process.exit(fail === 0 ? 0 : 1);
