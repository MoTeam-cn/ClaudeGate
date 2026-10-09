import { resolveModel } from "../models.ts";
import { clampInt, safeJson, randHex, toStr } from "../utils.ts";
import { textOf, imageBlock, toolToAnthropic, mapToolChoice } from "./shared.ts";
import type { AnthropicContentBlock, AnthropicMessage, AnthropicRequest, Config, OpenAIChatRequest, OpenAIMessage } from "../types.ts";

/** OpenAI Chat Completions 请求体 -> Anthropic Messages 请求体 */
export function openaiToAnthropic(input: OpenAIChatRequest, cfg: Config): AnthropicRequest {
  const sys: string[] = [];
  const msgs: AnthropicMessage[] = [];
  const list: OpenAIMessage[] = Array.isArray(input.messages) ? input.messages : [];

  for (const m of list) {
    const role = m.role;

    if (role === "system" || role === "developer") {
      const st = textOf(m.content);
      if (st) sys.push(st);
      continue;
    }

    if (role === "tool") {
      msgs.push({
        role: "user",
        content: [{
          type: "tool_result",
          tool_use_id: toStr(m.tool_call_id),
          content: textOf(m.content)
        }]
      });
      continue;
    }

    if (role === "assistant") {
      const blocks: AnthropicContentBlock[] = [];
      const at = textOf(m.content);
      if (at) blocks.push({ type: "text", text: at });
      const tcs = Array.isArray(m.tool_calls) ? m.tool_calls : [];
      for (const tc of tcs) {
        blocks.push({
          type: "tool_use",
          id: tc.id || "toolu_" + randHex(10),
          name: toStr(tc.function?.name),
          input: safeJson(toStr(tc.function?.arguments))
        });
      }
      if (blocks.length) msgs.push({ role: "assistant", content: blocks });
      continue;
    }

    /* user */
    const c = m.content;
    if (typeof c === "string") {
      msgs.push({ role: "user", content: c });
      continue;
    }

    const ub: AnthropicContentBlock[] = [];
    const arr = Array.isArray(c) ? c : [];
    for (const p of arr) {
      if (!p || typeof p !== "object") continue;
      const part = p as Record<string, unknown>;
      if (part.type === "text" || part.type === "input_text") {
        ub.push({ type: "text", text: toStr(part.text) });
      } else if (part.type === "image_url") {
        const iu = part.image_url as Record<string, unknown> | undefined;
        ub.push(imageBlock(toStr(iu?.url)));
      }
    }
    msgs.push({ role: "user", content: ub.length ? ub : textOf(c) });
  }

  const out: AnthropicRequest = {
    model: resolveModel(input.model, cfg),
    messages: msgs
  };
  if (sys.length) out.system = sys.join("\n\n");
  out.max_tokens = clampInt(
    input.max_tokens !== undefined ? input.max_tokens : input.max_completion_tokens,
    cfg.maxTokensDefault,
    1,
    64000
  );
  if (typeof input.temperature === "number") out.temperature = input.temperature;
  if (typeof input.top_p === "number") out.top_p = input.top_p;
  if (typeof input.top_k === "number") out.top_k = input.top_k;
  if (input.stop) out.stop_sequences = Array.isArray(input.stop) ? input.stop : [input.stop];
  if (input.metadata) out.metadata = input.metadata;

  if (Array.isArray(input.tools) && input.tools.length) {
    const tchoice = mapToolChoice(input.tool_choice);
    if (!tchoice || tchoice.type !== "none") {
      out.tools = input.tools.map(toolToAnthropic);
      if (tchoice) out.tool_choice = tchoice;
    }
  }

  if (input.stream) out.stream = true;
  return out;
}
