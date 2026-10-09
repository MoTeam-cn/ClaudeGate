#!/usr/bin/env node
/**
 * 出口自检（IP 保底）。
 *
 * 要防的坑：配置里写着代理，请求实际却没走代理。判据是「带代理」与「不带代理」两次
 * 查到的出口 IP 是否相同 —— 相同就说明代理形同虚设。
 *
 * mock 的 IP 回显服务按调用次序发不同 IP，用来模拟「两条路出口不同」；
 * 把模式切成 always-same 就模拟「两条路出口一样」。
 *
 * 运行：node test/ipcheck.test.ts 或 bun test/ipcheck.test.ts
 */
import http from "node:http";
import net from "node:net";
import type { AddressInfo } from "node:net";

import { checkEgress } from "../src/net/ipcheck.ts";
import { createGateway } from "../src/server.ts";
import { cleanupDir } from "./helpers/tmp.ts";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

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

/* ============ mock：IP 回显服务 + CONNECT 代理 ============ */
let ipMode: "different" | "same" | "always-json-ip" = "different";
let ipCalls = 0;
const seenIps: string[] = [];

const ipSvc = http.createServer((req, res) => {
  ipCalls++;
  let body: string;
  if (ipMode === "always-json-ip") {
    body = JSON.stringify({ ip: "9.9.9.9", city: "X" });
  } else if (ipMode === "same") {
    body = JSON.stringify({ ip: "1.2.3.4" });
  } else {
    const ip = ipCalls % 2 === 1 ? "1.2.3.4" : "5.6.7.8";
    body = JSON.stringify({ ip });
  }
  seenIps.push(body);
  res.writeHead(200, { "content-type": "application/json" });
  res.end(body);
});

/* 极简 CONNECT 代理：只做隧道，够验「请求确实绕了一圈」 */
let proxyHits = 0;
const proxy = http.createServer((_req, res) => { res.writeHead(405); res.end(); });
proxy.on("connect", (req, clientSocket, head) => {
  proxyHits++;
  const [host, port] = String(req.url ?? "").split(":");
  const serverSocket = net.connect(Number(port), host, () => {
    clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head && head.length) serverSocket.write(head);
    serverSocket.pipe(clientSocket);
    clientSocket.pipe(serverSocket);
  });
  const kill = (): void => { clientSocket.destroy(); serverSocket.destroy(); };
  serverSocket.on("error", kill);
  clientSocket.on("error", kill);
});

const ipPort = await new Promise<number>((r) => ipSvc.listen(0, "127.0.0.1", () => r((ipSvc.address() as AddressInfo).port)));
const proxyPort = await new Promise<number>((r) => proxy.listen(0, "127.0.0.1", () => r((proxy.address() as AddressInfo).port)));
const ipUrl = "http://127.0.0.1:" + ipPort + "/json";
const proxyUrl = "http://127.0.0.1:" + proxyPort;

const dataDirs: string[] = [];
function boot(over: Record<string, string> = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cg-ipchk-"));
  dataDirs.push(dataDir);
  return createGateway({
    PORT: "0", HOST: "127.0.0.1", DATA_DIR: dataDir, SECRET: "ipchk-secret",
    ADMIN_TOKEN: "ipchk-admin", LOG_LEVEL: "error",
    IP_CHECK_URL: ipUrl,
    ...over
  } as never);
}

console.log("\n=== A. 没有配代理：不判定，也不该出网 ===");
{
  const before = ipCalls;
  const gw = boot();
  const r = await checkEgress(gw.cfg, 3000);
  eq("没有结论", r.conclusive, false);
  eq("不判为代理失效", r.proxyIgnored, false);
  ok("说明是没配代理", r.summary.includes("没有配置出站代理"), r.summary);
  await gw.close();
  void before;
}

console.log("\n=== B. 两条路出口不同：判定正常 ===");
{
  ipMode = "different";
  ipCalls = 0;
  const gw = boot({ UPSTREAM_PROXY: proxyUrl });
  const before = proxyHits;
  const r = await checkEgress(gw.cfg, 5000);
  eq("有结论", r.conclusive, true);
  eq("代理生效", r.proxyIgnored, false);
  ok("直连那次拿到了 IP", !!r.direct.ip, JSON.stringify(r.direct));
  ok("经代理那次拿到了 IP", !!r.proxied.ip, JSON.stringify(r.proxied));
  ok("两个 IP 不同", r.direct.ip !== r.proxied.ip, r.direct.ip + " vs " + r.proxied.ip);
  ok("请求确实穿过了代理", proxyHits > before, "proxyHits=" + proxyHits);
  ok("结论里带上了两个 IP", r.summary.includes(String(r.direct.ip)) && r.summary.includes(String(r.proxied.ip)), r.summary);
  await gw.close();
}

console.log("\n=== C. 两条路出口一样：判为代理没生效 ===");
{
  ipMode = "same";
  const gw = boot({ UPSTREAM_PROXY: proxyUrl });
  const r = await checkEgress(gw.cfg, 5000);
  eq("有结论", r.conclusive, true);
  eq("判为代理没生效", r.proxyIgnored, true);
  eq("直连与经代理同 IP", r.direct.ip, r.proxied.ip);
  ok("结论说清楚了", r.summary.includes("代理没生效"), r.summary);
  await gw.close();
}

console.log("\n=== D. 直连拿不到（内网无出口）：不判定，不能冤枉代理 ===");
{
  /* 指到一个没人监听的端口，直连那条必然失败 */
  const dead = "http://127.0.0.1:1/json";
  const gw = boot({ UPSTREAM_PROXY: proxyUrl, IP_CHECK_URL: dead });
  const r = await checkEgress(gw.cfg, 3000);
  eq("没有结论", r.conclusive, false);
  eq("不判为代理失效", r.proxyIgnored, false);
  ok("如实说明无法判定", r.summary.includes("无法判定"), r.summary);
  await gw.close();
}

console.log("\n=== E. 各种 IP 回显格式都要认 ===");
{
  ipMode = "always-json-ip";
  const gw = boot({ UPSTREAM_PROXY: proxyUrl });
  const r = await checkEgress(gw.cfg, 5000);
  eq("从 {ip:...} 里读出来了", r.proxied.ip, "9.9.9.9");
  eq("两边一样所以判为代理没生效", r.proxyIgnored, true);
  await gw.close();
  ipMode = "different";
}

clearTimeout(watchdog);
ipSvc.close();
proxy.close();
for (const d of dataDirs) cleanupDir(d);

console.log("\n================================");
console.log("  PASS " + pass + "   FAIL " + fail);
if (fail) { console.log("  失败项："); for (const f of failures) console.log("   - " + f); }
console.log("================================\n");
process.exit(fail ? 1 : 0);
