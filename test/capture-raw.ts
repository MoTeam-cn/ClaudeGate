#!/usr/bin/env node
/** 纯抓包服务器：冒充 Anthropic，把 Claude Code 发来的一切原样记下来。 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const OUT = process.env.PROBE_DIR || path.join(process.cwd(), "probe-raw");
fs.mkdirSync(OUT, { recursive: true });
const logPath = path.join(OUT, "raw.jsonl");
fs.writeFileSync(logPath, "", "utf8");

const server = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (c: Buffer) => chunks.push(c));
  req.on("end", () => {
    const body = Buffer.concat(chunks).toString("utf8");
    fs.appendFileSync(
      logPath,
      JSON.stringify({ at: new Date().toISOString(), method: req.method, url: req.url, headers: req.headers, body }) + "\n",
      "utf8"
    );
    console.log("HIT " + req.method + " " + req.url + " bodyLen=" + body.length);

    const url = req.url ?? "";
    let parsed: { stream?: boolean; model?: string } = {};
    try {
      parsed = JSON.parse(body || "{}") as { stream?: boolean; model?: string };
    } catch {
      /* 忽略 */
    }

    if (url.includes("count_tokens")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ input_tokens: 42 }));
      return;
    }

    if (parsed.stream) {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      const events: Array<[string, unknown]> = [
        ["message_start", { type: "message_start", message: { id: "msg_raw_1", type: "message", role: "assistant", model: parsed.model ?? "m", content: [], stop_reason: null, usage: { input_tokens: 9, output_tokens: 1 } } }],
        ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
        ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "pong" } }],
        ["content_block_stop", { type: "content_block_stop", index: 0 }],
        ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 3 } }],
        ["message_stop", { type: "message_stop" }]
      ];
      let i = 0;
      const tick = (): void => {
        if (i >= events.length) { res.end(); return; }
        res.write("event: " + events[i][0] + "\n");
        res.write("data: " + JSON.stringify(events[i][1]) + "\n\n");
        i += 1;
        setTimeout(tick, 5);
      };
      tick();
      return;
    }

    res.writeHead(200, { "content-type": "application/json", "request-id": "req_raw_1" });
    res.end(JSON.stringify({
      id: "msg_raw_1",
      type: "message",
      role: "assistant",
      model: parsed.model ?? "claude-sonnet-4-5-20250929",
      content: [{ type: "text", text: "pong" }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 9, output_tokens: 3 }
    }));
  });
});

const port = Number(process.env.PROBE_PORT || 3100);
server.listen(port, "127.0.0.1", () => {
  console.log("RAW_READY http://127.0.0.1:" + port);
  console.log("capture=" + logPath);
});
