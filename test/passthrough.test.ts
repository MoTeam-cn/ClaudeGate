#!/usr/bin/env node
/**
 * 未知字段透传测试。
 *
 * 起因：Claude Code 弹
 *   However, this session isn't eligible because your requests go through <网关>,
 *   which isn't compatible with this update.
 * 官方给的解法是「请求头与请求体原样转发，包括网关不认识的字段（如 safeguards），
 * 响应与流式事件也不要丢键（如 safeguard_results），不要重写 tool-use ID」。
 * 二进制里的判定原话（原文引用）：
 *   [server-classifier] a completed response carried no classification result
 *   (no safeguard_results); assuming something on the path to the API dropped it
 * 也就是说：只要响应里少了 safeguard_results，Claude Code 就认定网关丢了东西，
 * 本地分类器接管，然后弹这条通知。
 *
 * 这里用「网关不认识的字段」做探针，双向验字节是否原样。
 *
 * 运行：node test/passthrough.test.ts
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";

import { createGateway } from "../src/server.ts";
import { askedForClassifier, answeredByClassifier, createClassifierSniffer } from "../src/security/classifier.ts";
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

/* 上游不认识的字段，故意做成嵌套结构 —— 浅拷贝或按白名单重建都会露馅 */
const SAFEGUARDS = {
  version: 7,
  checks: [
    { id: "chk_1", kind: "shell", verdict: "allow", score: 0.125, tags: ["a", "b"] },
    { id: "chk_2", kind: "network", verdict: "ask", score: 0.5, tags: [] }
  ],
  meta: { nested: { deep: [1, 2, { three: true }] }, note: "unicode \u4e2d\u6587 ok" }
};
const SAFEGUARD_RESULTS = {
  results: [{ id: "chk_1", outcome: "allowed", by: "server" }],
  ran_at: "2026-10-10T00:00:00Z",
  extra: { deep: { keep: ["x", "y"] } }
};

let upRawBody = "";
let upHeaders: Record<string, string> = {};
let upCalls = 0;

const upstream = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (c: Buffer) => chunks.push(c));
  req.on("end", () => {
    upCalls += 1;
    upRawBody = Buffer.concat(chunks).toString("utf8");
    upHeaders = {};
    for (let i = 0; i < req.rawHeaders.length; i += 2) upHeaders[req.rawHeaders[i].toLowerCase()] = req.rawHeaders[i + 1];
    let parsed: { stream?: boolean } = {};
    try { parsed = JSON.parse(upRawBody) as { stream?: boolean }; } catch { /* 忽略 */ }

    if (parsed.stream) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("event: message_start\ndata: " + JSON.stringify({ type: "message_start",
        message: { id: "msg_1", usage: { input_tokens: 3, output_tokens: 0 } } }) + "\n\n");
      res.write("event: message_delta\ndata: " + JSON.stringify({ type: "message_delta",
        delta: { stop_reason: "end_turn" }, usage: { output_tokens: 4 },
        safeguard_results: SAFEGUARD_RESULTS }) + "\n\n");
      res.write("event: message_stop\ndata: " + JSON.stringify({ type: "message_stop" }) + "\n\n");
      res.end();
      return;
    }
    res.writeHead(200, {
      "content-type": "application/json",
      /* 官方点名要回给客户端的 */
      "request-id": "req_passthrough_1",
      "anthropic-ratelimit-unified-status": "allowed",
      "anthropic-ratelimit-unified-5h-utilization": "0.42",
      "anthropic-organization-id": "org_passthrough",
      "retry-after": "3",
      "x-should-retry": "false",
      /* 网关完全不认识的，也必须原样回 */
      "x-custom-unknown-header": "keep-me",
      "anthropic-some-future-header": "also-keep-me",
      /* 必须丢掉的逐跳头 */
      "set-cookie": "should_be_dropped=1",
      connection: "keep-alive"
    });
    res.end(JSON.stringify({
      id: "msg_1", type: "message", role: "assistant",
      content: [{ type: "tool_use", id: "toolu_01ABCdef", name: "Bash", input: { command: "ls" } }],
      usage: { input_tokens: 3, output_tokens: 4 },
      safeguard_results: SAFEGUARD_RESULTS
    }));
  });
});

await new Promise<void>((resolve) => { upstream.listen(0, "127.0.0.1", resolve); });
cleanup.push(() => upstream.close());
const upPort = (upstream.address() as AddressInfo).port;

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cg-pass-"));
cleanup.push(() => { try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* 忽略 */ } });

