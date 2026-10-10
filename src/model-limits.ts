/**
 * 每个模型的上下文窗口与最大输出。
 *
 * 为什么网关要管这个：
 * Claude Code 的自动压缩窗口是**按模型名**去它自己的目录里查的 ——
 * 查得到就用目录的值（claude-opus-5-5 是 1M），查不到才用通用兜底。
 * 我们实际打到上游的是第三方模型，窗口跟名字对不上，于是会话能一路长到
 * 几十万都不压缩。客户端那边可以用 CLAUDE_CODE_AUTO_COMPACT_WINDOW 钉死，
 * 但那是每台机器配一遍；**网关这边钉死才是唯一真相源**。
 *
 * 配置语法（MODEL_LIMITS）：
 *   <模型>=<上下文>[/<最大输出>] , <模型>=<上下文> ...
 *   "*" 作为兜底项。例：
 *     MODEL_LIMITS="*=256000,claude-opus-5-5=1000000/128000"
 *   带不带 [1m] 后缀、带不带日期后缀，都算同一个模型。
 *
 * 检查（每次调用，发上游之前）：
 *   估算这次请求的输入 token，超过「上下文 × (1 + 余量)」就拒绝。
 *   余量默认 10% —— 客户端的计数跟真实计数不会完全一致，
 *   卡死在正好 256K 会把压缩前后的正常请求也一起打掉。
 */
import type { Config, ModelLimit } from "./types.ts";

/** 归一化成可比的 key：小写、去 [1m] 后缀、去日期后缀 */
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
 * 单张图片的估算成本。
 * Claude 对图片是按尺寸计的（约 宽 × 高 / 750），上限约 1600 token。
 * 我们没有解码能力，取上限最稳 —— 图片数量不会太多，多算一点无所谓；
 * 但**绝不能把 base64 当文本算**，那会差出三个数量级。
 */
export const IMAGE_TOKENS = 1600;

/** 是不是一个图片块。Anthropic 是 {type:image,source:{type:base64|url}}，OpenAI 是 {type:image_url} */
function isImageBlock(o: Record<string, unknown>): boolean {
  if (o.type === "image" || o.type === "image_url") return true;
  const src = o.source;
  if (src && typeof src === "object") {
    const t = (src as Record<string, unknown>).type;
    if (t === "base64" || t === "url") return true;
  }
  return false;
}

/** 纯文本的字符构成估算：ASCII 约 4 字符一个 token，非 ASCII 约 1.5 字符一个 */
function countText(text: string): number {
  let ascii = 0;
  let wide = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 0x80) ascii++;
    else {
      wide++;
      /* 代理对算一个字符 */
      if (c >= 0xd800 && c <= 0xdbff) i++;
    }
  }
  return Math.ceil(ascii / 4 + wide / 1.5);
}

/**
 * 估算请求体的输入 token。**结构化遍历，不是把 body 序列化成字符串数字符。**
 *
 * 为什么必须结构化：把整个 body 当文本数，图片的 base64 会被按
 * 「4 字符一 token」算进去。一张 1.5MB 的 PNG 编码后约 140 万字符，
 * 于是估出 35 万 token —— 而它真实只值约 1600 token。
 * 客户端知道图不是文本，我们不知道，结果就是**误报超限**：
 * 客户端认为还在 43%（不压缩），网关却以为爆了，把正常请求打掉。
 * 实测差 3.2 倍（客户端 110.8k vs 网关 350878）。
 *
 * 文本部分仍然是：ASCII 约 4 字符一个 token，非 ASCII 约 1.5 字符一个。
 * 键名也算 —— 真分词器就是这么算的。
 */
export function estimateInputTokens(value: unknown): number {
  if (typeof value === "string") return countText(value);
  if (typeof value === "number" || typeof value === "boolean") return 1;
  if (Array.isArray(value)) {
    let sum = 0;
    for (const v of value) sum += estimateInputTokens(v);
    return sum;
  }
  if (value && typeof value === "object") {
    const o = value as Record<string, unknown>;
    if (isImageBlock(o)) return IMAGE_TOKENS;
    let sum = 0;
    for (const [k, v] of Object.entries(o)) sum += countText(k) + estimateInputTokens(v);
    return sum;
  }
  return 0;
}

/**
 * /compact 压缩请求的特征串。
 *
 * 压缩这件事本身就要把**整个超长上下文**发给上游 —— 如果连它也拦，
 * 用户就被锁死了：上下文超限 → 压缩被拒 → 唯一出路是 /clear（上下文全丢）。
 * 所以压缩请求永远放行，限制只拦正常对话。
 *
 * 这段提示词是从二进制里还原的（原文引用）：
 *   Your task is to create a detailed summary of the conversation so far,
 *   paying close attention to the user's explicit requests and your previous actions.
 */
const COMPACT_MARKER = "create a detailed summary of the conversation so far";

export function isCompactionRequest(body: unknown): boolean {
  if (typeof body === "string") return body.indexOf(COMPACT_MARKER) !== -1;
  if (!body || typeof body !== "object") return false;
  const sys = (body as Record<string, unknown>).system;
  const blocks = Array.isArray(sys) ? sys : [sys];
  for (const b of blocks) {
    const t = typeof b === "string" ? b : (b && typeof b === "object" ? (b as Record<string, unknown>).text : "");
    if (typeof t === "string" && t.indexOf(COMPACT_MARKER) !== -1) return true;
  }
  return false;
}

export interface ContextCheck {
  ok: boolean;
  /** 这次请求的输入 token 估算值 */
  estimated: number;
  /** 生效的窗口；没有配置时为 null */
  limit: ModelLimit | null;
  /** 允许的上限（窗口 × (1 + 余量)） */
  ceiling: number | null;
  /** 拒绝原因，ok 为 true 时是空串 */
  reason: string;
  /** 这是 /compact 压缩请求，按设计跳过检查 */
  compaction: boolean;
}

/**
 * 每次调用都查一遍。
 * 没给这个模型配窗口就放行 —— 不配置等于不限制，别替用户做主。
 */
export function checkContext(cfg: Config, model: unknown, body: unknown): ContextCheck {
  const limit = limitFor(cfg, model);
  const estimated = estimateInputTokens(body);
  if (!limit) return { ok: true, estimated, limit: null, ceiling: null, reason: "", compaction: false };

  /*
   * 压缩请求放行。拦它等于把用户锁死 —— 上下文已经超了，压缩是唯一的自救手段，
   * 这时候回 400 只会让人只能 /clear。压缩完上下文就小了，下一轮自然回到限制内。
   */
  if (isCompactionRequest(body)) {
    return { ok: true, estimated, limit, ceiling: null, reason: "", compaction: true };
  }

  const ceiling = Math.floor(limit.context * (1 + cfg.contextHeadroom));
  if (estimated <= ceiling) return { ok: true, estimated, limit, ceiling, reason: "", compaction: false };

  const pct = limit.context > 0 ? Math.round((estimated / limit.context) * 100) : 0;
  return {
    ok: false,
    estimated,
    limit,
    ceiling,
    compaction: false,
    reason:
      "这次请求的输入约 " + estimated + " tokens，已经超过 " + String(model) +
      " 的上下文窗口 " + limit.context + "（约 " + pct + "%，容差 " +
      Math.round(cfg.contextHeadroom * 100) + "%）。" +
      "请先压缩会话（/compact）或开新会话再继续。"
  };
}
