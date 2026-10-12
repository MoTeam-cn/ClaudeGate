import type { Config, ModelLimit } from "../types.ts";
import { DEFAULT_IMAGE_TOKENS, imageBase64, imageTokens, isImageBlock } from "./image.ts";
import { limitFor } from "./spec.ts";

/** 输入 token 估算与超限检查 */

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
export function estimateInputTokens(value: unknown, imageCap: number = DEFAULT_IMAGE_TOKENS): number {
  if (typeof value === "string") return countText(value);
  if (typeof value === "number" || typeof value === "boolean") return 1;
  if (Array.isArray(value)) {
    let sum = 0;
    for (const v of value) sum += estimateInputTokens(v, imageCap);
    return sum;
  }
  if (value && typeof value === "object") {
    const o = value as Record<string, unknown>;
    if (isImageBlock(o)) return imageTokens(imageBase64(o), imageCap);
    let sum = 0;
    for (const [k, v] of Object.entries(o)) sum += countText(k) + estimateInputTokens(v, imageCap);
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
  const estimated = estimateInputTokens(body, cfg.imageMaxTokens);
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

