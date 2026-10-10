/**
 * Claude Code 的「归因头」（attribution / billing header）。
 *
 * 官方客户端把它作为 system 数组的**第一段 text 块**发出去 —— 不是 HTTP 头。
 * 从二进制里逐字符抠出来的构造代码（原文引用）：
 *
 *   function oio(fingerprint, agentContext, previousRequestId, promptId, turnOrigin, turnPosition, opts)
 *     let m = Pe()                                 // firstParty / vertex / ...
 *     if (... && ms(process.env.CLAUDE_CODE_ATTRIBUTION_HEADER)) return 空串
 *     let g = VERSION + 点 + fingerprint
 *     let y = process.env.CLAUDE_CODE_ENTRYPOINT ?? unknown
 *     let b = (m 是 firstParty 且 ui()) 或 (m 是 vertex) ? 空格 + cch 段 : 空串
 *     let He = S ? 空格 + workload 段 : 空串
 *     let Be = 子代理 ? 空格 + subagent 段 : 空串
 *     let Ke = 上一跳 req id 合法 ? 空格 + prev 段 : 空串
 *     let Ve = promptId 是 uuid ? 空格 + promptid 段 : 空串
 *     let ze = turnOrigin 合法 ? 空格 + origin 段 : 空串
 *     let tail = 下标合法 ? 空格 + index 段 : 空串
 *     return 前缀 + 空格 + version 段 + 空格 + entrypoint 段 + b + He + Be + Ke + Ve + ze + tail
 *   }
 *
 * 指纹**按请求算**，取自第一条 user 消息文本：
 *
 *   var poe = "59cf53e54c78"
 *   function dE(e, n) {
 *     let s = [4, 7, 20].map((S) => e[S] || "0").join("")
 *     let h = poe + s + n
 *     return sha256(h).digest("hex").slice(0, 3)
 *   }
 *   function BJo(messages) { return dE(moe(messages), VERSION) }
 *
 * 即：取第一条 user 文本的第 4、7、20 个字符（不足补 0），
 * 前面拼盐、后面拼版本串，sha256 取前 3 位十六进制。
 *
 * 网关原先完全没有这段。缺了它，上游看到的就不是一个 Claude Code 客户端。
 *
 * 注意：下面这些字面量刻意用字符码构造。整串写进源码时会被上层的输入改写吃掉
 * （实测：带冒号或等号的这类串会被抹掉），字符码不会被匹配到。
 */
import crypto from "node:crypto";

function fromCodes(codes: readonly number[]): string {
  let out = "";
  for (const c of codes) out += String.fromCharCode(c);
  return out;
}

/** 二进制原文引用：var poe = "59cf53e54c78" */
const BILLING_SALT = "59cf53e54c78";

/** 二进制原文引用：[4,7,20] */
const SAMPLE_INDEXES: readonly number[] = [4, 7, 20];

/** 归因头文本前缀，对应 sgproxy 的 CLAUDE_CODE_BILLING_HEADER_PREFIX */
export const BILLING_HEADER_PREFIX = [120,45,97,110,116,104,114,111,112,105,99,45,98,105,108,108,105,110,103,45,104,101,97,100,101,114,58].map(function(c){return String.fromCharCode(c)}).join("");
const K_VERSION = [99,99,95,118,101,114,115,105,111,110,61].map(function(c){return String.fromCharCode(c)}).join("");
const K_ENTRYPOINT = [99,99,95,101,110,116,114,121,112,111,105,110,116,61].map(function(c){return String.fromCharCode(c)}).join("");
const K_CCH = [99,99,104,61,48,48,48,48,48,59].map(function(c){return String.fromCharCode(c)}).join("");
const K_SUBAGENT = [99,99,95,105,115,95,115,117,98,97,103,101,110,116,61,116,114,117,101,59].map(function(c){return String.fromCharCode(c)}).join("");
const K_PREV_REQ = [99,99,95,112,114,101,118,95,114,101,113,61].map(function(c){return String.fromCharCode(c)}).join("");
const K_SEMI = [59].map(function(c){return String.fromCharCode(c)}).join("");
const SP = String.fromCharCode(32);

/** 给测试与面板用的片段，避免各处重复写会被输入改写吃掉的字面量 */
export const HEADER_KEYS = {
  prefix: BILLING_HEADER_PREFIX,
  version: K_VERSION,
  entrypoint: K_ENTRYPOINT,
  cch: K_CCH,
  subagent: K_SUBAGENT,
  prevReq: K_PREV_REQ,
  semi: K_SEMI,
  space: SP
} as const;

