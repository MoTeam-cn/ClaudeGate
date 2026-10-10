/**
 * 请求体身份校验：确认调用方确实是 Claude Code，而不是手搓的脚本。
 *
 * 为什么不查 system[0]（归因头）：
 * 归因头是**网关自己补的**（proxy.ts 调 injectAttributionHeader），
 * 拿一个自己会填的东西当判据等于没查 —— 任何客户端都能过。
 * 身份行网关不补，所以它才是真判据。
 *
 * 但归因头也不是完全不查：injectAttributionHeader 看到前缀就认为「已有」而不再注入，
 * 于是伪造一个**只有前缀的空壳**就能把真正的归因头顶掉。
 * 所以 system[0] 做结构校验（前缀 + cc_version + cc_entrypoint + 指纹段），
 * 形状不对就判失败 —— 这一条同时堵住了上面那个绕过。
 *
 * 身份行三个变体（二进制原文引用，三段在字符串池里是连着的）：
 *   You are Claude Code, Anthropic's official CLI tool for Claude.
 *   You are Claude Code, Anthropic's official CLI tool for Claude, running within the Claude Agent SDK.
 *   You are a Claude agent, built on Anthropic's Claude Agent SDK.
 * 第一段是交互式 CLI；第二段是非交互 + append；第三段是非交互不 append。
 *
 * 注意这是**提高门槛**，不是安全边界。真下决心的人照样能照着抄。
 * 目标是挡掉「随手 curl 一下」和「拿别的客户端蹭」这类，不是防定向攻击。
 */
import { BILLING_HEADER_PREFIX, HEADER_KEYS } from "../fingerprint/attribution.ts";

/** 身份行的三个合法变体。撇号用 \u0027 写，免得被上层的输入改写吃掉 */
export const IDENTITY_LINES: readonly string[] = [
  "You are Claude Code, Anthropic\u0027s official CLI tool for Claude.",
  "You are Claude Code, Anthropic\u0027s official CLI tool for Claude, running within the Claude Agent SDK.",
  "You are a Claude agent, built on Anthropic\u0027s Claude Agent SDK."
];

/** 归因头里的指纹段：版本后面跟一个点和三位十六进制，以分号收尾 */
const FINGERPRINT_RE = /\.[0-9a-f]{3};/;

/** 取 system 里每段的文本 */
export function systemTexts(system: unknown): string[] {
  const out: string[] = [];
  if (typeof system === "string") {
    out.push(system);
    return out;
  }
  if (Array.isArray(system)) {
    for (const b of system) {
      if (typeof b === "string") out.push(b);
      else if (b && typeof b === "object") {
        const t = (b as Record<string, unknown>).text;
        if (typeof t === "string") out.push(t);
      }
    }
    return out;
  }
  if (system && typeof system === "object") {
    const t = (system as Record<string, unknown>).text;
    if (typeof t === "string") out.push(t);
  }
  return out;
}

/** 归因头是不是一个**完整**的形状，而不是只有前缀的空壳 */
export function isWellFormedAttribution(text: string): boolean {
  if (!text.trimStart().startsWith(BILLING_HEADER_PREFIX)) return false;
  return (
    text.includes(HEADER_KEYS.version) &&
    text.includes(HEADER_KEYS.entrypoint) &&
    FINGERPRINT_RE.test(text)
  );
}

/**
 * 有没有身份行。
 *
 * **用子串匹配，不要求整块相等。** 真客户端把身份行和日期行拼在**同一个文本块**里
 * （日期行是单独拼的，二进制原文引用：`Today's date is ` + 日期），
 * 早先写成整块相等，结果把真 Claude Code 自己挡在了外面（线上 403）。
 * 子串匹配不会削弱判据 —— 想伪造的人本来就能把这一整句原样发过来。
 */
export function hasIdentityLine(texts: readonly string[]): boolean {
  for (const t of texts) {
    for (const line of IDENTITY_LINES) if (t.indexOf(line) !== -1) return true;
  }
  return false;
}

/**
 * system 各段的摘要，**只用于日志**。
 * 判据失配时得看得见客户端到底发了什么，否则只能猜。
 * 绝不放进给客户端的错误响应里。
 */
export function systemDigest(texts: readonly string[], per = 120): string {
  if (!texts.length) return "(system 为空)";
  return texts
    .slice(0, 4)
    .map((t, i) => "#" + i + "[" + t.length + "] " + t.slice(0, per).replace(/\s+/g, " "))
    .join(" | ");
}

export interface IdentityCheck {
  ok: boolean;
  /** 失败原因，ok 为 true 时是空串 */
  reason: string;
}

/**
 * 校验请求体。只看两件事：归因头形状 + 身份行存在。
 * 不做别的猜测 —— 判据越少越不容易误伤真客户端。
 */
export function checkIdentity(body: unknown): IdentityCheck {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, reason: "请求体不是 JSON 对象。" };
  }
  const map = body as Record<string, unknown>;
  const texts = systemTexts(map.system);

  if (!texts.length) {
    return { ok: false, reason: "请求里没有 system 字段 —— Claude Code 一定会带。" };
  }

  /* 归因头：网关会补，所以只有「客户端塞了假块把注入顶掉」才会走到这里 */
  if (!isWellFormedAttribution(texts[0] ?? "")) {
    return {
      ok: false,
      reason: "system 首段不是合法的 Claude Code 归因头。"
    };
  }

  if (!hasIdentityLine(texts)) {
    return {
      ok: false,
      reason: "system 里没有 Claude Code 身份行。"
    };
  }

  return { ok: true, reason: "" };
}
