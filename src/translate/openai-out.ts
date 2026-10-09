import type { Readable } from "node:stream";
import type { ServerResponse } from "node:http";
import { randHex, nowSec } from "../utils.ts";
import { mapFinish, anthropicUsageToOpenai } from "./shared.ts";
import type { AnthropicContentBlock, AnthropicResponse } from "../types.ts";

export interface OpenAIChatCompletion {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: { role: "assistant"; content: string | null; reasoning_content?: string; tool_calls?: unknown[] };
    finish_reason: string;
  }>;
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

/** Anthropic Messages 响应体 -> OpenAI ChatCompletion */
export function anthropicToOpenai(resp: AnthropicResponse, model: string): OpenAIChatCompletion {
  const texts: string[] = [];
  const thinking: string[] = [];
  const toolCalls: unknown[] = [];
  const blocks: AnthropicContentBlock[] = Array.isArray(resp.content) ? resp.content : [];

  for (const b of blocks) {
    if (b.type === "text") texts.push(b.text ?? "");
    else if (b.type === "thinking") thinking.push(b.thinking ?? "");
    else if (b.type === "tool_use") {
      toolCalls.push({
        id: b.id || "call_" + randHex(8),
        type: "function",
        function: { name: b.name ?? "", arguments: JSON.stringify(b.input ?? {}) }
      });
    }
  }

  const message: OpenAIChatCompletion["choices"][number]["message"] = {
    role: "assistant",
    content: texts.join("") || null
  };
  if (thinking.length) message.reasoning_content = thinking.join("");
  if (toolCalls.length) message.tool_calls = toolCalls;

  return {
    id: "chatcmpl-" + String(resp.id || randHex(10)).replace(/[^A-Za-z0-9]/g, ""),
    object: "chat.completion",
    created: nowSec(),
    model: model || resp.model || "",
    choices: [{ index: 0, message, finish_reason: mapFinish(resp.stop_reason) }],
    usage: anthropicUsageToOpenai(resp.usage)
  };
}

/**
 * 把 Anthropic SSE 流实时转成 OpenAI SSE 流。
 * 背压：res.write 返回 false 时暂停上游，drain 后恢复，防止慢客户端把内存撑爆。
 */
