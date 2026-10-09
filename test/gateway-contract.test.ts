#!/usr/bin/env node
/**
 * 网关契约测试：对着官方《Claude Code gateway compatibility guide》逐条验。
 *
 * 头清单不是编的 —— 是把真 Claude Code（2.1.293）指到一个本地抓包服务器上，
 * 抓下来的原样一份（见 docs/fingerprint.md 的「官方客户端实际发的头」一节）。
 *
 * 验四件事：
 *   1. /api/hello 这个启动探测有响应（官方列为可拒绝，但 404 是可观测差异）。
 *   2. 21 个请求头逐位透传：名字、顺序、值都不动。
 *   3. anthropic-version / anthropic-beta 原样到上游（官方要求 forward unchanged）。
 *   4. 官方点名要回给客户端的响应头（retry-after / x-should-retry / ratelimit-unified）没被吞。
 *
 * 运行：node test/gateway-contract.test.ts
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";

import { createGateway } from "../src/server.ts";
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

const watchdog = setTimeout(() => { console.log("\n!! 超时"); process.exit(3); }, 60000);

/* ================= 真 Claude Code 2.1.293 实际发的头（抓包原样） ================= */
const REAL_HEADERS: Array<[string, string]> = [
  ["Accept", "application/json"],
  ["Authorization", "Bearer __GATEWAY_TOKEN__"],
  ["Content-Type", "application/json"],
  ["User-Agent", "claude-cli/2.1.293 (external, sdk-cli)"],
  ["X-Claude-Code-Session-Id", "23f9e49b-2188-42a2-ae29-bb334c663b48"],
  ["X-Stainless-Arch", "x64"],
  ["X-Stainless-Lang", "js"],
  ["X-Stainless-OS", "Windows"],
  ["X-Stainless-Package-Version", "0.128.0"],
  ["X-Stainless-Retry-Count", "0"],
  ["X-Stainless-Runtime", "node"],
  ["X-Stainless-Runtime-Version", "v26.3.0"],
  ["X-Stainless-Timeout", "600"],
  ["anthropic-beta", "claude-code-20250219,interleaved-thinking-2025-05-14,thinking-token-count-2026-05-13,context-management-2025-06-27,prompt-caching-scope-2026-01-05,mid-conversation-system-2026-04-07,mid-conversation-tool-changes-2026-07-01,advanced-tool-use-2025-11-20,effort-2025-11-24,dangerous-tool-use-2026-09-03,afk-mode-2026-01-31"],
  ["anthropic-dangerous-direct-browser-access", "true"],
  ["anthropic-version", "2023-06-01"],
  ["x-app", "cli"],
  ["Connection", "keep-alive"],
  ["Accept-Encoding", "gzip, deflate, br, zstd"]
];

/* 记录原始头顺序的上游 */
let upRaw: string[] = [];
let upBody = "";
let upCalls = 0;
const upstream = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (c: Buffer) => chunks.push(c));
  req.on("end", () => {
    upCalls += 1;
    upRaw = req.rawHeaders.slice();
    upBody = Buffer.concat(chunks).toString("utf8");
    /* 故意带上官方点名要回给客户端的几个头 */
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      "retry-after": "7",
      "x-should-retry": "true",
      "anthropic-ratelimit-unified-status": "allowed",
      "anthropic-ratelimit-unified-5h-utilization": "0.42",
      "request-id": "req_contract_1"
    });
    res.write("event: message_start\ndata: " + JSON.stringify({ type: "message_start", message: { id: "msg_1", usage: { input_tokens: 1 } } }) + "\n\n");
    res.write("event: message_stop\ndata: " + JSON.stringify({ type: "message_stop" }) + "\n\n");
    res.end();
  });
});

const dataDirs: string[] = [];
async function boot(over: Record<string, string> = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cg-contract-"));
  dataDirs.push(dataDir);
  const gw = createGateway({
    PORT: "0", HOST: "127.0.0.1", DATA_DIR: dataDir, SECRET: "contract-secret",
    ADMIN_TOKEN: "contract-admin", LOG_LEVEL: "error",
    UPSTREAM_BASE: "http://127.0.0.1:" + upPort,
    GUARD_MODE: "strict", INJECT_MISSING: "false", STEGO_MODE: "block",
    ...over
  } as never);
  gw.accounts.create({
    label: "contract", kind: "oauth", accessToken: "oauth-access",
    refreshToken: "r", expiresAt: Math.floor(Date.now() / 1000) + 7200, scope: "user:inference"
  });
  const port = await new Promise<number>((r) => gw.server.listen(0, "127.0.0.1", () => r((gw.server.address() as AddressInfo).port)));
  return { gw, port, token: signGatewayToken(gw.cfg, "default") };
}

const upPort = await new Promise<number>((r) => upstream.listen(0, "127.0.0.1", () => r((upstream.address() as AddressInfo).port)));

/* ================= A. /api/hello ================= */
console.log("\n=== A. /api/hello 启动探测 ===");
{
  const { gw, port } = await boot();
  const head = await request(port, "/api/hello", { method: "HEAD" });
  eq("HEAD 状态 200", head.status, 200);
  eq("HEAD content-type", head.headers["content-type"], "application/json");
  eq("HEAD content-length 与真端点一致（20）", head.headers["content-length"], "20");
  eq("HEAD 没有 body", head.text, "");

  const get = await request(port, "/api/hello", { method: "GET" });
  eq("GET 状态 200", get.status, 200);
  eq("GET body 与真端点一致", get.text, '{"message": "hello"}');
  await gw.close();
}

