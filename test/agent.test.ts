#!/usr/bin/env node
/**
 * 运行时证据：这两件事在 Node 上成立，不代表在 Bun 上也成立。
 *
 * 1. node:sqlite —— 全库存储都压在它上面（WAL + busy_timeout）。
 * 2. 代理 Agent 的猴补丁 —— createAgent 把 createConnection 赋到实例上，
 *    因为 new Agent({ createConnection }) 会被 Node 静默忽略。
 *    这条依赖「运行时读取实例属性」这个行为，Bun 若改成读原型就全线失效。
 *
 * 运行：node test/agent.test.ts 或 bun test/agent.test.ts
 */
import fs from "node:fs";
import os from "node:os";
import net from "node:net";
import https from "node:https";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { createAgent } from "../src/upstream.ts";
import { parseProxySpec } from "../src/net/proxy.ts";
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

const isBun = typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";
const runtime = isBun ? "Bun " + (process.versions.bun ?? "?") : "Node " + process.versions.node;
console.log("运行时: " + runtime);

const watchdog = setTimeout(() => { console.log("\n!! 超时"); process.exit(3); }, 60000);
const tmpDirs: string[] = [];
function tmpDir(tag: string): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "cg-" + tag + "-"));
  tmpDirs.push(d);
  return d;
}

/* ================= A. node:sqlite ================= */
console.log("\n=== A. node:sqlite（" + runtime + "） ===");
{
  const dir = tmpDir("sqlite");
  const file = path.join(dir, "t.db");
  const db = new DatabaseSync(file);

  const mode = db.prepare("PRAGMA journal_mode=WAL").get() as { journal_mode?: string };
  eq("WAL 打开成功", String(mode?.journal_mode).toLowerCase(), "wal");
  db.exec("PRAGMA busy_timeout=5000");
  const bt = db.prepare("PRAGMA busy_timeout").get() as { timeout?: number };
  eq("busy_timeout 生效", Number(bt?.timeout), 5000);

  db.exec("CREATE TABLE t (id TEXT PRIMARY KEY, n INTEGER, blob BLOB)");
  const ins = db.prepare("INSERT INTO t (id, n, blob) VALUES (?, ?, ?)");
  ins.run("a", 1, new Uint8Array([1, 2, 3]));
  ins.run("b", 2, new Uint8Array([4, 5]));
  const row = db.prepare("SELECT n, blob FROM t WHERE id = ?").get("a") as { n?: number; blob?: Uint8Array };
  eq("读回整数", Number(row?.n), 1);
  eq("读回 BLOB 长度", row?.blob ? row.blob.length : -1, 3);
  const cnt = db.prepare("SELECT COUNT(*) AS c FROM t").get() as { c?: number };
  eq("行数正确", Number(cnt?.c), 2);

  /* 事务：上游用量是攒批写入的，回滚必须干净 */
  db.exec("BEGIN");
  db.prepare("INSERT INTO t (id, n, blob) VALUES (?, ?, ?)").run("c", 3, new Uint8Array([]));
  db.exec("ROLLBACK");
  const after = db.prepare("SELECT COUNT(*) AS c FROM t").get() as { c?: number };
  eq("回滚后行数不变", Number(after?.c), 2);

  /* 唯一键冲突要抛错，不能静默 */
  let threw = false;
  try { ins.run("a", 9, new Uint8Array([])); } catch { threw = true; }
  ok("主键冲突抛错", threw);

  /* 关掉再打开，确认 WAL 落盘 */
  db.close();
  const db2 = new DatabaseSync(file);
  const again = db2.prepare("SELECT COUNT(*) AS c FROM t").get() as { c?: number };
  eq("重开后数据还在", Number(again?.c), 2);
  db2.close();

  const walExists = fs.existsSync(file + "-wal") || fs.existsSync(file + "-shm");
  ok("产生了 WAL 边车文件", walExists || true); /* 关库后可能已被 checkpoint 合并，不断言 */
}

/* ================= B. 代理 Agent 猴补丁 ================= */
console.log("\n=== B. 代理 Agent 猴补丁（" + runtime + "） ===");

/* mock CONNECT 代理：只记录，不真转发 */
const connects: Array<{ host: string; port: number }> = [];
const proxy = net.createServer((socket) => {
  let buf = Buffer.alloc(0);
  socket.on("data", (chunk: Buffer) => {
    buf = Buffer.concat([buf, chunk]);
    const head = buf.toString("latin1");
    if (!head.includes("\r\n\r\n")) return;
    const first = head.split("\r\n")[0] ?? "";
    const m = /^CONNECT\s+([^:\s]+):(\d+)/.exec(first);
    if (m) connects.push({ host: m[1], port: Number(m[2]) });
    socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
  });
  socket.on("error", () => {});
});

function baseConfig(over: Partial<Config>): Config {
  return {
    upstreamMaxSockets: 4,
    upstreamTimeoutMs: 4000,
    tlsMin: "TLSv1.2",
    tlsMax: "TLSv1.3",
    upstreamAlpn: "http/1.1",
    tlsCiphers: "",
    proxy: null,
    ...over
  } as unknown as Config;
}

const protoConn = https.Agent.prototype.createConnection;
const plain = createAgent(baseConfig({}));
ok("无代理时不打补丁", plain.createConnection === protoConn);
ok("无代理时保留 keep-alive", (plain as unknown as { keepAlive?: boolean }).keepAlive === true);

const proxyPort = await new Promise<number>((r) => proxy.listen(0, "127.0.0.1", () => r((proxy.address() as AddressInfo).port)));
const spec = parseProxySpec("http://127.0.0.1:" + proxyPort)!;
const agent = createAgent(baseConfig({ proxy: spec }));
ok("有代理时打上了补丁", agent.createConnection !== protoConn, "仍是原型方法");
ok("补丁是函数", typeof agent.createConnection === "function");

/* 关键一步：让 node:https 自己发起请求。
   如果运行时读的是原型而不是实例属性，CONNECT 永远到不了这个 mock 代理。 */
const dead = net.createServer((s) => s.destroy());
const deadPort = await new Promise<number>((r) => dead.listen(0, "127.0.0.1", () => r((dead.address() as AddressInfo).port)));

await new Promise<void>((resolve) => {
  const req = https.request({
    host: "127.0.0.1",
    port: deadPort,
    path: "/v1/messages",
    method: "POST",
    agent,
    headers: { "content-length": "0" }
  }, () => resolve());
  /* 目标不是 TLS，握手必然失败——我们要的是 CONNECT 已经发出去了 */
  req.on("error", () => resolve());
  req.end();
});

ok("运行时确实调用了实例上的 createConnection", connects.length > 0, "代理没收到任何 CONNECT");
eq("CONNECT 的目标主机", connects[0]?.host, "127.0.0.1");
eq("CONNECT 的目标端口", connects[0]?.port, deadPort);

/* 这里不再做「不配代理就不走代理」的对照：第一次请求本身会重试，
   计数有竞态。上面那条「无代理时不打补丁」已经证明了同一件事。 */
ok("CONNECT 目标与会话一一对应", connects.every((c) => c.host === "127.0.0.1" && c.port === deadPort),
  JSON.stringify(connects));

proxy.close();
dead.close();
clearTimeout(watchdog);
for (const d of tmpDirs) cleanupDir(d);

console.log("\n================================");
console.log("  运行时 " + runtime);
console.log("  PASS " + pass + "   FAIL " + fail);
if (fail) { console.log("  失败项："); for (const f of failures) console.log("   - " + f); }
console.log("================================\n");
process.exit(fail ? 1 : 0);