export function streamAnthropicToOpenai(
  res: ServerResponse,
  stream: Readable,
  model: string,
  includeUsage: boolean,
  onUsage?: (usage: {
    promptTokens: number;
    completionTokens: number;
    cacheCreationTokens: number;
    cacheReadTokens: number;
  }) => void
): void {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-store",
    connection: "keep-alive",
    "x-accel-buffering": "no"
  });

  let id = "chatcmpl-" + randHex(12);
  let created = nowSec();
  let currentModel = model;
  let buffer = "";
  let roleSent = false;
  let toolIndex = -1;
  let closed = false;
  let finish = "stop";
  const usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  let cacheCreate = 0;
  let cacheRead = 0;

  function write(text: string): void {
    if (res.writableEnded) return;
    if (!res.write(text)) {
      stream.pause();
      res.once("drain", () => stream.resume());
    }
  }

  function chunk(delta: Record<string, unknown>, finishReason?: string): void {
    const obj: Record<string, unknown> = {
      id,
      object: "chat.completion.chunk",
      created,
      model: currentModel,
      choices: [{ index: 0, delta, finish_reason: finishReason === undefined ? null : finishReason }]
    };
    if (includeUsage && finishReason !== undefined) obj.usage = usage;
    write("data: " + JSON.stringify(obj) + "\n\n");
  }

  function closeStream(): void {
    if (closed) return;
    closed = true;
    usage.total_tokens = usage.prompt_tokens + usage.completion_tokens;
    if (onUsage) {
      try {
        onUsage({
          promptTokens: usage.prompt_tokens,
          completionTokens: usage.completion_tokens,
          cacheCreationTokens: cacheCreate,
          cacheReadTokens: cacheRead
        });
      } catch {
        /* 记账失败不影响响应 */
      }
    }
    chunk({}, finish);
    if (!includeUsage) {
      write("data: " + JSON.stringify({
        id,
        object: "chat.completion.chunk",
        created,
        model: currentModel,
        choices: [{ index: 0, delta: {}, finish_reason: null }],
        usage
      }) + "\n\n");
    }
    write("data: [DONE]\n\n");
    res.end();
  }

  function handleEvent(ev: string, data: string): void {
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(data) as Record<string, unknown>;
    } catch {
      return;
    }

    if (ev === "message_start") {
      const msg = obj.message as Record<string, unknown> | undefined;
      if (msg) {
        if (typeof msg.id === "string") id = "chatcmpl-" + msg.id.replace(/[^A-Za-z0-9]/g, "");
        if (typeof msg.model === "string") currentModel = msg.model;
        const mu = msg.usage as
          | { input_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number }
          | undefined;
        if (mu) {
          usage.prompt_tokens = mu.input_tokens ?? 0;
          cacheCreate = mu.cache_creation_input_tokens ?? 0;
          cacheRead = mu.cache_read_input_tokens ?? 0;
        }
      }
      if (!roleSent) {
        roleSent = true;
        chunk({ role: "assistant", content: "" });
      }
      return;
    }

    if (ev === "content_block_start") {
      const cb = obj.content_block as Record<string, unknown> | undefined;
      if (cb && cb.type === "tool_use") {
        toolIndex += 1;
        chunk({
          tool_calls: [{
            index: toolIndex,
            id: cb.id ?? "call_" + randHex(8),
            type: "function",
            function: { name: cb.name ?? "", arguments: "" }
          }]
        });
      }
      return;
    }

    if (ev === "content_block_delta") {
      const d = (obj.delta ?? {}) as Record<string, unknown>;
      if (d.type === "text_delta" && typeof d.text === "string") {
        chunk({ content: d.text });
        return;
      }
      if (d.type === "thinking_delta" && typeof d.thinking === "string") {
        chunk({ reasoning_content: d.thinking });
        return;
      }
      if (d.type === "input_json_delta" && typeof d.partial_json === "string") {
        if (toolIndex < 0) toolIndex = 0;
        chunk({ tool_calls: [{ index: toolIndex, function: { arguments: d.partial_json } }] });
        return;
      }
      return;
    }

    if (ev === "message_delta") {
      const d = obj.delta as { stop_reason?: string } | undefined;
      if (d && d.stop_reason) finish = mapFinish(d.stop_reason);
      const u = obj.usage as { output_tokens?: number } | undefined;
      if (u && u.output_tokens !== undefined) usage.completion_tokens = u.output_tokens;
      return;
    }

    if (ev === "message_stop") {
      closeStream();
      return;
    }

    if (ev === "error") {
      closed = true;
      write("data: " + JSON.stringify({ error: obj.error ?? { message: "upstream error" } }) + "\n\n");
      write("data: [DONE]\n\n");
      res.end();
    }
  }

  function feed(text: string): void {
    buffer += text;
    let idx = buffer.indexOf("\n\n");
    while (idx !== -1) {
      const raw = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      let ev = "message";
      let data = "";
      let lineStart = 0;
      const len = raw.length;
      while (lineStart <= len) {
        let nl = raw.indexOf("\n", lineStart);
        if (nl === -1) nl = len;
        const line = raw.slice(lineStart, nl);
        if (line.startsWith("event:")) ev = line.slice(6).trim();
        else if (line.startsWith("data:")) data += (data ? "\n" : "") + line.slice(5).trim();
        if (nl === len) break;
        lineStart = nl + 1;
      }
      if (data) handleEvent(ev, data);
      idx = buffer.indexOf("\n\n");
    }
  }

  stream.on("data", (c: Buffer | string) => feed(typeof c === "string" ? c : c.toString("utf8")));
  stream.on("end", () => {
    if (buffer.trim()) feed("\n\n");
    closeStream();
  });
  stream.on("error", (e: Error) => {
    if (closed) return;
    closed = true;
    write("data: " + JSON.stringify({ error: { message: e.message } }) + "\n\n");
    write("data: [DONE]\n\n");
    res.end();
  });
}
