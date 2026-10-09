#!/usr/bin/env node
/**
 * JA3 回归测试：走用户的真实链路形状。
 *
 *   网关(Bun) -> HTTP CONNECT 代理 -> TLS 抓取器
 *
 * 关键点：CONNECT 是透明隧道，TLS 端到端握到目标，所以指纹是网关自己的、
 * 不是代理的。这条测试就是为了钉住「走代理也不会破坏 JA3」这件事。
 *
 * 基线 1523504b38f0fae0d881d4b6554aac1b 是把真 Claude Code 2.1.293 指向
 * https://localhost:<probe> 实测出来的（13 个扩展，server_name 打头）。
 * 注意必须用域名而不是 IP：用 IP 时两边都不发 SNI，比出来的值少一个扩展、
 * 是另一个 JA3（5260242a…）。两个基线都对，但要对同一个。
 *
 * 运行：node test/ja3.test.ts 或 bun test/ja3.test.ts
 */
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

import { createGateway } from "../src/server.ts";
import { effectiveTransport } from "../src/upstream.ts";
import { isBun } from "../src/net/fetch.ts";
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
const watchdog = setTimeout(() => { console.log("\n!! 超时"); process.exit(3); }, 60000);

const JA3_WITH_SNI = "1523504b38f0fae0d881d4b6554aac1b";

/* 先占一个空闲端口再放掉，给抓取器用 */
async function freePort(): Promise<number> {
  const s = net.createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const p = (s.address() as AddressInfo).port;
  await new Promise<void>((r) => s.close(() => r()));
  return p;
}

const probePort = await freePort();
const outFile = path.join(os.tmpdir(), "cg-ja3-" + process.pid + ".jsonl");
fs.writeFileSync(outFile, "", "utf8");

const probe = spawn(process.execPath, [path.join(import.meta.dirname, "tls-probe.ts"), String(probePort)], {
  env: { ...process.env, TLS_OUT: outFile, TLS_LABEL: "gateway" },
  stdio: "ignore"
});

/* mock CONNECT 代理：只做转发，不碰 TLS */
const connects: string[] = [];
const proxy = net.createServer((client) => {
  let buf = Buffer.alloc(0);
  const onData = (chunk: Buffer) => {
    buf = Buffer.concat([buf, chunk]);
    const head = buf.toString("latin1");
    const end = head.indexOf("\r\n\r\n");
    if (end === -1) return;
    client.removeListener("data", onData);
    const first = head.split("\r\n")[0] ?? "";
    connects.push(first);
    const m = /^CONNECT\s+(\S+):(\d+)/.exec(first);
    if (!m) { client.end("HTTP/1.1 405 Method Not Allowed\r\n\r\n"); return; }
    const up = net.connect(probePort, "127.0.0.1", () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      const rest = buf.subarray(end + 4);
      if (rest.length) up.write(rest);
      up.pipe(client);
      client.pipe(up);
    });
    up.on("error", () => client.destroy());
  };
  client.on("data", onData);
  client.on("error", () => {});
});
await new Promise<void>((r) => proxy.listen(0, "127.0.0.1", r));
const proxyPort = (proxy.address() as AddressInfo).port;

const dataDirs: string[] = [];
function boot(over: Record<string, string>) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cg-ja3-"));
  dataDirs.push(dataDir);
  return createGateway({
    PORT: "0", HOST: "127.0.0.1", DATA_DIR: dataDir, SECRET: "ja3-secret",
    ADMIN_TOKEN: "ja3-admin", LOG_LEVEL: "error",
    /* 用域名而不是 IP：这样两边都会发 SNI，才对得上带 SNI 的基线 */
    UPSTREAM_BASE: "https://localhost:" + probePort,
    GUARD_MODE: "strict", INJECT_MISSING: "false", STEGO_MODE: "block",
    ...over
  } as never);
}

