#!/usr/bin/env node
/**
 * 流式真实性探针：记录每个 SSE 分片的到达时刻，证明是真流式而非缓冲后一次性吐出。
 * 运行：node test/stream-probe.ts
 */
import http from "node:http";
import { cleanupDir } from "./helpers/tmp.ts";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { createGateway } from "../src/server.ts";

const GAP = 200; // 假上游每个事件之间间隔

function mockUpstream(): http.Server {
  return http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      let parsed: { stream?: boolean; model?: string } = {};
      try {
        parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { stream?: boolean; model?: string };
      } catch { /* ignore */ }
      if (!parsed.stream) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end("{}");
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      const events: Array<[string, unknown]> = [
        ["message_start", { type: "message_start", message: { id: "msg_probe", model: parsed.model, usage: { input_tokens: 5 } } }],
        ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
        ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "第一段" } }],
        ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "第二段" } }],
        ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "第三段" } }],
        ["content_block_stop", { type: "content_block_stop", index: 0 }],
        ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 9 } }],
        ["message_stop", { type: "message_stop" }]
      ];
      let i = 0;
      const tick = (): void => {
        if (i >= events.length) { res.end(); return; }
        res.write("event: " + events[i][0] + "\n");
        res.write("data: " + JSON.stringify(events[i][1]) + "\n\n");
        i += 1;
        setTimeout(tick, GAP);
      };
      tick();
    });
  });
}

interface Arrival { t: number; bytes: number; preview: string }

function collect(port: number, pathname: string, headers: Record<string, string>, body: unknown): Promise<Arrival[]> {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify(body));
    const started = Date.now();
    const arrivals: Arrival[] = [];
    const req = http.request({
      agent: false, hostname: "127.0.0.1", port, path: pathname, method: "POST",
      headers: { ...headers, "content-type": "application/json", "content-length": String(payload.length) }
    }, (res) => {
      res.on("data", (c: Buffer) => {
        arrivals.push({
          t: Date.now() - started,
          bytes: c.length,
          preview: c.toString("utf8").replace(/\n/g, "\\n").slice(0, 90)
        });
      });
      res.on("end", () => resolve(arrivals));
    });
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

const upstream = mockUpstream();
const upPort = await new Promise<number>((r) => upstream.listen(0, "127.0.0.1", () => r((upstream.address() as { port: number }).port)));

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cg-probe-"));
const gw = createGateway({
  PORT: "0", HOST: "127.0.0.1", DATA_DIR: dataDir, SECRET: "probe",
  UPSTREAM_BASE: "http://127.0.0.1:" + upPort, GUARD_MODE: "strict", LOG_LEVEL: "error"
});
const addr = await gw.listen(0, "127.0.0.1");
gw.accounts.create({ label: "probe", kind: "oauth", accessToken: "t", refreshToken: "r", expiresAt: Math.floor(Date.now() / 1000) + 3600, scope: "user:inference" });

const tokenRes = await new Promise<string>((r) => {
  http.get({ agent: false, hostname: "127.0.0.1", port: addr.port, path: "/token" }, (res) => {
    let b = ""; res.on("data", (c: Buffer) => (b += c)); res.on("end", () => r(b.trim()));
  });
});

const CC: Record<string, string> = {
  authorization: "Bearer " + tokenRes,
  "user-agent": "claude-cli/2.1.293 (external, cli)",
  "x-app": "cli",
  "anthropic-version": "2023-06-01",
  "x-claude-code-session-id": "0f8fad5b-d9cb-469f-a165-70867728950e"
};

console.log("假上游事件间隔 = " + GAP + "ms；若网关缓冲，所有分片会在同一时刻到达。\n");

const a1 = await collect(addr.port, "/v1/messages", CC, {
  model: "claude-sonnet-4-5-20250929", max_tokens: 64, stream: true,
  messages: [{ role: "user", content: "hi" }]
});
console.log("=== Anthropic 原生透传 /v1/messages (stream:true) ===");
console.log("分片数 = " + a1.length);
for (const x of a1) console.log("  +" + String(x.t).padStart(5) + "ms  " + String(x.bytes).padStart(4) + "B  " + x.preview);

const a2 = await collect(addr.port, "/v1/chat/completions", CC, {
  model: "claude-sonnet-4-5-20250929", stream: true,
  messages: [{ role: "user", content: "hi" }]
});
console.log("\n=== OpenAI 转译 /v1/chat/completions (stream:true) ===");
console.log("分片数 = " + a2.length);
for (const x of a2) console.log("  +" + String(x.t).padStart(5) + "ms  " + String(x.bytes).padStart(4) + "B  " + x.preview);

const span1 = a1.length ? a1[a1.length - 1].t - a1[0].t : 0;
const span2 = a2.length ? a2[a2.length - 1].t - a2[0].t : 0;
console.log("\n=== 判定 ===");
console.log("原生透传 首末分片时间跨度 = " + span1 + "ms（预期约 " + GAP * 7 + "ms）");
console.log("OpenAI 转译 首末分片时间跨度 = " + span2 + "ms");
console.log(span1 > GAP * 2 && span2 > GAP * 2 ? "结论：真流式（分片随时间逐步到达）" : "结论：疑似被缓冲");

await gw.close();
if (typeof upstream.closeAllConnections === "function") upstream.closeAllConnections();
await new Promise<void>((r) => upstream.close(() => r()));
cleanupDir(dataDir);
