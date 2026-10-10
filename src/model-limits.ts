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
export const DEFAULT_IMAGE_TOKENS = 1600;

/** 像素到 token 的除数。Anthropic 文档口径：约 750 像素一个 token */
const PIXELS_PER_TOKEN = 750;

/**
 * 从 base64 图片里读宽高。只认 PNG / JPEG / GIF —— 这三种覆盖绝大多数情况。
 * 只解前 2KB，不整张解码。读不出来返回 null。
 */
export function readImageSize(b64: string): { width: number; height: number } | null {
  let head: Buffer;
  try {
    head = Buffer.from(b64.slice(0, 2048), "base64");
  } catch {
    return null;
  }
  /* 各格式需要的最小长度不同，逐个校验，别用一个大阈值把短的挡掉 */
  if (head.length < 10) return null;

  /* PNG：签名 8 字节，接着是 IHDR —— 宽高在偏移 16 / 20，大端 */
  if (head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47) {
    if (head.length < 24) return null;
    const w = head.readUInt32BE(16);
    const h = head.readUInt32BE(20);
    return w > 0 && h > 0 ? { width: w, height: h } : null;
  }

  /* GIF：GIF87a / GIF89a，宽高在偏移 6 / 8，小端 */
  if (head[0] === 0x47 && head[1] === 0x49 && head[2] === 0x46) {
    const w = head.readUInt16LE(6);
    const h = head.readUInt16LE(8);
    return w > 0 && h > 0 ? { width: w, height: h } : null;
  }

  /* JPEG：从 SOI 往后扫段，找到 SOFn 就是尺寸 */
  if (head[0] === 0xff && head[1] === 0xd8) {
    let i = 2;
    while (i + 9 < head.length) {
      if (head[i] !== 0xff) { i++; continue; }
      const marker = head[i + 1] ?? 0;
      /* 填充字节 */
      if (marker === 0xff) { i++; continue; }
      /* SOF0..SOF15，但 C4(DHT) / C8(JPG) / CC(DAC) 不是 */
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        const h = head.readUInt16BE(i + 5);
        const w = head.readUInt16BE(i + 7);
        return w > 0 && h > 0 ? { width: w, height: h } : null;
      }
      const len = head.readUInt16BE(i + 2);
      if (len < 2) break;
      i += 2 + len;
    }
    return null;
  }

  return null;
}

/** 一张图值多少 token：按像素算，夹到上限 */
export function imageTokens(b64: string | null, cap: number): number {
  if (!b64) return cap;
  const size = readImageSize(b64);
  if (!size) return cap;
  const byPixels = Math.ceil((size.width * size.height) / PIXELS_PER_TOKEN);
  return Math.max(1, Math.min(cap, byPixels));
}

/**
 * 取出图片块里的 base64。Anthropic 是 {type:image,source:{type:base64,data}}，
 * OpenAI 是 {type:image_url,image_url:{url:"data:image/png;base64,..."}}。
 * 不是 base64 图（比如 http URL）返回 null。
 */
export function imageBase64(o: Record<string, unknown>): string | null {
  if (o.type === "image_url") {
    const iu = o.image_url;
    if (iu && typeof iu === "object") {
      const url = (iu as Record<string, unknown>).url;
      if (typeof url === "string") {
        const i = url.indexOf("base64,");
        if (i !== -1) return url.slice(i + 7);
      }
    }
    return null;
  }
  const src = o.source;
  if (src && typeof src === "object") {
    const s = src as Record<string, unknown>;
    if (s.type === "base64" && typeof s.data === "string") return s.data;
  }
  return null;
}

/** 是不是一个图片块 */
export function isImageBlock(o: Record<string, unknown>): boolean {
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
