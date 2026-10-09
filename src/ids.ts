import crypto from "node:crypto";

/**
 * 请求 ID。
 * 形状与 Claude Code 自身校验的一致：req_ 加 26 个 base64url 字符，
 * 便于客户端日志与服务端日志两边对齐。
 */
export const REQUEST_ID_RE = /^req_[A-Za-z0-9_-]{1,36}$/;

export function newRequestId(): string {
  const raw = crypto.randomBytes(20).toString("base64url");
  return "req_" + raw.slice(0, 26);
}

export function isRequestId(v: unknown): boolean {
  return typeof v === "string" && REQUEST_ID_RE.test(v);
}

/** 会话键派生：同一会话要稳定映射到同一个上游账号 */
export function sessionKey(headerSessionId: string | undefined, fallbackSeed: string): string {
  const raw = (headerSessionId && headerSessionId.trim()) || fallbackSeed;
  return crypto.createHash("sha256").update(raw).digest("hex").slice(0, 32);
}
