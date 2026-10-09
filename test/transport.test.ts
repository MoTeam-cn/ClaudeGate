#!/usr/bin/env node
/**
 * 上游通道测试。
 * 两条通道的行为差异是刻意的，这里把差异钉住，别让它悄悄变。
 * 运行：node test/transport.test.ts
 */
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createGateway } from "../src/server.ts";
import { isBun, fetchTransportUsable } from "../src/net/fetch.ts";
import { signGatewayToken } from "../src/tokens.ts";
import { request } from "./helpers/client.ts";
import { cleanupDir } from "./helpers/tmp.ts";
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

console.log("\n=== A. 运行时判定 ===");
eq("isBun 与 fetchTransportUsable 一致", isBun(), fetchTransportUsable());
console.log("  （当前运行时：" + (isBun() ? "Bun" : "Node") + "）");

/* 上游 mock：记下收到的头序，返回一个最小可用响应 */
const seen: Array<{ rawHeaders: string[]; body: string }> = [];
const upstream = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (c: Buffer) => chunks.push(c));
  req.on("end", () => {
    seen.push({ rawHeaders: req.rawHeaders, body: Buffer.concat(chunks).toString("utf8") });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      id: "msg_1", type: "message", role: "assistant", model: "x",
      content: [{ type: "text", text: "pong" }],
      stop_reason: "end_turn", stop_sequence: null,
      usage: { input_tokens: 3, output_tokens: 1 }
    }));
  });
});
await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
const upstreamPort = (upstream.address() as AddressInfo).port;

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cg-tp-"));
const env: Record<string, string> = {
  DATA_DIR: dataDir, SECRET: "s".repeat(32), ADMIN_TOKEN: "admin",
  UPSTREAM_BASE: "http://127.0.0.1:" + upstreamPort, GUARD_MODE: "strict",
  /* 两个网关实例要各自拿随机端口，不然第二个会撞 8080 */
  PORT: "0",
  LOG_LEVEL: "error"
};
const gw = createGateway(env);
const addr = await gw.listen();
const port = (addr as AddressInfo).port;
const gwToken = signGatewayToken(gw.cfg, "default");
gw.accounts.create({ label: "a", kind: "oauth", accessToken: "oauth-access" });

const CLIENT_HEADERS = {
  "user-agent": "claude-cli/2.1.293 (external, sdk-cli)",
  "x-app": "cli",
  "x-claude-code-session-id": "11111111-2222-3333-4444-555555555555",
  "anthropic-version": "2023-06-01"
};
const BODY = { model: "claude-opus-4-5-20251101", max_tokens: 8, messages: [{ role: "user", content: "hi" }] };

async function call(label: string, p: number, token: string): Promise<{ status: number; text: string }> {
  const r = await request(p, "/v1/messages", {
    method: "POST",
    headers: { authorization: "Bearer " + token, "content-type": "application/json", ...CLIENT_HEADERS },
    body: BODY
  });
  console.log("    " + label + " -> " + r.status);
  return { status: r.status, text: r.text };
}

console.log("\n=== B. 默认通道（auto -> https）===");
{
  const r = await call("auto", port, gwToken);
  eq("状态 200", r.status, 200);
  ok("响应体原样透传", r.text.includes("pong"), r.text.slice(0, 80));
  const last = seen[seen.length - 1];
  const order = last.rawHeaders.filter((_, i) => i % 2 === 0).map((x) => x.toLowerCase());
  /* 客户端这边第一个发出去的就是 authorization，https 通道必须原样保持这个位置 */
  eq("默认通道保持客户端头序", order[0], "authorization");
  ok("凭据被换成号的令牌", last.rawHeaders.some((v) => v === "Bearer oauth-access"));
}

console.log("\n=== C. fetch 通道 ===");
{
  if (!fetchTransportUsable()) {
    console.log("  （非 Bun，fetch 通道不可用，跳过 —— 这正是预期的：Node 的 fetch 是 undici，TLS 还是 OpenSSL，换了没意义）");
    ok("Node 上 fetch 通道被判定为不可用", !fetchTransportUsable());
  } else {
    const gw2env = { ...env, TRANSPORT: "fetch" };
    const gw2 = createGateway(gw2env);
    const addr2 = await gw2.listen();
    const port2 = (addr2 as AddressInfo).port;
    gw2.accounts.create({ label: "a2", kind: "oauth", accessToken: "oauth-access" });
    const token2 = signGatewayToken(gw2.cfg, "default");
    const r2 = await call("fetch", port2, token2);
    eq("状态 200", r2.status, 200);
    ok("响应体原样透传", r2.text.includes("pong"), r2.text.slice(0, 80));
    const last = seen[seen.length - 1];
    const order = last.rawHeaders.filter((_, i) => i % 2 === 0).map((x) => x.toLowerCase());
    /* 这条断言是刻意的：fetch 会按字母序重排，这正是它换来的代价。
       头序不再是客户端发的那个顺序 —— 买到的 TLS 指纹一致就是拿这个换的 */
    const clientOrder = ["authorization", "content-type", "user-agent", "x-app", "x-claude-code-session-id", "anthropic-version"];
    console.log("    fetch 通道实际头序: " + order.join(","));
    ok("fetch 通道下头序被重排（已知代价）", order.join(",") !== clientOrder.join(","), order.join(","));
    ok("前几个头仍然保持客户端顺序", order.slice(0, 3).join(",") === "authorization,content-type,user-agent", order.slice(0, 3).join(","));
    ok("凭据仍然被换掉", last.rawHeaders.some((v) => v === "Bearer oauth-access"));
    await gw2.close();
  }
}

clearTimeout(watchdog);
upstream.close();
await gw.close();
cleanupDir(dataDir);

console.log("\n========================================");
console.log("  PASS " + pass + "   FAIL " + fail);
if (failures.length > 0) {
  console.log("  失败项：");
  for (const f of failures) console.log("   - " + f);
}
console.log("========================================");
process.exit(fail === 0 ? 0 : 1);
