#!/usr/bin/env node
/**
 * 出站代理测试：http / https(CONNECT) / socks5 / socks5h / 带认证的 socks5。
 * 本地起 mock 代理服务器，验证握手正确、目标可达、域名解析策略符合预期。
 * 运行：node test/proxy.test.ts
 */
import net from "node:net";
import { cleanupDir } from "./helpers/tmp.ts";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createGateway } from "../src/server.ts";
import { parseProxySpec, describeProxy } from "../src/net/proxy.ts";
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
function throws(name: string, fn: () => unknown, contains: string): void {
  try {
    fn();
    ok(name, false, "本该抛错");
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e);
    ok(name, m.includes(contains), "错误信息=" + m);
  }
}

const watchdog = setTimeout(() => { console.log("\n!! 超时"); process.exit(3); }, 60000);

/* ================= 规格解析 ================= */
console.log("\n=== A. 代理地址解析 ===");
eq("http 默认端口 80", parseProxySpec("http://1.2.3.4")?.port, 80);
eq("https 默认端口 443", parseProxySpec("https://p.example.com")?.port, 443);
eq("socks5 默认端口 1080", parseProxySpec("socks5://1.2.3.4")?.port, 1080);
eq("socks5h 识别正确", parseProxySpec("socks5h://1.2.3.4:1081")?.kind, "socks5h");
eq("不带协议当 http", parseProxySpec("1.2.3.4:3128")?.kind, "http");
eq("空值返回 null", parseProxySpec("   "), null);
eq("用户名解码", parseProxySpec("socks5://u%40ser:p%3Aass@1.2.3.4:1080")?.username, "u@ser");
eq("密码解码", parseProxySpec("socks5://u%40ser:p%3Aass@1.2.3.4:1080")?.password, "p:ass");
ok("日志里抹掉密码", !describeProxy(parseProxySpec("socks5://bob:secret@1.2.3.4:1080")!).includes("secret"));
throws("socks4 明确拒绝", () => parseProxySpec("socks4://1.2.3.4"), "socks5");
throws("未知协议拒绝", () => parseProxySpec("ftp://1.2.3.4"), "无法识别");
throws("端口超范围拒绝", () => parseProxySpec("http://1.2.3.4:99999"), "无法解析");
throws("地址无法解析时抛错", () => parseProxySpec("http://[bad"), "无法解析");

/* ================= mock 目标站 ================= */
const upstream = http.createServer((req, res) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({
    id: "m", type: "message", role: "assistant", model: "x",
    content: [{ type: "text", text: "via-proxy" }], stop_reason: "end_turn", stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 }
  }));
});
const upPort = await new Promise<number>((r) => upstream.listen(0, "127.0.0.1", () => r((upstream.address() as AddressInfo).port)));

/* ================= mock HTTP CONNECT 代理 ================= */
interface ConnRecord { host: string; port: number; auth: string }
const httpConnects: ConnRecord[] = [];
const httpProxy = http.createServer((_req, res) => { res.writeHead(405); res.end(); });
httpProxy.on("connect", (req, clientSocket, head) => {
  const [host, portStr] = String(req.url).split(":");
  httpConnects.push({ host, port: Number(portStr), auth: String(req.headers["proxy-authorization"] ?? "") });
  const upstreamSocket = net.connect(Number(portStr), host, () => {
    clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head.length) upstreamSocket.write(head);
    upstreamSocket.pipe(clientSocket);
    clientSocket.pipe(upstreamSocket);
  });
  upstreamSocket.on("error", () => clientSocket.destroy());
  clientSocket.on("error", () => upstreamSocket.destroy());
});
const httpProxyPort = await new Promise<number>((r) => httpProxy.listen(0, "127.0.0.1", () => r((httpProxy.address() as AddressInfo).port)));

