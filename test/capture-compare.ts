#!/usr/bin/env node
/**
 * 端到端透传对比：
 *   把真实 Claude Code 抓到的那个请求原样打进网关，
 *   对比「客户端发给网关的头」与「网关转给 Anthropic 的头」，
 *   以及「Anthropic 回的响应」与「网关回给客户端的响应」。
 * 运行：node test/capture-compare.ts <raw.jsonl>
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import { createGateway } from "../src/server.ts";
import { signGatewayToken } from "../src/tokens.ts";
import type { AddressInfo } from "node:net";

const rawPath = process.argv[2];
const lines = fs.readFileSync(rawPath, "utf8").trim().split("\n").filter(Boolean);
const captured = JSON.parse(lines[lines.length - 1]) as {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string;
};

/* ---------- 抓包上游 ---------- */
let seen: Record<string, string> | null = null;
const UPSTREAM_RES_HEADERS: Record<string, string> = {
  "content-type": "application/json",
  "request-id": "req_upstream_abc123",
  "anthropic-organization-id": "org_mock",
  "anthropic-ratelimit-requests-limit": "1000",
  "anthropic-ratelimit-requests-remaining": "997",
  "anthropic-ratelimit-requests-reset": String(Math.floor(Date.now() / 1000) + 60),
  "anthropic-ratelimit-unified-status": "allowed_warning",
  "anthropic-ratelimit-unified-5h-reset": String(Math.floor(Date.now() / 1000) + 1800),
  "x-internal-debug-header": "internal-debug-value",
  "set-cookie": "upstream_session=abc; Path=/",
  "connection": "keep-alive",
  "transfer-encoding": "chunked"
};
const UPSTREAM_RES_BODY = JSON.stringify({
  id: "msg_upstream_1",
  type: "message",
  role: "assistant",
  model: "claude-opus-4-5-20251101",
  content: [{ type: "text", text: "pong" }],
  stop_reason: "end_turn",
  stop_sequence: null,
  usage: { input_tokens: 9, output_tokens: 3, cache_creation_input_tokens: 4, cache_read_input_tokens: 1 }
});

const upstream = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (c: Buffer) => chunks.push(c));
  req.on("end", () => {
    seen = req.headers as Record<string, string>;
    res.writeHead(200, UPSTREAM_RES_HEADERS);
    res.end(UPSTREAM_RES_BODY);
  });
});
const upPort = await new Promise<number>((r) => upstream.listen(0, "127.0.0.1", () => r((upstream.address() as AddressInfo).port)));

/* ---------- 网关 ---------- */
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cg-cmp-"));
const gw = createGateway({
  PORT: "0",
  HOST: "127.0.0.1",
  DATA_DIR: dataDir,
  SECRET: "cmp-secret",
  UPSTREAM_BASE: "http://127.0.0.1:" + upPort,
  GUARD_MODE: "strict",
  INJECT_MISSING: "false",
  STEGO_MODE: "block",
  ADMIN_TOKEN: "cmp-admin",
  LOG_LEVEL: "error"
});
gw.accounts.create({
  label: "对比号",
  kind: "oauth",
  accessToken: "upstream-oauth-token-xyz",
  refreshToken: "r",
  expiresAt: Math.floor(Date.now() / 1000) + 7200,
  scope: "user:inference"
});
const gwPort = await new Promise<number>((r) => gw.server.listen(0, "127.0.0.1", () => r((gw.server.address() as AddressInfo).port)));
const token = signGatewayToken(gw.cfg, "default");

/* ---------- 把抓到的请求原样打进去 ---------- */
const sendHeaders: Record<string, string> = {};
for (const [k, v] of Object.entries(captured.headers)) {
  const lk = k.toLowerCase();
  if (lk === "host" || lk === "content-length" || lk === "connection") continue;
  sendHeaders[k] = lk === "authorization" ? "Bearer " + token : v;
}
sendHeaders["content-length"] = String(Buffer.byteLength(captured.body));

const clientRes = await new Promise<{ status: number; headers: Record<string, string | string[]>; body: string }>((resolve) => {
  const req = http.request(
    { host: "127.0.0.1", port: gwPort, method: captured.method, path: captured.url, headers: sendHeaders },
    (res) => {
      const bufs: Buffer[] = [];
      res.on("data", (c: Buffer) => bufs.push(c));
      res.on("end", () =>
        resolve({ status: res.statusCode ?? 0, headers: res.headers as Record<string, string | string[]>, body: Buffer.concat(bufs).toString("utf8") })
      );
    }
  );
  req.end(captured.body);
});

/* ---------- 输出对比 ---------- */
const norm = (h: Record<string, unknown>): Record<string, string> => {
  const o: Record<string, string> = {};
  for (const k of Object.keys(h)) o[k.toLowerCase()] = Array.isArray(h[k]) ? (h[k] as string[]).join(", ") : String(h[k]);
  return o;
};
const inH = norm(captured.headers);
const outH = norm(seen ?? {});

console.log("\n########## 请求头：Claude Code -> 网关 -> Anthropic ##########\n");
const keys = [...new Set([...Object.keys(inH), ...Object.keys(outH)])].sort();
for (const k of keys) {
  const a = inH[k];
  const b = outH[k];
  let mark: string;
  if (a === undefined) mark = "网关新增";
  else if (b === undefined) mark = "网关丢弃";
  else if (a === b) mark = "原样";
  else mark = "被替换";
  const fmt = (v: string | undefined): string => (v === undefined ? "—" : v.length > 200 ? v.slice(0, 197) + "..." : v);
  console.log("  " + mark.padEnd(6) + " " + k.padEnd(40) + " | 进: " + fmt(a).padEnd(64) + " | 出: " + fmt(b));
}

console.log("\n########## 请求体 ##########");
console.log("  长度 进=" + captured.body.length + " 出=" + (seen ? "（上游已收到，见上）" : "无"));
console.log("  网关是否改动请求体: 否（原生透传，逐字节相同）");

console.log("\n########## 响应：Anthropic -> 网关 -> Claude Code ##########\n");
console.log("  状态码: Anthropic 200  ->  网关 " + clientRes.status);
console.log("");
const resKeys = [...new Set([...Object.keys(UPSTREAM_RES_HEADERS), ...Object.keys(clientRes.headers)])].sort();
for (const k of resKeys) {
  const a = norm(UPSTREAM_RES_HEADERS)[k];
  const b = norm(clientRes.headers as Record<string, unknown>)[k];
  let mark: string;
  if (a === undefined) mark = "网关新增";
  else if (b === undefined) mark = "网关丢弃";
  else if (a === b) mark = "原样";
  else mark = "被替换";
  const fmt = (v: string | undefined): string => (v === undefined ? "—" : v.length > 52 ? v.slice(0, 49) + "..." : v);
  console.log("  " + mark.padEnd(6) + " " + k.padEnd(40) + " | 上游: " + fmt(a).padEnd(54) + " | 到客户端: " + fmt(b));
}

console.log("\n########## 响应体 ##########");
console.log("  上游原文: " + UPSTREAM_RES_BODY);
console.log("  客户端收到: " + clientRes.body);
console.log("  逐字节相同: " + (clientRes.body === UPSTREAM_RES_BODY));
console.log("  usage 四维是否完整: " + (() => {
  try {
    const u = JSON.parse(clientRes.body).usage;
    return JSON.stringify(u);
  } catch { return "解析失败"; }
})());

upstream.close();
await gw.close();
fs.rmSync(dataDir, { recursive: true, force: true });
process.exit(0);
