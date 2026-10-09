#!/usr/bin/env node
/**
 * 上游请求头保真度测试：Claude Code 发什么，网关就得转什么。
 * 运行：node test/headers.test.ts
 */
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createGateway } from "../src/server.ts";
import { mergeBeta } from "../src/oauth.ts";
import { signGatewayToken } from "../src/tokens.ts";
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

const watchdog = setTimeout(() => { console.log("\n!! 超时"); process.exit(3); }, 45000);

/* ---- A. mergeBeta 单元 ---- */
console.log("\n=== A. beta 并集 ===");
eq("空值只留新增", mergeBeta(undefined, "oauth-2025-04-20"), "oauth-2025-04-20");
eq("保留客户端顺序，新增接在后面",
  mergeBeta("claude-code-20250219,interleaved-thinking-2025-05-14", "oauth-2025-04-20"),
  "claude-code-20250219,interleaved-thinking-2025-05-14,oauth-2025-04-20");
eq("重复不叠加",
  mergeBeta("claude-code-20250219,oauth-2025-04-20", "oauth-2025-04-20"),
  "claude-code-20250219,oauth-2025-04-20");
eq("多余空格被清掉",
  mergeBeta(" a , b ", "c"), "a,b,c");
eq("数组形式也支持",
  mergeBeta(["a", "b"], "c"), "a,b,c");

/* ---- 端到端 ---- */
const seen: Array<{ url: string; headers: Record<string, string>; rawHeaders: string[] }> = [];
const upstream = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (c: Buffer) => chunks.push(c));
  req.on("end", () => {
    seen.push({ url: req.url ?? "/", headers: req.headers as Record<string, string>, rawHeaders: req.rawHeaders });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      id: "m", type: "message", role: "assistant", model: "x",
      content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 }
    }));
  });
});
const upPort = await new Promise<number>((r) => upstream.listen(0, "127.0.0.1", () => r((upstream.address() as AddressInfo).port)));

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cg-hdr-"));
const gw = createGateway({
  PORT: "0", HOST: "127.0.0.1", DATA_DIR: dataDir, SECRET: "hdr-secret",
  UPSTREAM_BASE: "http://127.0.0.1:" + upPort,
  GUARD_MODE: "strict", INJECT_MISSING: "false", STEGO_MODE: "block",
  ADMIN_TOKEN: "hdr-admin", LOG_LEVEL: "error"
});
gw.accounts.create({
  label: "h", kind: "oauth", accessToken: "oauth-access",
  refreshToken: "r", expiresAt: Math.floor(Date.now() / 1000) + 7200, scope: "user:inference"
});
const port = await new Promise<number>((r) => gw.server.listen(0, "127.0.0.1", () => r((gw.server.address() as AddressInfo).port)));
const gwToken = signGatewayToken(gw.cfg, "default");

const BODY = { model: "claude-opus-4-5-20251101", max_tokens: 16, stream: true, messages: [{ role: "user", content: "hi" }] };

console.log("\n=== B. Claude Code 的 beta 必须被保留 ===");
const ccBetas = "claude-code-20250219,interleaved-thinking-2025-05-14,tool-search-tool-2025-10-19";
await request(port, "/v1/messages?beta=true", {
  headers: {
    "content-type": "application/json",
    authorization: "Bearer " + gwToken,
    "user-agent": "claude-cli/2.1.293 (external, sdk-cli)",
    "x-app": "cli",
    "anthropic-version": "2023-06-01",
    "anthropic-beta": ccBetas,
    "x-claude-code-session-id": "11111111-2222-3333-4444-555555555555",
    accept: "application/json"
  },
  body: BODY
}).catch(() => undefined);
await sleep(250);

const last = seen[seen.length - 1];
const gotBeta = String(last?.headers["anthropic-beta"] ?? "");
ok("三个 Claude Code 标志一个不少",
  gotBeta.includes("claude-code-20250219") && gotBeta.includes("interleaved-thinking-2025-05-14") && gotBeta.includes("tool-search-tool-2025-10-19"),
  gotBeta);
ok("补上了 oauth 标志", gotBeta.includes("oauth-2025-04-20"), gotBeta);
eq("客户端顺序保持在前", gotBeta.split(",").slice(0, 3).join(","), ccBetas);
eq("accept 不被改写", last?.headers["accept"], "application/json");
eq("user-agent 原样", last?.headers["user-agent"], "claude-cli/2.1.293 (external, sdk-cli)");
eq("x-app 原样", last?.headers["x-app"], "cli");
eq("session-id 原样", last?.headers["x-claude-code-session-id"], "11111111-2222-3333-4444-555555555555");
eq("authorization 换成号的令牌", last?.headers["authorization"], "Bearer oauth-access");
eq("查询串保留", last?.url, "/v1/messages?beta=true");

console.log("\n=== C. 第三方客户端也要被补成 Claude Code 样子 ===");
await request(port, "/v1/messages", {
  headers: {
    "content-type": "application/json",
    "x-api-key": "sk-ant-passthrough-not-used",
    "user-agent": "python-requests/2.31",
    accept: "application/json"
  },
  body: { model: "claude-sonnet-4-5-20250929", max_tokens: 16, messages: [{ role: "user", content: "hi" }] }
}).catch(() => undefined);
await sleep(250);

const third = seen[seen.length - 1];
ok("UA 被换成 Claude Code", String(third?.headers["user-agent"]).startsWith("claude-cli/"), third?.headers["user-agent"]);
eq("x-app 补上", third?.headers["x-app"], "cli");
ok("session-id 补上", /^[0-9a-f-]{36}$/.test(String(third?.headers["x-claude-code-session-id"])), third?.headers["x-claude-code-session-id"]);
eq("beta 补上", third?.headers["anthropic-beta"], "claude-code-20250219");

