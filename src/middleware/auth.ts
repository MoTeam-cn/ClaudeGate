import { verifyGatewayToken, isGatewayToken } from "../tokens.ts";
import { lowerHeaders, headerValue } from "../utils.ts";
import { isApiKeyPlaintext } from "../store/apikeys.ts";
import { sessionKey as deriveSessionKey } from "../ids.ts";
import { openaiError, anthropicError } from "../http/respond.ts";
import type { ApiKeyStore, AuthState, Config } from "../types.ts";
import type { IncomingMessage, ServerResponse } from "node:http";

/**
 * 三种令牌都能过：
 *   sk-gw-*  面板发放的 API Key（按 Key 决定指纹策略与配额）
 *   gw1.*    网关自签令牌（Claude Code 直连场景，走 Claude Code 指纹守卫）
 *   sk-ant-* 直接把上游 Console Key 透传
 */
export function authenticate(cfg: Config, req: IncomingMessage, keys?: ApiKeyStore): AuthState {
  const h = lowerHeaders(req.headers);
  const raw = headerValue(h["authorization"] as string | string[] | undefined);
  const token = raw.toLowerCase().startsWith("bearer ")
    ? raw.slice(7).trim()
    : headerValue(h["x-api-key"] as string | string[] | undefined).trim();

  if (!token) return { ok: false, reason: "missing gateway token" };

  if (isApiKeyPlaintext(token)) {
    if (!keys) return { ok: false, reason: "api key store unavailable" };
    const rec = keys.findByPlaintext(token);
    if (!rec) return { ok: false, reason: "invalid api key" };
    if (!rec.enabled) return { ok: false, reason: "api key disabled" };
    return {
      ok: true,
      token,
      apiKey: rec,
      useClaudeFingerprint: rec.fingerprintMode === "claude_code"
    };
  }

  if (isGatewayToken(token)) {
    const payload = verifyGatewayToken(cfg, token);
    if (!payload) return { ok: false, reason: "invalid or expired gateway token" };
    return { ok: true, token, payload, useClaudeFingerprint: true };
  }

  if (token.startsWith("sk-ant-")) {
    return { ok: true, token, passthroughKey: token, useClaudeFingerprint: false };
  }

  return { ok: false, reason: "unrecognized token format" };
}

/** API Key 上的模型与协议白名单 */
export function checkKeyPolicy(
  auth: AuthState,
  protocol: string,
  model: string | null
): { ok: boolean; reason?: string; code?: string } {
  const rec = auth.apiKey;
  if (!rec) return { ok: true };

  if (rec.allowedProtocols.length && !rec.allowedProtocols.includes(protocol)) {
    return {
      ok: false,
      reason: "该 API Key 不允许使用 " + protocol + " 协议（当前允许：" + rec.allowedProtocols.join(", ") + "）。",
      code: "protocol_not_allowed"
    };
  }
  if (rec.allowedModels.length && model && !rec.allowedModels.includes(model)) {
    return {
      ok: false,
      reason: "该 API Key 不允许使用模型 " + model + "（当前允许：" + rec.allowedModels.join(", ") + "）。",
      code: "model_not_allowed"
    };
  }
  return { ok: true };
}

/** 会话键：优先用 Claude Code 的 session-id，其次按 API Key 或来源 IP 归组 */
export function sessionKeyOf(req: IncomingMessage, auth: AuthState): string {
  const raw = req.headers["x-claude-code-session-id"];
  const sid = Array.isArray(raw) ? raw[0] : raw;
  return deriveSessionKey(sid, auth.apiKey?.id ?? auth.token ?? "anon");
}

export function rejectUnauthorized(res: ServerResponse, isOpenai: boolean, reason: string): void {
  const msg = "网关鉴权失败：" + reason;
  if (isOpenai) openaiError(res, 401, msg, "authentication_error", "invalid_api_key");
  else anthropicError(res, 401, msg, "authentication_error");
}

export function rejectGuard(res: ServerResponse, isOpenai: boolean, missing: string[]): void {
  /*
   * 对外只给一句话。
   *
   * 之前这里写了一整篇小作文：缺了哪几个头、为什么会被拒、两种改法连 curl 参数都列出来。
   * 那是把网关当成调试工具在教 —— 但这个 Key 存在的意义就是「只给 Claude Code 用」，
   * 真 Claude Code 本来就不会缺头；会看到这条的，基本都不是它。
   * 教人怎么绕过自己的风控，逻辑上就不对。
   *
   * 缺的具体头仍然记进请求日志的「说明」列（server.ts 写进 tracker.blockDetail），
   * 要排查去面板看，不占用户眼前的版面。
   */
  const msg = "识别到您使用的不是 Claude Code 客户端，本网关仅接受 Claude Code 官方客户端，请更换后重试。";
  void missing;
  if (isOpenai) openaiError(res, 403, msg, "permission_error", "header_guard_rejected");
  else anthropicError(res, 403, msg, "permission_error");
}

export function rejectQuota(res: ServerResponse, isOpenai: boolean, reason: string, code: string): void {
  const msg = "配额限制：" + reason;
  if (isOpenai) openaiError(res, 429, msg, "rate_limit_error", code);
  else anthropicError(res, 429, msg, "rate_limit_error", code);
}
