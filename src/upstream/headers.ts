import { HOP_BY_HOP, RESPONSE_DROP_HEADERS, DECODED_ENCODINGS, ANTHROPIC_VERSION, AUTH_HEADER_NAMES } from "../constants.ts";
import { mergeBeta, upstreamAuthHeaders } from "../oauth.ts";
import { injectCanonicalHeaders, injectFingerprintHeaders, fingerprintSeed } from "../guard.ts";
import { applyCanonicalHeaders } from "../fingerprint/canonical.ts";
import { headerValue } from "../utils.ts";
import type { Readable } from "node:stream";
import type { IncomingMessage } from "node:http";
import type { Account, AuthState, Config, UpstreamResponse } from "../types.ts";
/** 组装要回写给客户端的响应头：只丢必须丢的，其余原样透传 */
export function passThroughHeaders(up: UpstreamResponse): Record<string, string | number | string[]> {
  const headers: Record<string, string | number | string[]> = {};
  const enc = String(up.headers["content-encoding"] ?? "").toLowerCase();
  const decoded = DECODED_ENCODINGS.has(enc);
  for (const [k, v] of Object.entries(up.headers)) {
    if (v === undefined) continue;
    const lk = k.toLowerCase();
    if (RESPONSE_DROP_HEADERS.has(lk)) continue;
    /* 只有我们真解压了才敢丢 content-encoding，否则下游拿到的是压缩体却没有标记 */
    if (lk === "content-encoding" && !decoded) continue;
    headers[k] = v;
  }
  if (!headers["cache-control"]) headers["cache-control"] = "no-store";
  if (!headers["content-type"]) headers["content-type"] = "application/json";
  return headers;
}

/**
 * 组装上游请求头：客户端头原样透传（指纹保真），只替换认证头，并按需注入规范头。
 */
export function buildUpstreamHeaders(
  req: IncomingMessage,
  auth: AuthState,
  cfg: Config,
  account: Account | null
): Record<string, string | string[] | undefined> {
  /* 用 rawHeaders 而不是 headers：前者保留客户端发来的原始顺序与大小写。
     HTTP 头的顺序本身是可观测的指纹，打乱它等于白做保真。 */
  const source = req.rawHeaders;
  const entries: Array<{ name: string; value: string }> = [];
  let authSlot = -1;

  for (let i = 0; i + 1 < source.length; i += 2) {
    const name = source[i];
    const lk = name.toLowerCase();
    /* 凭据头要先判：它不在逐跳集合里，但万一有人加回去也不能被吃掉 */
    if (AUTH_HEADER_NAMES.has(lk)) {
      /* 记住第一个凭据头的位置，稍后原地换成我们的凭据 */
      if (authSlot === -1) authSlot = entries.length;
      continue;
    }
    if (HOP_BY_HOP.has(lk)) continue;
    /* connection 保位置但值归一：上游连接是复用的，客户端说 close 也不能真关 */
    if (lk === "connection") {
      entries.push({ name, value: "keep-alive" });
      continue;
    }
    entries.push({ name, value: source[i + 1] });
  }

  /* 先落成对象，让规范头注入按老逻辑跑（它只补缺失项，不改顺序） */
  let headers: Record<string, string | string[] | undefined> = {};
  for (const e of entries) headers[e.name] = e.value;

  /* 指纹头（anthropic-version / anthropic-beta / x-claude-code-session-id）任何模式下都补。
     它们是网关的职责：session-id 从 Key 种子派生，保证同一调用方跨请求稳定。
     注意这一段读的是 rawHeaders 重建出来的对象，守卫写回的 req.headers 到这里已经不算数，
     所以注入必须在这里再做一次，否则 claude_code 的 Key 根本拿不到 session-id。 */
  headers = injectFingerprintHeaders(headers, cfg, fingerprintSeed(auth));

  /* 身份头（user-agent / x-app）：非 Claude Code 指纹的 Key 必须补，否则上游一眼看出是第三方 */
  if (cfg.injectMissing || auth.useClaudeFingerprint === false) {
    headers = injectCanonicalHeaders(headers, cfg, fingerprintSeed(auth));
  }

  const authHeaders = auth.passthroughKey
    ? { "x-api-key": auth.passthroughKey, "anthropic-version": ANTHROPIC_VERSION }
    : upstreamAuthHeaders(account);

  /* 凭据头：插回客户端原本的位置，而不是删了再加到末尾 */
  const credName = Object.keys(authHeaders).find((k) => AUTH_HEADER_NAMES.has(k.toLowerCase()));
  if (credName) {
    const credValue = authHeaders[credName];
    if (authSlot >= 0) {
      /* 原地插入：先重建有序数组，再插到那个下标 */
      const rebuilt = Object.keys(headers).map((k) => ({ name: k, value: String(headers[k]) }));
      const insertAt = Math.min(authSlot, rebuilt.length);
      rebuilt.splice(insertAt, 0, { name: credName, value: credValue });
      headers = {};
      for (const e of rebuilt) headers[e.name] = e.value;
    } else {
      headers[credName] = credValue;
    }
  }

  /* 其余认证头：beta 求并集（原地），版本号缺失才补 */
  for (const ak of Object.keys(authHeaders)) {
    const lk = ak.toLowerCase();
    if (AUTH_HEADER_NAMES.has(lk)) continue;
    const existingKey = Object.keys(headers).find((hk) => hk.toLowerCase() === lk);

    if (lk === "anthropic-beta") {
      /* 覆盖会丢掉 claude-code-20250219 / interleaved-thinking / tool-search-tool，
         请求体里的 thinking 与 tool search 依赖它们 */
      const merged = mergeBeta(existingKey ? headers[existingKey] : undefined, authHeaders[ak]);
      if (existingKey) headers[existingKey] = merged;
      else headers[ak] = merged;
      continue;
    }

    if (!existingKey) headers[ak] = authHeaders[ak];
  }

  /*
   * 规范集合：把请求头补齐成「真客户端该有的样子」。
   *
   * 必须在最后 —— 前面的凭据头与 beta 并集都落定之后才能统一。
   * 解决的问题：不同版本的客户端带不同的 beta 列表，原样转发会让同一个
   * device_id 上出现 beta 列表回退（真机不可能）；第三方客户端则缺
   * X-Stainless-* 与 anthropic-dangerous-direct-browser-access。
   */
  headers = applyCanonicalHeaders(headers, { mode: cfg.headerMode });

  if (!headers["content-type"] && !headers["Content-Type"]) headers["content-type"] = "application/json";
  return headers;
}

export function firstHeader(v: string | string[] | undefined): string {
  return headerValue(v);
}