console.log("\n=== D. 请求头顺序必须原样保留 ===");
/* 顺序本身是可观测的指纹。这里按一个刻意安排的顺序发，断言上游收到的顺序一致 */
const ORDER = [
  "accept",
  "authorization",
  "content-type",
  "user-agent",
  "x-claude-code-session-id",
  "x-stainless-arch",
  "anthropic-beta",
  "anthropic-version",
  "x-app",
  "connection",
  "host",
  "accept-encoding",
  "content-length"
];
{
  const body = JSON.stringify({ model: "claude-opus-4-5-20251101", max_tokens: 8, messages: [{ role: "user", content: "hi" }] });
  const ordered: Record<string, string> = {};
  for (const k of ORDER) {
    ordered[k] =
      k === "authorization" ? "Bearer " + gwToken
      : k === "host" ? "127.0.0.1:" + port
      : k === "content-length" ? String(Buffer.byteLength(body))
      : k === "content-type" ? "application/json"
      : k === "anthropic-beta" ? "claude-code-20250219,interleaved-thinking-2025-05-14"
      : k === "anthropic-version" ? "2023-06-01"
      : k === "x-app" ? "cli"
      : k === "connection" ? "keep-alive"
      : k === "accept" ? "application/json"
      : k === "accept-encoding" ? "gzip, deflate, br, zstd"
      : k === "x-claude-code-session-id" ? "11111111-2222-3333-4444-555555555555"
      : "claude-cli/2.1.293 (external, sdk-cli)";
  }
  await new Promise<void>((resolve) => {
    const req = http.request(
      { host: "127.0.0.1", port, method: "POST", path: "/v1/messages", headers: ordered },
      (res) => { res.resume(); res.on("end", () => resolve()); }
    );
    req.on("error", () => resolve());
    req.end(body);
  });
  await sleep(250);

  const last = seen[seen.length - 1];
  const gotOrder = (last?.rawHeaders ?? []).filter((_, i) => i % 2 === 0).map((x) => x.toLowerCase());
  eq("上游收到的头个数一致", gotOrder.length, ORDER.length);
  eq("请求头顺序逐位一致", gotOrder.join(","), ORDER.join(","));
  eq("凭据头仍在第 2 位", gotOrder[1], "authorization");
  eq("凭据已换成号的令牌", last?.headers["authorization"], "Bearer oauth-access");
  ok("没有 transfer-encoding", last?.headers["transfer-encoding"] === undefined, String(last?.headers["transfer-encoding"]));
  eq("content-length 与实际体长一致", last?.headers["content-length"], String(Buffer.byteLength(body)));
}

console.log("\n=== E. 凭据头原地改名（Console 号） ===");
{
  /* 客户端发的是 authorization，但号池里这个号是 Console Key：
     应该原地换成 x-api-key，位置不变 */
  const consoleAcc = gw.accounts.create({ label: "console", kind: "apikey", apiKey: "sk-ant-console-key" });
  const body = JSON.stringify({ model: "claude-sonnet-4-5-20250929", max_tokens: 8, messages: [{ role: "user", content: "hi" }] });
  const ordered: Record<string, string> = {
    accept: "application/json",
    authorization: "Bearer " + gwToken,
    "content-type": "application/json",
    "user-agent": "claude-cli/2.1.293 (external, sdk-cli)",
    "x-app": "cli",
    "x-claude-code-session-id": "11111111-2222-3333-4444-555555555555",
    "anthropic-version": "2023-06-01",
    "content-length": String(Buffer.byteLength(body)),
    host: "127.0.0.1:" + port
  };
  /* 用绑定账号的 Key 强制走 Console 号 */
  const boundKey = gw.keys.create({ name: "bound-console", fingerprintMode: "claude_code", boundAccountId: consoleAcc.id });
  ordered.authorization = "Bearer " + boundKey.plaintext;
  await new Promise<void>((resolve) => {
    const req = http.request(
      { host: "127.0.0.1", port, method: "POST", path: "/v1/messages", headers: ordered },
      (res) => { res.resume(); res.on("end", () => resolve()); }
    );
    req.on("error", () => resolve());
    req.end(body);
  });
  await sleep(250);
  const last = seen[seen.length - 1];
  const gotOrder = (last?.rawHeaders ?? []).filter((_, i) => i % 2 === 0).map((x) => x.toLowerCase());
  eq("凭据头仍是第 2 位", gotOrder[1], "x-api-key");
  eq("换成 Console Key", last?.headers["x-api-key"], "sk-ant-console-key");
  ok("authorization 已被移除", last?.headers["authorization"] === undefined, String(last?.headers["authorization"]));
  /* 客户端这次没发 connection，Node 会自己补在末尾 —— 这是正常的，
     真 Claude Code 每次都发 connection，所以那种情况下它就在原位 */
  const expectOrder = ["accept", "x-api-key", "content-type", "user-agent", "x-app", "x-claude-code-session-id", "anthropic-version", "content-length", "host"];
  eq("其余顺序不受影响", gotOrder.slice(0, expectOrder.length).join(","), expectOrder.join(","));
  eq("未发 connection 时由 Node 补在末尾", gotOrder[expectOrder.length], "connection");
}

clearTimeout(watchdog);
upstream.close();
await gw.close();
fs.rmSync(dataDir, { recursive: true, force: true });

console.log("\n================================");
console.log("  PASS " + pass + "   FAIL " + fail);
if (fail) { console.log("  失败项："); for (const f of failures) console.log("   - " + f); }
console.log("================================\n");
process.exit(fail ? 1 : 0);
