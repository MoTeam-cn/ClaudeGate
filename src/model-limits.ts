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
 * 估算请求体的输入 token。
 *
 * 没有分词器，只能按字节构成估：ASCII 约 4 字符一个 token，
 * 非 ASCII（中文等）约 1.5 字符一个 token。宁可估高不估低 ——
 * 低估会放过超限请求，高估只是提前拦一点。
 *
 * 这里量的是**整个请求体**（system + messages + tools），
 * 这些全都是要计费的输入，跟客户端 usage 里的
 * input_tokens + cache_creation + cache_read 是同一批东西。
 */
export function estimateInputTokens(text: string): number {
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
}

/**
 * 每次调用都查一遍。
 * 没给这个模型配窗口就放行 —— 不配置等于不限制，别替用户做主。
 */
export function checkContext(cfg: Config, model: unknown, bodyText: string): ContextCheck {
  const limit = limitFor(cfg, model);
  const estimated = estimateInputTokens(bodyText);
  if (!limit) return { ok: true, estimated, limit: null, ceiling: null, reason: "" };

  const ceiling = Math.floor(limit.context * (1 + cfg.contextHeadroom));
  if (estimated <= ceiling) return { ok: true, estimated, limit, ceiling, reason: "" };

  const pct = limit.context > 0 ? Math.round((estimated / limit.context) * 100) : 0;
  return {
    ok: false,
    estimated,
    limit,
    ceiling,
    reason:
      "这次请求的输入约 " + estimated + " tokens，已经超过 " + String(model) +
      " 的上下文窗口 " + limit.context + "（约 " + pct + "%，容差 " +
      Math.round(cfg.contextHeadroom * 100) + "%）。" +
      "请先压缩会话（/compact）或开新会话再继续。"
  };
}