async function drive(gw: ReturnType<typeof boot>): Promise<void> {
  gw.accounts.create({ label: "j", kind: "oauth", accessToken: "a", refreshToken: "r",
    expiresAt: Math.floor(Date.now() / 1000) + 7200, scope: "user:inference" });
  const addr = await gw.listen();
  const port = (addr as AddressInfo).port;
  try {
    await request(port, "/v1/messages", {
      headers: { "content-type": "application/json",
        authorization: "Bearer " + signGatewayToken(gw.cfg, "default"),
        "user-agent": "claude-cli/2.1.293 (external, sdk-cli)", "x-app": "cli",
        /* strict 守卫要求这个头，少了直接 403 */
        "x-claude-code-session-id": "11111111-2222-3333-4444-555555555555",
        "anthropic-version": "2023-06-01" },
      body: { model: "claude-opus-5", max_tokens: 8, messages: [{ role: "user", content: "hi" }] }
    });
  } catch { /* 抓取器拿到 ClientHello 就掐断，请求必然失败 */ }
}

function captured(): Array<{ ja3: string; extensionCount: number; sni: string | null; extensions: string[] }> {
  const t = fs.readFileSync(outFile, "utf8").trim();
  if (!t) return [];
  return t.split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

console.log("\n=== A. 通道选择：有 HTTP 代理时仍然选 fetch ===");
{
  const gw = boot({ TRANSPORT: "auto", UPSTREAM_PROXY: "http://127.0.0.1:" + proxyPort });
  const t = effectiveTransport(gw.cfg);
  if (isBun()) {
    eq("Bun + http 代理 -> fetch", t, "fetch");
  } else {
    eq("Node + http 代理 -> https", t, "https");
  }
  const gw2 = boot({ TRANSPORT: "auto", UPSTREAM_PROXY: "socks5://127.0.0.1:" + proxyPort });
  eq("socks5 代理 -> 退回 https（fetch 不支持）", effectiveTransport(gw2.cfg), "https");
  await gw.close();
  await gw2.close();
}

console.log("\n=== B. 走 HTTP CONNECT 代理的 JA3 ===");
{
  const gw = boot({ TRANSPORT: "auto", UPSTREAM_PROXY: "http://127.0.0.1:" + proxyPort });
  await drive(gw);
  await sleep(2000);

  if (!isBun()) {
    console.log("  （非 Bun，fetch 通道不可用；这里只验代理隧道确实通了）");
    ok("代理收到了 CONNECT", connects.length > 0, JSON.stringify(connects));
  } else {
    const seen = captured();
    ok("抓到了 ClientHello", seen.length > 0, "数量=" + seen.length);
    if (seen.length > 0) {
      const last = seen[seen.length - 1]!;
      console.log("    实测 JA3=" + last.ja3 + " 扩展" + last.extensionCount + " SNI=" + last.sni);
      eq("JA3 与真 Claude Code 逐位一致", last.ja3, JA3_WITH_SNI);
      eq("扩展数与真客户端一致（13）", last.extensionCount, 13);
      ok("带了 SNI", last.sni === "localhost", String(last.sni));
      ok("带了 status_request", last.extensions.some((e) => e.includes("(5)")));
      ok("带了 signed_certificate_timestamp", last.extensions.some((e) => e.includes("(18)")));
    }
    ok("代理收到了 CONNECT", connects.length > 0, JSON.stringify(connects));
    /* CONNECT 的目标是 base URL 里的主机与端口（这里是抓取器），不是 443 —— 用域名
       而不是 IP 才有 SNI，这也是为什么基线要用带 SNI 的那个 */
    ok("CONNECT 用域名而不是 IP", new RegExp("^CONNECT localhost:" + probePort + " ").test(connects[0] ?? ""), connects[0] ?? "");
  }
  await gw.close();
}

console.log("\n=== C. 显式 https 时不走 fetch ===");
{
  const gw = boot({ TRANSPORT: "https", UPSTREAM_PROXY: "http://127.0.0.1:" + proxyPort });
  eq("显式 https 就是 https", effectiveTransport(gw.cfg), "https");
  await gw.close();
}

clearTimeout(watchdog);
proxy.close();
probe.kill();
fs.rmSync(outFile, { force: true });
for (const d of dataDirs) cleanupDir(d);

console.log("\n================================");
console.log("  PASS " + pass + "   FAIL " + fail);
if (fail) { console.log("  失败项："); for (const f of failures) console.log("   - " + f); }
console.log("================================\n");
process.exit(fail ? 1 : 0);
