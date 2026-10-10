#!/usr/bin/env node
/**
 * 流式转发加固测试。
 *
 * 起因：Claude Code 报
 *   Streaming response ended before any complete data was received
 * 即「一个完整事件都没收到，流就结束了」。网关这边有三条路会造出它：
 *   1. 上游在首字节前就断了，我们却已经回了 200 + text/event-stream —— 客户端看到空流；
 *   2. fetch 通道拿 AbortSignal.timeout 盖住响应体，超过总时长的流被拦腰砍断；
 *   3. 首字节闸门自己丢块（取第一块时摘掉 data 监听器，中间那几块被静默丢掉）。
 *
 * 运行：node test/stream.test.ts
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";

import { createGateway } from "../src/server.ts";
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
const cleanup: Array<() => void> = [];

/* ================= 可控上游 ================= */
type Mode = "ok" | "empty" | "headcut" | "midcut";
let mode: Mode = "ok";
let calls = 0;
/** 只让第一次调用断在首字节之前（响应头必须真的发出去，否则是「连都没连上」） */
let failFirst = false;

const EVENTS: Array<[string, unknown]> = [
  ["message_start", { type: "message_start", message: { id: "msg_s", model: "m",
    usage: { input_tokens: 11, cache_creation_input_tokens: 5, cache_read_input_tokens: 3 } } }],
  ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } }],
  ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 7 } }],
  ["message_stop", { type: "message_stop" }]
];
function sseText(): string {
  let s = "";
  for (const e of EVENTS) s += "event: " + e[0] + "\ndata: " + JSON.stringify(e[1]) + "\n\n";
  return s;
}

const upstream = http.createServer((req, res) => {
  req.resume();
  req.on("end", () => {
    calls += 1;
    if (failFirst && calls === 1) {
      /* 响应头真的发出去，然后 body 一个字节都不写就断 —— 模拟代理抽风。
         flushHeaders 是必须的：只 writeHead 不写 body 的话头根本不会发，
         客户端看到的是「连都没连上」，走的就不是首字节闸门这条路了 */
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.flushHeaders();
      setTimeout(() => { res.socket?.destroy(); }, 5);
      return;
    }
    if (mode === "empty") {
      /* 200 + 事件流，但一个字节都没有 */
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end();
      return;
    }
    if (mode === "headcut") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.flushHeaders();
      setTimeout(() => { res.socket?.destroy(); }, 5);
      return;
    }
    if (mode === "midcut") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("event: message_start\ndata: " + JSON.stringify(EVENTS[0][1]) + "\n\n");
      setTimeout(() => { res.socket?.destroy(); }, 15);
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    /* 逐个事件、event 行与 data 行分两次写，并且隔一小会儿再写下一条 ——
       就是为了让它们真的落进不同的 TCP 分片，把「中间块被吞」那个坑钉死 */
    let i = 0;
    const tick = (): void => {
      if (i >= EVENTS.length) { res.end(); return; }
      res.write("event: " + EVENTS[i][0] + "\n");
      res.write("data: " + JSON.stringify(EVENTS[i][1]) + "\n\n");
      i += 1;
      setTimeout(tick, 2);
    };
    tick();
  });
});

await new Promise<void>((resolve) => { upstream.listen(0, "127.0.0.1", resolve); });
cleanup.push(() => upstream.close());
const upPort = (upstream.address() as AddressInfo).port;

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cg-stream-"));
cleanup.push(() => { try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* 忽略 */ } });

const gw = createGateway({
  PORT: "0", HOST: "127.0.0.1", DATA_DIR: dataDir, SECRET: "stream-secret",
  UPSTREAM_BASE: "http://127.0.0.1:" + upPort,
  GUARD_MODE: "strict", STEGO_MODE: "block", LOG_LEVEL: "error"
});
const addr = await gw.listen(0, "127.0.0.1");
cleanup.push(() => gw.close());

gw.accounts.create({ label: "流式号一", kind: "oauth", accessToken: "tok-1", refreshToken: "ref-1",
  expiresAt: Math.floor(Date.now() / 1000) + 7200 });
gw.accounts.create({ label: "流式号二", kind: "apikey", apiKey: "sk-ant-stream-2" });

