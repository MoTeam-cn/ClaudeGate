import crypto from "node:crypto";

/** 与真 Claude Code 同形的 device_id：32 字节随机数的十六进制，64 个字符 */
export function newDeviceId(): string {
  return crypto.randomBytes(32).toString("hex");
}

export type UserIdMode = "off" | "device" | "full";

export interface UserIdRewriteOptions {
  /** 号池账号专属的 device_id；null 表示这个号还没分配 */
  deviceId: string | null;
  /** 号池账号的 account_uuid，full 模式下写进去 */
  accountUuid?: string | null;
  mode: UserIdMode;
  /** 客户端没带 metadata.user_id 时要不要补一个 */
  createIfMissing: boolean;
  /** 补的时候用的 session_id */
  sessionId: string;
}

export interface UserIdRewriteResult {
  changed: boolean;
  reason: string;
}

function parseUserId(raw: unknown): Record<string, unknown> | null {
  if (typeof raw !== "string") return null;
  try {
    const v: unknown = JSON.parse(raw);
    if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
  } catch {
    /* 不是 JSON 就不碰，别把别人的东西弄坏 */
  }
  return null;
}

/**
 * 重写 metadata.user_id，让上游看到「一个号 = 一台设备」。
 *
 * 真 Claude Code 的 user_id 是 JSON 字符串，键序固定 device_id / account_uuid / session_id。
 * device_id 跨会话恒定，换 IP 也带不走 —— 号池里多个客户端共用一个号时，
 * 上游会看到同一个 device_id 到处漂，既不像正常用户，也把不同的人关联到一起。
 * 这里按号固定一个 device_id；session_id 保持客户端原值，会话本来就该变。
 */
export function rewriteUserId(
  body: Record<string, unknown>,
  opts: UserIdRewriteOptions
): UserIdRewriteResult {
  if (opts.mode === "off") return { changed: false, reason: "模式 off" };

  const rawMeta = body.metadata;
  const meta =
    rawMeta && typeof rawMeta === "object" && !Array.isArray(rawMeta)
      ? { ...(rawMeta as Record<string, unknown>) }
      : null;
  const parsed = meta ? parseUserId(meta.user_id) : null;

  if (!parsed) {
    if (!opts.createIfMissing) return { changed: false, reason: "客户端没带 metadata.user_id" };
    if (!opts.deviceId) return { changed: false, reason: "号上还没有 device_id" };
    const fresh: Record<string, unknown> = {
      device_id: opts.deviceId,
      account_uuid: opts.accountUuid ?? "",
      session_id: opts.sessionId
    };
    body.metadata = { ...(meta ?? {}), user_id: JSON.stringify(fresh) };
    return { changed: true, reason: "补上 metadata.user_id" };
  }

  if (!opts.deviceId) return { changed: false, reason: "号上还没有 device_id" };

  const before = parsed.device_id;
  /* 键序照真 Claude Code 来：device_id / account_uuid / session_id，其余键保持原顺序跟后面 */
  const ordered: Record<string, unknown> = { device_id: opts.deviceId };
  const acct =
    opts.mode === "full" && opts.accountUuid ? opts.accountUuid : parsed.account_uuid;
  if (acct !== undefined) ordered.account_uuid = acct;
  if (parsed.session_id !== undefined) ordered.session_id = parsed.session_id;
  for (const [k, v] of Object.entries(parsed)) {
    if (k === "device_id" || k === "account_uuid" || k === "session_id") continue;
    ordered[k] = v;
  }

  const next = JSON.stringify(ordered);
  if (next === JSON.stringify(parsed)) return { changed: false, reason: "本来就一致" };

  body.metadata = { ...meta, user_id: next };
  return {
    changed: true,
    reason:
      before === opts.deviceId
        ? opts.mode === "full"
          ? "account_uuid 已按号固定"
          : "本来就一致"
        : opts.mode === "full"
          ? "device_id 与 account_uuid 已按号固定"
          : "device_id 已按号固定"
  };
}
