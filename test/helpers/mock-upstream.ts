import http from "node:http";
import type { IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";

export interface MockUpstream {
  readonly last: { method: string; url: string; headers: IncomingHttpHeaders; body: string } | null;
  readonly calls: number;
  listen(): Promise<number>;
  close(): Promise<void>;
}

/** 假 Anthropic 上游：记录最后一次请求，支持普通与 SSE 两种应答 */
export function createMockUpstream(): MockUpstream {
  let last: MockUpstream["last"] = null;
  let calls = 0;

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      calls += 1;
      last = { method: req.method ?? "GET", url: req.url ?? "/", headers: req.headers, body };

      if ((req.url ?? "").startsWith("/v1/messages/count_tokens")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ input_tokens: 42 }));
        return;
      }

      if (!(req.url ?? "").startsWith("/v1/messages")) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ type: "error", error: { type: "not_found_error", message: "no route" } }));
        return;
      }

      let parsed: { stream?: boolean; model?: string } = {};
      try {
        parsed = JSON.parse(body || "{}") as { stream?: boolean; model?: string };
      } catch {
        /* 非 JSON 就当空 */
      }

      if (parsed.stream) {
        sendStream(res, parsed.model ?? "");
        return;
      }

      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        id: "msg_abc123",
        type: "message",
        role: "assistant",
        model: parsed.model,
        content: [
          { type: "text", text: "Hello from mock" },
          { type: "tool_use", id: "toolu_1", name: "get_weather", input: { city: "SF" } }
        ],
        stop_reason: "tool_use",
        usage: { input_tokens: 11, output_tokens: 7 }
      }));
    });
  });

  function sendStream(res: http.ServerResponse, model: string): void {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    const events: Array<[string, unknown]> = [
      ["message_start", { type: "message_start", message: { id: "msg_abc123", model, usage: { input_tokens: 11 } } }],
      ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
      ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello" } }],
      ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: " world" } }],
      ["content_block_stop", { type: "content_block_stop", index: 0 }],
      ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 7 } }],
      ["message_stop", { type: "message_stop" }]
    ];
    let i = 0;
    const tick = (): void => {
      if (i >= events.length) {
        res.end();
        return;
      }
      const [name, payload] = events[i];
      res.write("event: " + name + "\n");
      res.write("data: " + JSON.stringify(payload) + "\n\n");
      i += 1;
      setTimeout(tick, 3);
    };
    tick();
  }

  return {
    get last() {
      return last;
    },
    get calls() {
      return calls;
    },
    listen(): Promise<number> {
      return new Promise((resolve) => {
        server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port));
      });
    },
    close(): Promise<void> {
      if (typeof server.closeAllConnections === "function") server.closeAllConnections();
      return new Promise((resolve) => {
        server.close(() => resolve());
      });
    }
  };
}
