import type { AnthropicContentBlock } from "../types.ts";

export function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    let out = "";
    for (const p of content) {
      if (typeof p === "string") out += p;
      else if (p && typeof p === "object" && (p as AnthropicContentBlock).type === "text") {
        out += (p as AnthropicContentBlock).text ?? "";
      }
    }
    return out;
  }
  if (content && typeof content === "object" && (content as AnthropicContentBlock).type === "text") {
    return (content as AnthropicContentBlock).text ?? "";
  }
  return "";
}

export function imageBlock(url: string): AnthropicContentBlock {
  const m = /^data:([^;]+);base64,(.*)$/.exec(String(url ?? ""));
  if (m) return { type: "image", source: { type: "base64", media_type: m[1], data: m[2] } };
  return { type: "image", source: { type: "url", url: String(url ?? "") } };
}

export function toolToAnthropic(t: Record<string, unknown>): Record<string, unknown> {
  const f = (t.function as Record<string, unknown>) ?? t;
  const out: Record<string, unknown> = {
    name: f.name ?? "",
    input_schema: f.parameters ?? { type: "object", properties: {} }
  };
  if (f.description) out.description = f.description;
  return out;
}

export function mapToolChoice(tc: unknown): Record<string, unknown> | null {
  if (!tc) return null;
  if (typeof tc === "string") {
    if (tc === "auto") return { type: "auto" };
    if (tc === "required" || tc === "any") return { type: "any" };
    if (tc === "none") return { type: "none" };
    return null;
  }
  if (typeof tc === "object") {
    const o = tc as Record<string, unknown>;
    if (o.type === "function") {
      const fn = o.function as Record<string, unknown> | undefined;
      if (fn && fn.name) return { type: "tool", name: fn.name };
    }
    if (o.type === "any") return { type: "any" };
    if (o.type === "auto") return { type: "auto" };
  }
  return null;
}

export function mapFinish(reason: string | undefined): string {
  if (reason === "end_turn" || reason === "stop_sequence") return "stop";
  if (reason === "max_tokens") return "length";
  if (reason === "tool_use") return "tool_calls";
  return reason ?? "stop";
}

export function anthropicUsageToOpenai(u: { input_tokens?: number; output_tokens?: number } | undefined): {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
} {
  const input = u?.input_tokens ?? 0;
  const output = u?.output_tokens ?? 0;
  return { prompt_tokens: input, completion_tokens: output, total_tokens: input + output };
}
