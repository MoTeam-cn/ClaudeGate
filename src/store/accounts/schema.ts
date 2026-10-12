import type {
  Account, AccountKind, AccountStatus, RateLimitObservation, UsageSnapshot
} from "../../types.ts";

/** 数据库行与 Account 之间的映射。纯函数，不碰连接。 */

export interface Row {
  id: string;
  label: string;
  kind: string;
  access_token: string | null;
  refresh_token: string | null;
  api_key: string | null;
  expires_at: number | null;
  scope: string | null;
  client_id: string | null;
  mode: string | null;
  account_uuid: string | null;
  device_id: string | null;
  cc_version: string | null;
  email: string | null;
  status: string;
  last_error: string | null;
  error_count: number;
  request_count: number;
  weight: number;
  cooldown_until: number | null;
  exhausted_until: number | null;
  exhausted_reason: string | null;
  usage_json: string | null;
  usage_at: number | null;
  rate_limit_json: string | null;
  created_at: number;
  updated_at: number;
}

function parseJson<T>(s: string | null): T | null {
  if (!s) return null;
  try {
    return JSON.parse(s) as T;
  } catch {
    return null;
  }
}

export function toAccount(r: Row): Account {
  return {
    id: r.id,
    label: r.label,
    kind: r.kind as AccountKind,
    accessToken: r.access_token,
    refreshToken: r.refresh_token,
    apiKey: r.api_key,
    expiresAt: r.expires_at,
    scope: r.scope,
    clientId: r.client_id,
    mode: r.mode,
    accountUuid: r.account_uuid,
    deviceId: r.device_id,
    ccVersion: r.cc_version,
    email: r.email,
    status: r.status as AccountStatus,
    lastError: r.last_error,
    errorCount: r.error_count,
    requestCount: r.request_count,
    weight: r.weight,
    cooldownUntil: r.cooldown_until,
    exhaustedUntil: r.exhausted_until,
    exhaustedReason: r.exhausted_reason,
    usage: parseJson<UsageSnapshot>(r.usage_json),
    usageAt: r.usage_at,
    rateLimit: parseJson<RateLimitObservation>(r.rate_limit_json),
    createdAt: r.created_at,
    updatedAt: r.updated_at
  };
}

