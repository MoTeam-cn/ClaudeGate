#!/usr/bin/env node
/**
 * Web search 透传测试。
 *
 * Claude Code 的 WebSearch 不是单独一个端点，而是 Messages 请求里的一个**服务端工具**：
 *   tools: [{ type: "web_search_20250305", name: "web_search", max_uses, allowed_domains }]
 * 配 beta 头 web-search-2025-03-05，由上游去搜，结果以
 *   server_tool_use / web_search_tool_result / citations[].web_search_result_location
 * 三类块回到客户端（二进制里抠出来的原文引用）。
 *
 * 所以网关要做的仍然是「原样转发」。要盯的是两类东西：
 *   1. 工具定义与 beta 头不能丢（丢了工具直接不存在）
 *   2. 结果里的 encrypted_content / encrypted_index 是密文，客户端要自己解 ——
 *      被改写一个字就会 "failed to decrypt web search result content"
 *
 * 本测试跑在 STEGO_MODE=strip 下（最危险的那条路：隐写清洗会重写请求里的字符串）。
 *
 * 运行：node test/websearch.test.ts
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

/* 故意在密文里塞一段「看起来像隐写标记」的日期串 ——
   清洗器要是连密文一起洗，这里就会露馅 */
const APOS = String.fromCharCode(0x2019);
const MARKER_TEXT = "Today" + APOS + "s date is 2026-10-10";
const ENCRYPTED_CONTENT = "gAAAAAB" + MARKER_TEXT + "/abc+def==";
const ENCRYPTED_INDEX = "idxAA" + MARKER_TEXT + "/zzz=";
const SRV_ID = "srvtoolu_01WebSearchAbCdEf";

const TOOL = {
  type: "web_search_20250305",
  name: "web_search",
  max_uses: 5,
  allowed_domains: ["docs.anthropic.com"],
  blocked_domains: [],
  user_location: { type: "approximate", city: "Chengdu", region: "Sichuan", country: "CN" }
};

function resultBlocks(): unknown[] {
  return [
    { type: "server_tool_use", id: SRV_ID, name: "web_search", input: { query: "claude code gateway" } },
    { type: "web_search_tool_result", tool_use_id: SRV_ID, content: [
      { type: "web_search_result", url: "https://example.com/a", title: "A",
        encrypted_content: ENCRYPTED_CONTENT, page_age: "2026-10-01T00:00:00Z" }
    ] },
    { type: "text", text: "按文档，网关要原样转发。", citations: [
      { type: "web_search_result_location", url: "https://example.com/a", title: "A",
        encrypted_index: ENCRYPTED_INDEX, cited_text: "forward unchanged" }
    ] }
  ];
}

let upRawBody = "";
let upHeaders: Record<string, string> = {};

const upstream = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (c: Buffer) => chunks.push(c));
  req.on("end", () => {
    upRawBody = Buffer.concat(chunks).toString("utf8");
    upHeaders = {};
    for (let i = 0; i < req.rawHeaders.length; i += 2) upHeaders[req.rawHeaders[i].toLowerCase()] = req.rawHeaders[i + 1];
    let parsed: { stream?: boolean } = {};
    try { parsed = JSON.parse(upRawBody) as { stream?: boolean }; } catch { /* 忽略 */ }

    if (parsed.stream) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      const events: Array<[string, unknown]> = [
        ["message_start", { type: "message_start", message: { id: "msg_ws", usage: { input_tokens: 5, output_tokens: 0 } } }],
        ["content_block_start", { type: "content_block_start", index: 0,
          content_block: { type: "server_tool_use", id: SRV_ID, name: "web_search", input: {} } }],
        ["content_block_delta", { type: "content_block_delta", index: 0,
          delta: { type: "input_json_delta", partial_json: "{\"query\":\"x\"}" } }],
        ["content_block_stop", { type: "content_block_stop", index: 0 }],
        /* 搜索期间上游只发 ping —— 网关要原样放过去，攒着不发会踩客户端的流空闲超时 */
        ["ping", { type: "ping" }],
        ["content_block_start", { type: "content_block_start", index: 1,
          content_block: { type: "web_search_tool_result", tool_use_id: SRV_ID, content: [
            { type: "web_search_result", url: "https://example.com/a", title: "A", encrypted_content: ENCRYPTED_CONTENT }
          ] } }],
        ["content_block_stop", { type: "content_block_stop", index: 1 }],
        ["content_block_delta", { type: "content_block_delta", index: 2, delta: { type: "text_delta", text: "结果在此" } }],
        ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 9 } }],
        ["message_stop", { type: "message_stop" }]
      ];
      for (const e of events) {
        res.write("event: " + e[0] + "\ndata: " + JSON.stringify(e[1]) + "\n\n");
      }
      res.end();
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ id: "msg_ws", type: "message", role: "assistant", content: resultBlocks(),
      usage: { input_tokens: 5, output_tokens: 9 } }));
  });
});