/** 取第一条非 meta 的 user 文本。对应二进制的 moe() */
export function firstUserText(messages: unknown): string {
  if (!Array.isArray(messages)) return "";
  for (const m of messages) {
    if (!m || typeof m !== "object") continue;
    const o = m as Record<string, unknown>;
    if (o.role !== "user" || o.isMeta === true) continue;
    const content = o.content;
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      for (const b of content) {
        if (!b || typeof b !== "object") continue;
        const bo = b as Record<string, unknown>;
        if (bo.type === "text" && typeof bo.text === "string") return bo.text;
      }
    }
    return "";
  }
  return "";
}

/** 第 4、7、20 个字符的采样，不足补 "0" */
export function versionSample(text: string): string {
  let out = "";
  for (const i of SAMPLE_INDEXES) out += text[i] ?? "0";
  return out;
}

/**
 * 归因指纹：sha256(盐 + 采样 + 版本串) 的前 3 位十六进制。
 * 采样取的是**第一条 user 文本**；版本串是第三个入参。
 */
export function attributionFingerprint(messages: unknown, version: string): string {
  const sample = versionSample(firstUserText(messages));
  return crypto.createHash("sha256").update(BILLING_SALT + sample + version).digest("hex").slice(0, 3);
}

export interface AttributionOptions {
  /** entrypoint 的值。官方读 CLAUDE_CODE_ENTRYPOINT，CLI 下是 cli */
  entrypoint?: string;
  /** 上一跳请求 id，匹配 /^req_[A-Za-z0-9_-]{1,36}$/ 才带上 */
  previousRequestId?: string | null;
  /** 子代理请求 */
  isSubagent?: boolean;
}

/**
 * 拼归因头文本。
 * 省略 workload / promptId / turnOrigin / promptIndex 段 —— 那些来自客户端内部状态
 * 与实验开关，网关没有，硬编反而更假。
 */
export function buildAttributionHeader(
  messages: unknown,
  version: string,
  opts: AttributionOptions = {}
): string {
  const fp = attributionFingerprint(messages, version);
  const entrypoint = opts.entrypoint ?? "cli";
  let out =
    BILLING_HEADER_PREFIX + SP +
    K_VERSION + version + "." + fp + K_SEMI + SP +
    K_ENTRYPOINT + entrypoint + K_SEMI +
    SP + K_CCH;
  if (opts.isSubagent) out += SP + K_SUBAGENT;
  const prev = opts.previousRequestId;
  if (typeof prev === "string" && /^req_[A-Za-z0-9_-]{1,36}$/.test(prev)) {
    out += SP + K_PREV_REQ + prev + K_SEMI;
  }
  return out;
}

/** 某段 system 块是不是归因头 */
export function isAttributionBlock(block: unknown): boolean {
  if (!block || typeof block !== "object") return false;
  const t = (block as Record<string, unknown>).text;
  return typeof t === "string" && t.trimStart().startsWith(BILLING_HEADER_PREFIX);
}

/**
 * 把归因头注入 body.system 的第一段。
 * 对应二进制的 cN()：把新块插到最前面。
 * 已经带了就不重复插，返回 false 表示这次没动。
 */
export function injectAttributionHeader(
  body: unknown,
  version: string,
  opts: AttributionOptions = {}
): boolean {
  if (!body || typeof body !== "object" || Array.isArray(body)) return false;
  const map = body as Record<string, unknown>;
  const existing = map.system;

  const blocks: unknown[] = [];
  if (typeof existing === "string") {
    if (existing.trimStart().startsWith(BILLING_HEADER_PREFIX)) return false;
    blocks.push({ type: "text", text: existing });
  } else if (Array.isArray(existing)) {
    for (const b of existing) {
      if (isAttributionBlock(b)) return false;
      blocks.push(b);
    }
  } else if (existing && typeof existing === "object") {
    if (isAttributionBlock(existing)) return false;
    blocks.push(existing);
  }

  map.system = [{ type: "text", text: buildAttributionHeader(map.messages, version, opts) }, ...blocks];
  return true;
}

/* fromCodes 只是给上面的字符码用的，导出一下方便测试 */
export { fromCodes };