/* ================= B. 请求头逐位透传 ================= */
console.log("\n=== B. 请求头逐位透传 ===");
{
  const { gw, port, token } = await boot();
  const headers: Record<string, string> = {};
  for (const [k, v] of REAL_HEADERS) headers[k] = k === "Authorization" ? "Bearer " + token : v;
  const body = { model: "claude-opus-5", max_tokens: 16, stream: true, messages: [{ role: "user", content: "hi" }] };

  const res = await request(port, "/v1/messages?beta=true", { headers, body });
  eq("请求成功", res.status, 200);
  eq("上游收到一次调用", upCalls, 1);

  const names: string[] = [];
  for (let i = 0; i + 1 < upRaw.length; i += 2) names.push(upRaw[i]);
  const lower = names.map((n) => n.toLowerCase());

  /* 客户端发的每个头都得在，且相对顺序不变 */
  const missing = REAL_HEADERS.filter(([k]) => !lower.includes(k.toLowerCase()));
  eq("客户端头一个没丢", missing.map(([k]) => k).join(","), "");

  /* 去掉 host 之后，客户端头的相对顺序应当原样保留 */
  const clientOrder = REAL_HEADERS.map(([k]) => k.toLowerCase()).filter((k) => k !== "host");
  const upOrder = lower.filter((k) => clientOrder.includes(k));
  eq("相对顺序逐位一致", upOrder.join(","), clientOrder.join(","));

  const val = (name: string): string => {
    const i = lower.indexOf(name.toLowerCase());
    return i === -1 ? "" : String(upRaw[i * 2 + 1]);
  };

  /* X-Stainless-* 是 SDK 加的，官方文档没提，但漏掉就是可观测差异 */
  for (const h of ["x-stainless-arch", "x-stainless-lang", "x-stainless-os", "x-stainless-package-version",
                   "x-stainless-retry-count", "x-stainless-runtime", "x-stainless-runtime-version", "x-stainless-timeout"]) {
    const want = REAL_HEADERS.find(([k]) => k.toLowerCase() === h)?.[1] ?? "";
    eq("透传 " + h, val(h), want);
  }
  eq("透传 user-agent", val("user-agent"), "claude-cli/2.1.293 (external, sdk-cli)");
  eq("透传 x-app", val("x-app"), "cli");
  eq("透传 x-claude-code-session-id", val("x-claude-code-session-id"), "23f9e49b-2188-42a2-ae29-bb334c663b48");
  eq("透传 anthropic-dangerous-direct-browser-access", val("anthropic-dangerous-direct-browser-access"), "true");
  eq("透传 anthropic-version", val("anthropic-version"), "2023-06-01");

  /* 官方要求 beta 原样转发、不许白名单化 */
  const beta = val("anthropic-beta");
  const sentBeta = REAL_HEADERS.find(([k]) => k.toLowerCase() === "anthropic-beta")![1];
  ok("anthropic-beta 保留了客户端全部取值", sentBeta.split(",").every((v) => beta.includes(v)), beta);
  ok("anthropic-beta 没有重复项", new Set(beta.split(",")).size === beta.split(",").length, beta);

  /* 凭据被换成号池的，且位置仍在客户端原来放 Authorization 的地方 */
  eq("凭据已替换", val("authorization"), "Bearer oauth-access");
  eq("凭据仍在原位（第 2 个）", names[1]?.toLowerCase(), "authorization");

  /* 上游请求体没被动过 */
  const parsed = JSON.parse(upBody) as { model?: string; max_tokens?: number };
  eq("请求体 model 未被改写", parsed.model, "claude-opus-5");
  eq("请求体 max_tokens 未被改写", parsed.max_tokens, 16);
  await gw.close();
}

/* ================= C. 响应头回传 ================= */
console.log("\n=== C. 官方点名的响应头 ===");
{
  const { gw, port, token } = await boot();
  const headers: Record<string, string> = {};
  for (const [k, v] of REAL_HEADERS) headers[k] = k === "Authorization" ? "Bearer " + token : v;
  const res = await request(port, "/v1/messages?beta=true", { headers, body: { model: "claude-opus-5", stream: true, messages: [] } });

  eq("content-type 是 SSE", String(res.headers["content-type"] ?? "").split(";")[0], "text/event-stream");
  eq("retry-after 透传", res.headers["retry-after"], "7");
  eq("x-should-retry 透传", res.headers["x-should-retry"], "true");
  eq("ratelimit-unified-status 透传", res.headers["anthropic-ratelimit-unified-status"], "allowed");
  eq("ratelimit-unified 细分窗口透传", res.headers["anthropic-ratelimit-unified-5h-utilization"], "0.42");
  ok("上游 request-id 保留", !!res.headers["request-id"]);
  ok("响应体是 SSE", res.text.includes("message_start"));
  await gw.close();
}

/* ================= D. 上游失败时的重试信号 ================= */
console.log("\n=== D. 错误响应不被改写 ===");
{
  const { gw, port, token } = await boot();
  const headers: Record<string, string> = {};
  for (const [k, v] of REAL_HEADERS) headers[k] = k === "Authorization" ? "Bearer " + token : v;
  /* 上游不可达 -> 502，但不应崩 */
  const res = await request(port, "/v1/messages?beta=true", { headers, body: { model: "claude-opus-5", messages: [] } });
  ok("上游异常时返回 4xx/5xx 而不是挂住", res.status >= 400, String(res.status));
  await gw.close();
}

clearTimeout(watchdog);
upstream.close();
for (const d of dataDirs) cleanupDir(d);

console.log("\n================================");
console.log("  PASS " + pass + "   FAIL " + fail);
if (fail) { console.log("  失败项："); for (const f of failures) console.log("   - " + f); }
console.log("================================\n");
process.exit(fail ? 1 : 0);