await new Promise<void>((resolve) => { upstream.listen(0, "127.0.0.1", resolve); });
cleanup.push(() => upstream.close());
const upPort = (upstream.address() as AddressInfo).port;

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cg-ws-"));
cleanup.push(() => { try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* 忽略 */ } });

const gw = createGateway({
  PORT: "0", HOST: "127.0.0.1", DATA_DIR: dataDir, SECRET: "ws-secret",
  UPSTREAM_BASE: "http://127.0.0.1:" + upPort,
  GUARD_MODE: "strict", STEGO_MODE: "strip", LOG_LEVEL: "error"
});
const addr = await gw.listen(0, "127.0.0.1");
cleanup.push(() => gw.close());

gw.accounts.create({ label: "搜索号", kind: "oauth", accessToken: "tok-1", refreshToken: "ref-1",
  expiresAt: Math.floor(Date.now() / 1000) + 7200 });

const key = gw.keys.create({ name: "ws-key", fingerprintMode: "passthrough" });
const BETA = "claude-code-20250219,oauth-2025-04-20,web-search-2025-03-05";
const CC: Record<string, string> = {
  "content-type": "application/json",
  "x-api-key": key.plaintext,
  "user-agent": "claude-cli/2.1.293 (external, cli)",
  "x-app": "cli",
  "anthropic-version": "2023-06-01",
  "anthropic-beta": BETA,
  "x-claude-code-session-id": "sess-ws-1"
};

/** system 里带一枚真隐写标记，逼清洗器动手；同时历史里带着密文块 */
function bodyOf(stream: boolean): Record<string, unknown> {
  return {
    model: "claude-sonnet-4-5-20250929",
    max_tokens: 256,
    stream,
    system: [{ type: "text", text: "You are Claude Code. " + MARKER_TEXT, cache_control: { type: "ephemeral" } }],
    tools: [TOOL],
    messages: [
      { role: "user", content: [{ type: "text", text: "查一下 claude code gateway" }] },
      /* 上一轮的结果回灌：密文块会重新走一遍请求体 */
      { role: "assistant", content: resultBlocks() }
    ]
  };
}

/* ================= A. 工具定义与 beta 头 ================= */
console.log("\n=== A. 工具定义与 beta 头 ===");
const nonStream = await request(addr.port, "/v1/messages", { headers: CC, body: bodyOf(false) });
eq("非流式 200", nonStream.status, 200);
const sent = JSON.parse(upRawBody) as Record<string, any>;
eq("工具类型原样", sent?.tools?.[0]?.type, "web_search_20250305");
eq("max_uses 原样", sent?.tools?.[0]?.max_uses, 5);
eq("allowed_domains 原样", JSON.stringify(sent?.tools?.[0]?.allowed_domains), JSON.stringify(["docs.anthropic.com"]));
eq("user_location 原样", JSON.stringify(sent?.tools?.[0]?.user_location), JSON.stringify(TOOL.user_location));
ok("anthropic-beta 里还有 web-search",
  String(upHeaders["anthropic-beta"] ?? "").indexOf("web-search-2025-03-05") !== -1, upHeaders["anthropic-beta"]);

