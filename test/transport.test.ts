#!/usr/bin/env node
/**
 * 上游通道测试。
 *
 * auto 的规则是「能拿 JA3 就拿」：Bun 且没配代理走 fetch，否则走 node:https。
 * 这个文件的职责是把每条通道的实际行为钉住，别让它悄悄变。
 *
 * 运行：node test/transport.test.ts 或 bun test/transport.test.ts
 */
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createGateway } from "../src/server.ts";
import { isBun, fetchTransportUsable } from "../src/net/fetch.ts";
import { effectiveTransport } from "../src/upstream.ts";
import { parseProxySpec } from "../src/net/proxy.ts";
import { signGatewayToken } from "../src/tokens.ts";
import { request } from "./helpers/client.ts";
import { cleanupDir } from "./helpers/tmp.ts";
import type { AddressInfo } from "node:net";
import type { Config } from "../src/types.ts";

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
const bun = isBun();
console.log("\n=== A. 通道选择 ===");
console.log("  （当前运行时：" + (bun ? "Bun" : "Node") + "）");
eq("isBun 与 fetchTransportUsable 一致", bun, fetchTransportUsable());

const fakeCfg = (over: Record<string, unknown>): Config => ({ transport: "auto", proxy: null, ...over } as unknown as Config);
eq("auto + 无代理 -> 取能拿 JA3 的那条", effectiveTransport(fakeCfg({})), bun ? "fetch" : "https");
eq("auto + 有代理 -> 退回 https", effectiveTransport(fakeCfg({ proxy: parseProxySpec("http://1.2.3.4:8080") })), "https");
eq("显式 https 不被 auto 覆盖", effectiveTransport(fakeCfg({ transport: "https" })), "https");
eq("显式 fetch 保留", effectiveTransport(fakeCfg({ transport: "fetch", proxy: parseProxySpec("http://1.2.3.4:8080") })), "fetch");

/* 上游 mock：记下收到的头序 */
const seen: Array<{ rawHeaders: string[]; body: string }> = [];
const upstream = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (c: Buffer) => chunks.push(c));
  req.on("end", () => {
    seen.push({ rawHeaders: req.rawHeaders, body: Buffer.concat(chunks).toString("utf8") });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ id: "msg_1", type: "message", role: "assistant", model: "x",
      content: [{ type: "text", text: "pong" }], stop_reason: "end_turn", stop_sequence: null,
      usage: { input_tokens: 3, output_tokens: 1 } }));
  });
});
await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
const upstreamPort = (upstream.address() as AddressInfo).port;

const dataDirs: string[] = [];
function envFor(over: Record<string, string> = {}): Record<string, string> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cg-tp-"));
  dataDirs.push(dataDir);
  return {
    DATA_DIR: dataDir, SECRET: "s".repeat(32), ADMIN_TOKEN: "admin",
    UPSTREAM_BASE: "http://127.0.0.1:" + upstreamPort, GUARD_MODE: "strict",
    PORT: "0", LOG_LEVEL: "error", ...over
  };
}

const CLIENT_HEADERS = {
  "user-agent": "claude-cli/2.1.293 (external, sdk-cli)",
  "x-app": "cli",
  "x-claude-code-session-id": "11111111-2222-3333-4444-555555555555",
  "anthropic-version": "2023-06-01"
};
const BODY = { model: "claude-opus-4-5-20251101", max_tokens: 8, messages: [{ role: "user", content: "hi" }] };
const CLIENT_ORDER = ["authorization", "content-type", "user-agent", "x-app", "x-claude-code-session-id", "anthropic-version"];

async function boot(over: Record<string, string> = {}) {
  const gw = createGateway(envFor(over) as never);
  const addr = await gw.listen();
  const port = (addr as AddressInfo).port;
  gw.accounts.create({ label: "a", kind: "oauth", accessToken: "oauth-access" });
  return { gw, port, token: signGatewayToken(gw.cfg, "default") };
}
async function call(port: number, token: string) {
  return request(port, "/v1/messages", {
    method: "POST",
    headers: { authorization: "Bearer " + token, "content-type": "application/json", ...CLIENT_HEADERS },
    body: BODY
  });
}
function lastOrder(): string[] {
  const last = seen[seen.length - 1];
  return last.rawHeaders.filter((_, i) => i % 2 === 0).map((x) => x.toLowerCase())
    .filter((n) => CLIENT_ORDER.includes(n));
}

console.log("\n=== B. 显式 https：头序逐位保持 ===");
{
  const { gw, port, token } = await boot({ TRANSPORT: "https" });
  const r = await call(port, token);
  eq("状态 200", r.status, 200);
  ok("响应体原样透传", r.text.includes("pong"), r.text.slice(0, 80));
  eq("客户端头序逐位一致", lastOrder().join(","), CLIENT_ORDER.join(","));
  ok("凭据被换成号的令牌", seen[seen.length - 1].rawHeaders.some((v) => v === "Bearer oauth-access"));
  await gw.close();
}

console.log("\n=== C. fetch：JA3 换头序 ===");
{
  if (!fetchTransportUsable()) {
    console.log("  （非 Bun，fetch 通道不可用 —— 这正是预期的：Node 的 fetch 是 undici，TLS 还是 OpenSSL）");
    ok("Node 上 fetch 通道被判定为不可用", !fetchTransportUsable());
  } else {
    const { gw, port, token } = await boot({ TRANSPORT: "fetch" });
    const r = await call(port, token);
    eq("状态 200", r.status, 200);
    ok("响应体原样透传", r.text.includes("pong"), r.text.slice(0, 80));
    const order = lastOrder();
    console.log("    fetch 通道实际头序: " + order.join(","));
    /* 这条断言是刻意的：Bun 的 Headers 会重排，三种传参方式都重排（普通对象 /
       Headers.set / Headers.append 实测一致），控制不了。买到的 JA3 就是拿这个换的。 */
    ok("fetch 通道下头序确实变了（已知代价）", order.join(",") !== CLIENT_ORDER.join(","), order.join(","));
    eq("客户端头一个没丢", order.slice().sort().join(","), CLIENT_ORDER.slice().sort().join(","));
    ok("凭据仍然被换掉", seen[seen.length - 1].rawHeaders.some((v) => v === "Bearer oauth-access"));
    await gw.close();
  }
}

console.log("\n=== D. auto 在 Bun 上真的走了 fetch ===");
{
  const { gw, port, token } = await boot();
  eq("auto 解析成 fetch", effectiveTransport(gw.cfg), bun ? "fetch" : "https");
  const r = await call(port, token);
  eq("状态 200", r.status, 200);
  const order = lastOrder();
  if (bun) {
    ok("Bun 上 auto 走 fetch，头序如预期被重排", order.join(",") !== CLIENT_ORDER.join(","), order.join(","));
  } else {
    eq("Node 上 auto 走 https，头序保持", order.join(","), CLIENT_ORDER.join(","));
  }
  await gw.close();
}

clearTimeout(watchdog);
upstream.close();
for (const d of dataDirs) cleanupDir(d);

console.log("\n========================================");
console.log("  PASS " + pass + "   FAIL " + fail);
if (failures.length > 0) { console.log("  失败项："); for (const f of failures) console.log("   - " + f); }
console.log("========================================\n");
process.exit(fail === 0 ? 0 : 1);