const gw = createGateway({
  PORT: "0", HOST: "127.0.0.1", DATA_DIR: dataDir, SECRET: "pass-secret",
  UPSTREAM_BASE: "http://127.0.0.1:" + upPort,
  GUARD_MODE: "strict", STEGO_MODE: "block", LOG_LEVEL: "error"
});
const addr = await gw.listen(0, "127.0.0.1");
cleanup.push(() => gw.close());

gw.accounts.create({ label: "透传号", kind: "oauth", accessToken: "tok-1", refreshToken: "ref-1",
  expiresAt: Math.floor(Date.now() / 1000) + 7200 });

const key = gw.keys.create({ name: "pass-key", fingerprintMode: "passthrough" });
const BETA = "claude-code-20250219,oauth-2025-04-20,dangerous-tool-use-2026-09-03";
const CC: Record<string, string> = {
  "content-type": "application/json",
  "x-api-key": key.plaintext,
  "user-agent": "claude-cli/2.1.293 (external, cli)",
  "x-app": "cli",
  "anthropic-version": "2023-06-01",
  "anthropic-beta": BETA,
  "x-claude-code-session-id": "sess-pass-1",
  /* 网关不认识的请求头，也要原样到上游 */
  "x-custom-client-header": "keep-me-too"
};

/** 客户端请求：把 safeguards 挂在消息内容块上（官方就是这么放的） */
function bodyOf(stream: boolean): Record<string, unknown> {
  return {
    model: "claude-sonnet-4-5-20250929",
    max_tokens: 64,
    stream,
    system: [{ type: "text", text: "you are helpful", cache_control: { type: "ephemeral" } }],
    messages: [{
      role: "user",
      content: [{ type: "text", text: "run ls", safeguards: SAFEGUARDS }]
    }],
    tools: [{ name: "Bash", description: "run", input_schema: { type: "object" }, strict: true }]
  };
}

/* ================= A. 请求体：网关不认识的字段要原样到上游 ================= */
console.log("\n=== A. 请求体透传 ===");
const nonStream = await request(addr.port, "/v1/messages", { headers: CC, body: bodyOf(false) });
eq("非流式 200", nonStream.status, 200);

const sent = JSON.parse(upRawBody) as Record<string, any>;
const sentSafeguards = sent?.messages?.[0]?.content?.[0]?.safeguards;
ok("safeguards 字段到了上游", sentSafeguards !== undefined, JSON.stringify(sent?.messages?.[0]?.content?.[0] ?? null).slice(0, 200));
eq("safeguards 内容逐字节一致", JSON.stringify(sentSafeguards), JSON.stringify(SAFEGUARDS));
/* 归因头会插在 system 最前面，所以带 cache_control 的那段不在下标 0 ——
   要按「整个数组里还有没有它」来找，不能盯死位置 */
const sysBlocks = Array.isArray(sent?.system) ? sent.system : [];
ok("system 仍是块数组，没被压成字符串", sysBlocks.length > 0 && typeof sysBlocks[0] === "object",
  JSON.stringify(sent?.system).slice(0, 200));
ok("cache_control 没被丢",
  JSON.stringify(sysBlocks).indexOf('"cache_control":{"type":"ephemeral"}') !== -1,
  JSON.stringify(sysBlocks).slice(0, 240));
ok("工具的 strict 字段没被丢", sent?.tools?.[0]?.strict === true);
ok("max_tokens 原样", sent?.max_tokens === 64);

/* ================= B. 请求头：dangerous-tool-use 必须还在 ================= */
console.log("\n=== B. 请求头透传 ===");
const upBeta = String(upHeaders["anthropic-beta"] ?? "");
ok("anthropic-beta 里还有 dangerous-tool-use", upBeta.indexOf("dangerous-tool-use-2026-09-03") !== -1, upBeta);
ok("anthropic-beta 里还有 claude-code-20250219", upBeta.indexOf("claude-code-20250219") !== -1, upBeta);
eq("anthropic-version 原样", upHeaders["anthropic-version"], "2023-06-01");

/* ================= C. 响应体：safeguard_results 不能丢 ================= */
console.log("\n=== C. 响应体透传 ===");
const got = nonStream.json as Record<string, any>;
ok("safeguard_results 回来了", got?.safeguard_results !== undefined, JSON.stringify(got).slice(0, 200));
eq("safeguard_results 逐字节一致", JSON.stringify(got?.safeguard_results), JSON.stringify(SAFEGUARD_RESULTS));
eq("tool_use ID 没被重写", got?.content?.[0]?.id, "toolu_01ABCdef");
eq("usage 原样", JSON.stringify(got?.usage), JSON.stringify({ input_tokens: 3, output_tokens: 4 }));

