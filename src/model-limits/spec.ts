import type { Config, ModelLimit } from "../types.ts";

/** 模型限制的语法与查表：<模型>=<上下文>[/<最大输出>]，逗号分隔，* 兜底 */

export function normalizeLimitKey(raw: unknown): string {
  return String(raw ?? "")
    .trim()
    .toLowerCase()
    .replace(/\[1m\]$/, "")
    .replace(/-\d{8}$/, "");
}

/** 解析一个尺寸值。支持 256000 / 256k / 1m / 256（100-1000 视为 k） */
export function parseSize(raw: string): number | null {
  const s = raw.trim().toLowerCase();
  if (!s) return null;
  let n: number;
  if (s.endsWith("m")) n = parseFloat(s) * 1e6;
  else if (s.endsWith("k")) n = parseFloat(s) * 1000;
  else {
    const v = Number(s);
    if (!Number.isFinite(v)) return null;
    /* 裸数字 100-1000 当 k 用，跟 /autocompact 的写法保持一致 */
    n = v >= 100 && v <= 1000 ? v * 1000 : v;
  }
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n);
}

/**
 * 解析 MODEL_LIMITS。
 * 语法：model=context[/maxOutput] ，逗号分隔。坏条目跳过而不是整体报错 ——
 * 一个手滑的逗号不该让网关起不来。
 */
export function parseModelLimits(raw: string | undefined): Record<string, ModelLimit> {
  const out: Record<string, ModelLimit> = {};
  for (const piece of String(raw ?? "").split(",")) {
    const item = piece.trim();
    if (!item) continue;
    const eq = item.indexOf("=");
    if (eq <= 0) continue;
    const key = normalizeLimitKey(item.slice(0, eq));
    const rhs = item.slice(eq + 1).trim();
    if (!key || !rhs) continue;
    const slash = rhs.indexOf("/");
    const ctxRaw = slash === -1 ? rhs : rhs.slice(0, slash);
    const outRaw = slash === -1 ? "" : rhs.slice(slash + 1);
    const context = parseSize(ctxRaw);
    if (context === null) continue;
    const maxOutput = outRaw ? parseSize(outRaw) : null;
    out[key] = { context, maxOutput };
  }
  return out;
}

/**
 * 解析面板存的 JSON。形状就是 Record<模型名, {context, maxOutput}>。
 * 存坏了当空 —— 一个设置项不该让整条限制链失效。
 */
export function parseLimitsSetting(raw: unknown): Record<string, ModelLimit> {
  if (typeof raw !== "string" || !raw.trim()) return {};
  let v: unknown;
  try { v = JSON.parse(raw); } catch { return {}; }
  if (!v || typeof v !== "object" || Array.isArray(v)) return {};
  const out: Record<string, ModelLimit> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (!val || typeof val !== "object") continue;
    const o = val as Record<string, unknown>;
    const context = Number(o.context);
    if (!Number.isFinite(context) || context <= 0) continue;
    const rawOut = o.maxOutput;
    const maxOutput = rawOut === null || rawOut === undefined || rawOut === ""
      ? null
      : (Number.isFinite(Number(rawOut)) && Number(rawOut) > 0 ? Math.round(Number(rawOut)) : null);
    out[normalizeLimitKey(k)] = { context: Math.round(context), maxOutput };
  }
  return out;
}

/** 面板设置覆盖 env 配置：同一个模型以面板为准 */
export function mergeLimits(
  base: Record<string, ModelLimit>,
  override: Record<string, ModelLimit>
): Record<string, ModelLimit> {
  return { ...base, ...override };
}

/** 取某个模型的限制；精确匹配优先，其次 "*" 兜底 */
export function limitFor(cfg: Config, model: unknown): ModelLimit | null {
  const key = normalizeLimitKey(model);
  return cfg.modelLimits[key] ?? cfg.modelLimits["*"] ?? null;
}

/**
 * 图片的 token 计价。
 *
 * 官方口径（二进制里从模型配置抠出来的，原文引用）：
 *   claude-haiku-4-5   image_limits:{ max_width:1568, max_height:1568, max_image_tokens:1568 }
 *   claude-opus-5-5    image_limits:{ max_width:2576, max_height:2576, max_image_tokens:4784 }
 *   claude-sonnet-5-5  image_limits:{ max_width:2576, max_height:2576, max_image_tokens:4784 }
 *
 * 即**上限是按模型给的**，不是一个常数。上限之下按像素算：
 *   约 宽 × 高 / 750，再夹到 max_image_tokens。
 * 客户端拿到的 image_limits 是服务端下发的（models.retrieve 的 runtime.image_limits），
 * 网关没有这条通道，所以用一个可配的默认值，取常见档位 1600。
 *
 * 我们没有解码能力 → 现在有了：从 base64 头部读宽高（PNG / JPEG / GIF），
 * 读不出来才退回上限。无论如何都**绝不能把 base64 当文本算**，那会差三个数量级。
 */