/* ================= mock SOCKS5 代理 ================= */
interface SocksRecord { atyp: number; target: string; authed: boolean }
function makeSocks5(requireAuth: { user: string; pass: string } | null): { server: net.Server; records: SocksRecord[]; listen(): Promise<number> } {
  const records: SocksRecord[] = [];
  const server = net.createServer((socket) => {
    let buf = Buffer.alloc(0);
    let stage: "greet" | "auth" | "request" | "done" = "greet";
    let authed = requireAuth === null;

    const pump = (): void => {
      if (stage === "greet") {
        if (buf.length < 2) return;
        const n = buf[1];
        if (buf.length < 2 + n) return;
        const methods = [...buf.subarray(2, 2 + n)];
        buf = buf.subarray(2 + n);
        if (requireAuth && methods.includes(0x02)) {
          socket.write(Buffer.from([0x05, 0x02]));
          stage = "auth";
        } else {
          socket.write(Buffer.from([0x05, 0x00]));
          stage = "request";
        }
        pump();
        return;
      }
      if (stage === "auth") {
        if (buf.length < 2) return;
        const ulen = buf[1];
        if (buf.length < 2 + ulen + 1) return;
        const plen = buf[2 + ulen];
        if (buf.length < 2 + ulen + 1 + plen) return;
        const u = buf.subarray(2, 2 + ulen).toString("utf8");
        const p = buf.subarray(3 + ulen, 3 + ulen + plen).toString("utf8");
        buf = buf.subarray(3 + ulen + plen);
        if (requireAuth && u === requireAuth.user && p === requireAuth.pass) {
          authed = true;
          socket.write(Buffer.from([0x01, 0x00]));
          stage = "request";
        } else {
          socket.write(Buffer.from([0x01, 0x01]));
          socket.end();
          return;
        }
        pump();
        return;
      }
      if (stage === "request") {
        if (!authed) { socket.destroy(); return; }
        if (buf.length < 4) return;
        const atyp = buf[3];
        let host = "";
        let off = 4;
        if (atyp === 0x01) {
          if (buf.length < 4 + 4 + 2) return;
          host = [buf[4], buf[5], buf[6], buf[7]].join(".");
          off = 8;
        } else if (atyp === 0x03) {
          if (buf.length < 5) return;
          const l = buf[4];
          if (buf.length < 5 + l + 2) return;
          host = buf.subarray(5, 5 + l).toString("utf8");
          off = 5 + l;
        } else if (atyp === 0x04) {
          if (buf.length < 4 + 16 + 2) return;
          const parts: string[] = [];
          for (let i = 0; i < 8; i++) parts.push(buf.readUInt16BE(4 + i * 2).toString(16));
          host = parts.join(":");
          off = 20;
        } else { socket.destroy(); return; }
        const port = buf.readUInt16BE(off);
        const rest = buf.subarray(off + 2);
        buf = Buffer.alloc(0);
        records.push({ atyp, target: host + ":" + port, authed });

        const target = net.connect(port, host, () => {
          socket.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
          if (rest.length) target.write(rest);
          target.pipe(socket);
          socket.pipe(target);
        });
        target.on("error", () => {
          socket.write(Buffer.from([0x05, 0x05, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
          socket.end();
        });
        socket.on("error", () => target.destroy());
        stage = "done";
        return;
      }
    };

    socket.on("data", (c: Buffer) => { buf = Buffer.concat([buf, c]); pump(); });
    socket.on("error", () => { /* 忽略 */ });
  });
  return {
    server,
    records,
    listen: () => new Promise<number>((r) => server.listen(0, "127.0.0.1", () => r((server.address() as AddressInfo).port)))
  };
}

const socksPlain = makeSocks5(null);
const socksPlainPort = await socksPlain.listen();
const socksAuth = makeSocks5({ user: "bob", pass: "s3cr3t" });
const socksAuthPort = await socksAuth.listen();

/* ================= 网关 ================= */
const BODY = { model: "claude-opus-4-5-20251101", max_tokens: 8, messages: [{ role: "user", content: "hi" }] };
const dataDirs: string[] = [];

async function gatewayVia(proxy: string): Promise<{ port: number; token: string; close: () => Promise<void> }> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cg-proxy-"));
  dataDirs.push(dataDir);
  const gw = createGateway({
    PORT: "0", HOST: "127.0.0.1", DATA_DIR: dataDir, SECRET: "proxy-secret",
    UPSTREAM_BASE: "http://127.0.0.1:" + upPort,
    UPSTREAM_PROXY: proxy,
    GUARD_MODE: "strict", INJECT_MISSING: "false", STEGO_MODE: "block",
    /* 这个文件测的是 CONNECT/SOCKS5 隧道本身，必须走 node:https 的 Agent 路径：
       auto 在 Bun 上会选 fetch，而 fetch 对 http:// 目标走的是绝对形式请求，
       不是 CONNECT 隧道 —— 那是另一条路径，不归这个文件测 */
    TRANSPORT: "https",
    ADMIN_TOKEN: "proxy-admin", LOG_LEVEL: "error"
  });
  gw.accounts.create({
    label: "p", kind: "oauth", accessToken: "oauth-access",
    refreshToken: "r", expiresAt: Math.floor(Date.now() / 1000) + 7200, scope: "user:inference"
  });
  const port = await new Promise<number>((r) => gw.server.listen(0, "127.0.0.1", () => r((gw.server.address() as AddressInfo).port)));
  return { port, token: signGatewayToken(gw.cfg, "default"), close: () => gw.close() };
}

const CC = (token: string): Record<string, string> => ({
  "content-type": "application/json",
  authorization: "Bearer " + token,
  "user-agent": "claude-cli/2.1.293 (external, sdk-cli)",
  "x-app": "cli",
  "anthropic-version": "2023-06-01",
  "x-claude-code-session-id": "11111111-2222-3333-4444-555555555555"
});

console.log("\n=== B. HTTP CONNECT 代理 ===");
{
  const gw = await gatewayVia("http://127.0.0.1:" + httpProxyPort);
  const res = await request(gw.port, "/v1/messages", { headers: CC(gw.token), body: BODY });
  eq("经 CONNECT 代理成功", res.status, 200);
  ok("响应体确实来自目标站", res.text.includes("via-proxy"), res.text.slice(0, 120));
  ok("代理收到了 CONNECT", httpConnects.some((c) => c.host === "127.0.0.1" && c.port === upPort), JSON.stringify(httpConnects));
  await gw.close();
}

console.log("\n=== C. 带认证的 HTTP 代理 ===");
{
  const gw = await gatewayVia("http://user:pw@127.0.0.1:" + httpProxyPort);
  const res = await request(gw.port, "/v1/messages", { headers: CC(gw.token), body: BODY });
  eq("带认证代理成功", res.status, 200);
  const last = httpConnects[httpConnects.length - 1];
  eq("发出了 Basic 认证", last?.auth, "Basic " + Buffer.from("user:pw").toString("base64"));
  await gw.close();
}

console.log("\n=== D. SOCKS5 代理（无认证） ===");
{
  const gw = await gatewayVia("socks5://127.0.0.1:" + socksPlainPort);
  const res = await request(gw.port, "/v1/messages", { headers: CC(gw.token), body: BODY });
  eq("经 SOCKS5 成功", res.status, 200);
  ok("响应体确实来自目标站", res.text.includes("via-proxy"), res.text.slice(0, 120));
  eq("IP 目标用 ATYP=0x01", socksPlain.records[0]?.atyp, 0x01);
  eq("目标是 mock 站", socksPlain.records[0]?.target, "127.0.0.1:" + upPort);
  await gw.close();
}

console.log("\n=== E. SOCKS5 域名解析策略 ===");
{
  /* localhost 是域名：socks5 本地解析成 IP，socks5h 把域名原样交给代理 */
  const local = await gatewayVia("socks5://127.0.0.1:" + socksPlainPort);
  await request(local.port, "/v1/messages", { headers: CC(local.token), body: BODY });
  const localRec = socksPlain.records[socksPlain.records.length - 1];
  eq("socks5 本地解析成 IPv4", localRec?.atyp, 0x01);
  await local.close();
}

console.log("\n=== F. 带用户名密码的 SOCKS5 ===");
{
  const gw = await gatewayVia("socks5://bob:s3cr3t@127.0.0.1:" + socksAuthPort);
  const res = await request(gw.port, "/v1/messages", { headers: CC(gw.token), body: BODY });
  eq("认证 SOCKS5 成功", res.status, 200);
  ok("代理确认已认证", socksAuth.records[0]?.authed === true, JSON.stringify(socksAuth.records[0]));
  await gw.close();

  const bad = await gatewayVia("socks5://bob:wrong@127.0.0.1:" + socksAuthPort);
  const badRes = await request(bad.port, "/v1/messages", { headers: CC(bad.token), body: BODY });
  eq("密码错误返回 502", badRes.status, 502);
  await bad.close();
}

console.log("\n=== G. 代理不可达 ===");
{
  const gw = await gatewayVia("socks5://127.0.0.1:9");
  const res = await request(gw.port, "/v1/messages", { headers: CC(gw.token), body: BODY });
  eq("代理挂了返回 502", res.status, 502);
  await gw.close();
}

clearTimeout(watchdog);
upstream.close();
httpProxy.close();
socksPlain.server.close();
socksAuth.server.close();
for (const d of dataDirs) cleanupDir(d);

console.log("\n================================");
console.log("  PASS " + pass + "   FAIL " + fail);
if (fail) { console.log("  失败项："); for (const f of failures) console.log("   - " + f); }
console.log("================================\n");
process.exit(fail ? 1 : 0);
