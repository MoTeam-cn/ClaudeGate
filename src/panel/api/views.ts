import type { Account, ApiKeyRecord, GatewayContext } from "../../types.ts";
import { windowsFromRateLimit } from "../../pool/usage.ts";

/** 可以在面板「设置」里改的运行时键 */
export const SETTING_KEYS = ["guardMode", "stegoMode", "reqIdInResponse", "injectMissing", "logRetentionDays", "runtimeLogMax"];

/** 面板可见的账号视图：绝不回传任何凭据原文 */
export function publicAccount(a: Account): Record<string, unknown> {
  /* 订阅号有 usage 接口；Console Key 只有响应头，用观察到的限流窗口顶上 */
  const windows = a.usage?.windows && Object.keys(a.usage.windows).length
    ? a.usage.windows
    : windowsFromRateLimit(a.rateLimit);

  return {
    id: a.id,
    label: a.label,
    kind: a.kind,
    status: a.status,
    exhaustedUntil: a.exhaustedUntil,
    exhaustedReason: a.exhaustedReason,
    usage: {
      source: a.usage?.source ?? (a.rateLimit ? "headers" : "none"),
      ok: a.usage?.ok ?? false,
      error: a.usage?.error ?? null,
      subscriptionType: a.usage?.subscriptionType ?? null,
      extraUsage: a.usage?.extraUsage ?? null,
      windows
    },
    usageAt: a.usageAt,
    rateLimit: a.rateLimit
      ? {
          unifiedStatus: a.rateLimit.unifiedStatus,
          overageDisabledReason: a.rateLimit.overageDisabledReason,
          dimensions: a.rateLimit.dimensions
        }
      : null,
    email: a.email,
    /* 面板「设备指纹」列读的就是这个。之前没传，所以永远显示「待生成」 */
    deviceId: a.deviceId,
    accountUuid: a.accountUuid,
    mode: a.mode,
    scope: a.scope,
    expiresAt: a.expiresAt,
    errorCount: a.errorCount,
    /* 面板「请求」列读的就是这个。以前漏传，前端拿到 undefined，
       CG.fmtNum 兜底成 0 —— 看起来就像「后端根本没返回这一项」 */
    requestCount: a.requestCount,
    lastError: a.lastError,
    cooldownUntil: a.cooldownUntil,
    weight: a.weight,
    hasAccessToken: !!a.accessToken,
    hasRefreshToken: !!a.refreshToken,
    hasApiKey: !!a.apiKey,
    apiKeyPreview: a.apiKey ? a.apiKey.slice(0, 14) + "..." : null,
    createdAt: a.createdAt,
    updatedAt: a.updatedAt
  };
}

export function publicKey(k: ApiKeyRecord, ctx: GatewayContext): Record<string, unknown> {
  const usage = ctx.quota.usageToday(k.id);
  return {
    id: k.id,
    name: k.name,
    keyPrefix: k.keyPrefix,
    enabled: k.enabled,
    fingerprintMode: k.fingerprintMode,
    allowedModels: k.allowedModels,
    allowedProtocols: k.allowedProtocols,
    quotaEnabled: k.quotaEnabled,
    rateLimitPerMin: k.rateLimitPerMin,
    dailyRequestLimit: k.dailyRequestLimit,
    dailyTokenLimit: k.dailyTokenLimit,
    boundAccountId: k.boundAccountId,
    createdAt: k.createdAt,
    usageToday: {
      requests: usage.requests,
      tokens: usage.tokens
    }
  };
}

/* ---- 请求体取值的小工具（面板的入参都是 unknown，统一在这里收口） ---- */

export function str(v: unknown, d = ""): string {
  return typeof v === "string" ? v : d;
}

export function strList(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean);
  if (typeof v === "string") {
    return v.split(/[\n,]/).map((s) => s.trim()).filter(Boolean);
  }
  return [];
}

export function asBool(v: unknown): boolean {
  return v === true || v === "true" || v === 1 || v === "1";
}