/* ================= D. 流式：事件里的 safeguard_results 也不能丢 ================= */
console.log("\n=== D. 流式事件透传 ===");
upCalls = 0;
const streamed = await request(addr.port, "/v1/messages", { headers: CC, body: bodyOf(true) });
eq("流式 200", streamed.status, 200);
ok("流里带 safeguard_results", streamed.text.indexOf("safeguard_results") !== -1, streamed.text.slice(0, 240));
ok("流里带完整 results 结构", streamed.text.indexOf('"by":"server"') !== -1, streamed.text.slice(0, 240));
ok("message_stop 到了", streamed.text.indexOf("message_stop") !== -1);
const sentStream = JSON.parse(upRawBody) as Record<string, any>;
eq("流式请求里的 safeguards 也原样", JSON.stringify(sentStream?.messages?.[0]?.content?.[0]?.safeguards), JSON.stringify(SAFEGUARDS));

/* ================= F. 响应头与请求头全量透传 ================= */
console.log("\n=== F. 响应头 / 请求头全量透传 ===");
{
  const h = nonStream.headers;
  /* 官方要回给客户端的 */
  eq("request-id 原样", h["request-id"], "req_passthrough_1");
  eq("ratelimit 状态原样", h["anthropic-ratelimit-unified-status"], "allowed");
  eq("ratelimit 用量原样", h["anthropic-ratelimit-unified-5h-utilization"], "0.42");
  eq("organization-id 原样", h["anthropic-organization-id"], "org_passthrough");
  eq("retry-after 原样", h["retry-after"], "3");
  eq("x-should-retry 原样", h["x-should-retry"], "false");
  /* 网关不认识的 —— 白名单式的实现会在这里挂掉 */
  eq("未知响应头也原样", h["x-custom-unknown-header"], "keep-me");
  eq("未知 anthropic-* 也原样", h["anthropic-some-future-header"], "also-keep-me");
  /* 必须丢的 */
  ok("上游 set-cookie 被丢掉", h["set-cookie"] === undefined, JSON.stringify(h["set-cookie"]));
  eq("content-type 原样", String(h["content-type"] ?? "").split(";")[0], "application/json");
  /* 请求头 */
  eq("未知请求头也到了上游", upHeaders["x-custom-client-header"], "keep-me-too");
  eq("content-type 请求头原样", String(upHeaders["content-type"] ?? "").split(";")[0], "application/json");
  ok("connection 被归一成 keep-alive", String(upHeaders["connection"] ?? "").toLowerCase() === "keep-alive", upHeaders["connection"]);
}

/* ================= E. 分类器往返观测 ================= */
console.log("\n=== E. 分类器往返观测 ===");
ok("认得出请求里的 safeguards", askedForClassifier(bodyOf(false)) === true);
ok("没有就不认", askedForClassifier({ model: "m", messages: [] }) === false);
ok("null 不算带了", askedForClassifier({ messages: [{ content: [{ safeguards: null }] }] }) === false);
ok("认得出响应里的 safeguard_results", answeredByClassifier({ safeguard_results: SAFEGUARD_RESULTS }) === true);
ok("少了就认作没回", answeredByClassifier({ id: "msg_1", usage: {} }) === false);

{
  /* 键名被分片切开也要认出来 —— 跨边界漏判会误报「上游丢了结果」 */
  const sniffer = createClassifierSniffer();
  const text = "event: message_delta\ndata: " + JSON.stringify({ safeguard_results: SAFEGUARD_RESULTS }) + "\n\n";
  const bytes = Buffer.from(text, "utf8");
  const cut = text.indexOf("safeguard_results") + 5;
  sniffer.tap(bytes.subarray(0, cut));
  ok("切开前还没认出来", sniffer.saw() === false);
  sniffer.tap(bytes.subarray(cut));
  ok("跨分片也能认出来", sniffer.saw() === true);

  const none = createClassifierSniffer();
  none.tap(Buffer.from("event: message_stop\ndata: {}\n\n", "utf8"));
  ok("没有就不认", none.saw() === false);
}

clearTimeout(watchdog);
for (const fn of cleanup) { try { fn(); } catch { /* 忽略 */ } }
console.log("\n========================================");
console.log("  PASS " + pass + "   FAIL " + fail);
console.log("========================================");
if (fail) { console.log("\n失败项："); for (const f of failures) console.log("  - " + f); }
process.exit(fail ? 1 : 0);