/* ================= B. 隐写清洗只动标记，不碰密文 ================= */
console.log("\n=== B. 清洗不碰密文 ===");
/* 整个原始请求体里当然还有那个码位 —— 密文里就故意放了一份。
   要看的是 system 那一段：它必须被归一化成 ASCII 撇号 */
/* 归因头会被插到 system 最前面，所以要把所有 system 段拼起来看，不能只看下标 0 */
const sysText = (Array.isArray(sent?.system) ? sent.system : []).map((b: any) => String(b?.text ?? "")).join("\n");
ok("system 里的隐写标记被清掉了", sysText.indexOf(APOS) === -1, JSON.stringify(sysText).slice(0, 160));
ok("system 被归一化成 ASCII 日期行", sysText.indexOf("Today's date is 2026-10-10") !== -1, JSON.stringify(sysText).slice(0, 160));
ok("密文里的同款日期串没被动过", upRawBody.indexOf("Today" + APOS) !== -1);
eq("回灌历史里的 encrypted_content 原样",
  sent?.messages?.[1]?.content?.[1]?.content?.[0]?.encrypted_content, ENCRYPTED_CONTENT);
eq("回灌历史里的 encrypted_index 原样",
  sent?.messages?.[1]?.content?.[2]?.citations?.[0]?.encrypted_index, ENCRYPTED_INDEX);
eq("server_tool_use 的 id 没被改", sent?.messages?.[1]?.content?.[0]?.id, SRV_ID);

/* ================= C. 非流式响应 ================= */
console.log("\n=== C. 非流式响应 ===");
const got = nonStream.json as Record<string, any>;
eq("server_tool_use id 原样", got?.content?.[0]?.id, SRV_ID);
eq("web_search_tool_result 的 tool_use_id 原样", got?.content?.[1]?.tool_use_id, SRV_ID);
eq("encrypted_content 逐字节一致", got?.content?.[1]?.content?.[0]?.encrypted_content, ENCRYPTED_CONTENT);
eq("encrypted_index 逐字节一致", got?.content?.[2]?.citations?.[0]?.encrypted_index, ENCRYPTED_INDEX);
eq("cited_text 原样", got?.content?.[2]?.citations?.[0]?.cited_text, "forward unchanged");

/* ================= D. 流式事件序列 ================= */
console.log("\n=== D. 流式事件序列 ===");
const streamed = await request(addr.port, "/v1/messages", { headers: CC, body: bodyOf(true) });
eq("流式 200", streamed.status, 200);
const order = ["message_start", "server_tool_use", "input_json_delta", "ping", "web_search_tool_result", "text_delta", "message_delta", "message_stop"];
let cursor = -1;
let ordered = true;
for (const needle of order) {
  const at = streamed.text.indexOf(needle, cursor + 1);
  if (at === -1) { ordered = false; failures.push("流里缺 " + needle); break; }
  cursor = at;
}
ok("事件按序到达且一个不少（含 ping）", ordered, streamed.text.slice(0, 260));
ok("流里的密文逐字节一致", streamed.text.indexOf(ENCRYPTED_CONTENT) !== -1);
ok("流式请求里的密文也原样",
  JSON.parse(upRawBody)?.messages?.[1]?.content?.[1]?.content?.[0]?.encrypted_content === ENCRYPTED_CONTENT);

clearTimeout(watchdog);
for (const fn of cleanup) { try { fn(); } catch { /* 忽略 */ } }
console.log("\n========================================");
console.log("  PASS " + pass + "   FAIL " + fail);
console.log("========================================");
if (fail) { console.log("\n失败项："); for (const f of failures) console.log("  - " + f); }
process.exit(fail ? 1 : 0);