const key = gw.keys.create({ name: "stream-key", fingerprintMode: "passthrough" });
const CC: Record<string, string> = {
  "content-type": "application/json",
  "x-api-key": key.plaintext,
  "user-agent": "claude-cli/2.1.293 (external, cli)",
  "x-app": "cli",
  "anthropic-version": "2023-06-01",
  "x-claude-code-session-id": "sess-stream-1"
};
const BODY = { model: "claude-sonnet-4-5-20250929", max_tokens: 32, stream: true,
  messages: [{ role: "user", content: "hi" }] };

/** 容忍中途断连的客户端：默认的 request() 在 res 报错时永远不 resolve */
function requestTolerant(port: number, pathname: string): Promise<{ status: number; text: string; closed: boolean }> {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify(BODY));
    const req = http.request({
      agent: false, hostname: "127.0.0.1", port, path: pathname, method: "POST",
      headers: { ...CC, "content-length": String(payload.length) }
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("error", () => { /* 断连也算正常收尾 */ });
      res.on("close", () => resolve({
        status: res.statusCode ?? 0,
        text: Buffer.concat(chunks).toString("utf8"),
        closed: true
      }));
    });
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

/* ================= A. 空流不能当成 200 发下去 ================= */
console.log("\n=== A. 上游首字节前就结束 ===");
mode = "empty";
const a = await request(addr.port, "/v1/messages", { headers: CC, body: BODY });
eq("空流回 5xx 而不是 200", a.status, 502);
eq("错误体是 Anthropic 形状", (a.json as { type?: string })?.type, "error");
ok("错误码说明是首字节失败",
  JSON.stringify(a.json).indexOf("stream_head_failed") !== -1, JSON.stringify(a.json).slice(0, 160));

/* ================= B. 首字节前断连 -> 自动重试 ================= */
console.log("\n=== B. 首字节前断连后自动重试 ===");
calls = 0;
mode = "ok";
failFirst = true;
const b = await request(addr.port, "/v1/messages", { headers: CC, body: BODY });
failFirst = false;
eq("重试后拿到 200", b.status, 200);
ok("重试后事件完整", b.text.indexOf("message_stop") !== -1, b.text.slice(0, 120));
ok("上游被打了两次以上", calls >= 2, "calls=" + calls);

/* ================= C. 正常流式：分片不丢、原样转发 ================= */
console.log("\n=== C. 正常流式转发 ===");
mode = "ok";
calls = 0;
const c = await request(addr.port, "/v1/messages", { headers: CC, body: BODY });
eq("正常流式 200", c.status, 200);
eq("content-type 仍是 SSE", String(c.headers["content-type"] ?? "").split(";")[0], "text/event-stream");
eq("带上 x-accel-buffering", c.headers["x-accel-buffering"], "no");
eq("body 与上游逐字节一致", c.text, sseText());
ok("四个事件都在", EVENTS.every((e) => c.text.indexOf("event: " + e[0]) !== -1), c.text.slice(0, 120));
/* 首块（event: message_start）之后的 data 行曾经被静默丢掉，
   于是 input_tokens / cache_* 全读成 0 —— 这里从请求日志侧再钉一次 */
const logs = gw.logs.queryRequests({ limit: 10, offset: 0 });
const last = (logs.rows ?? [])[0] as unknown as Record<string, unknown> | undefined;
eq("流式 input_tokens 记到了", last?.promptTokens, 11);
eq("流式 output_tokens 记到了", last?.completionTokens, 7);
eq("流式 cache_read 记到了", last?.cacheReadTokens, 3);

/* ================= D. 流中途断：请求要能收尾，不能挂死 ================= */
console.log("\n=== D. 流中途断连 ===");
mode = "midcut";
const d = await requestTolerant(addr.port, "/v1/messages");
eq("中途断也回了 200（响应头早就发出去了）", d.status, 200);
ok("收到了断点之前的事件", d.text.indexOf("message_start") !== -1, d.text.slice(0, 80));
ok("确实没有收到结尾", d.text.indexOf("message_stop") === -1, d.text.slice(-80));

clearTimeout(watchdog);
for (const fn of cleanup) { try { fn(); } catch { /* 忽略 */ } }
console.log("\n========================================");
console.log("  PASS " + pass + "   FAIL " + fail);
console.log("========================================");
if (fail) { console.log("\n失败项："); for (const f of failures) console.log("  - " + f); }
process.exit(fail ? 1 : 0);
