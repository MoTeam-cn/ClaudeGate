import { ANTHROPIC_VERSION, CC_UA, OAUTH_BETA } from "../constants.ts";
import { headerValue } from "../utils.ts";
import { requestRaw } from "../net/request.ts";
import type { Account, Config, RateLimitObservation, UsageSnapshot, UsageWindow } from "../types.ts";

/** 订阅账号的限流窗口，顺序即展示顺序 */
export const USAGE_WINDOWS: ReadonlyArray<{ key: string; label: string; hint: string }> = [
  { key: "five_hour", label: "5 小时", hint: "滚动 5 小时窗口" },
  { key: "seven_day", label: "7 天", hint: "每周总额度" },
  { key: "seven_day_opus", label: "7 天 Opus", hint: "Opus 专属周窗" },
  { key: "seven_day_sonnet", label: "7 天 Sonnet", hint: "Sonnet 专属周窗" },
  { key: "seven_day_overage_included", label: "7 天（含溢出）", hint: "含额外用量的周窗" },
  { key: "seven_day_oauth_apps", label: "7 天 OAuth 应用", hint: "第三方 OAuth 应用周窗" },
  { key: "overage", label: "溢出额度", hint: "超出套餐后的按量额度" }
];

function numOrNull(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

/** resets_at 可能是 unix 秒、unix 毫秒，或 ISO 字符串 */
function resetOrNull(v: unknown): number | null {
  const n = numOrNull(v);
  if (n !== null) return n > 1e12 ? Math.floor(n / 1000) : Math.floor(n);
  if (typeof v === "string") {
    const t = Date.parse(v);
    if (Number.isFinite(t)) return Math.floor(t / 1000);
  }
  return null;
}

/**
 * 归一化 GET /api/oauth/usage 的响应。
 * 真实形状（从客户端 schema 还原）：
 *   { subscription_type, rate_limits_available,
 *     rate_limits: { five_hour: { utilization, resets_at }, seven_day: {...},
 *                    extra_usage: { is_enabled, monthly_limit, used_credits, utilization, currency } },
 *     limits: [ { status, rateLimitType, utilization, resetsAt } ] }
 */
export function normalizeOauthUsage(raw: unknown): UsageSnapshot {
  const d = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const windows: Record<string, UsageWindow> = {};

  const rlRaw = d.rate_limits;
  const rl = rlRaw && typeof rlRaw === "object" ? (rlRaw as Record<string, unknown>) : null;

  if (rl) {
    for (const key of Object.keys(rl)) {
      if (key === "extra_usage") continue;
      const w = rl[key];
      if (!w || typeof w !== "object") continue;
      const o = w as Record<string, unknown>;
      windows[key] = {
        utilization: numOrNull(o.utilization),
        resetsAt: resetOrNull(o.resets_at ?? o.resetsAt)
      };
    }
  }

  /* limits[] 是权威数组，用它覆盖同名窗口并补上 status */
  const limits = Array.isArray(d.limits) ? d.limits : [];
  for (const item of limits) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const type = typeof o.rateLimitType === "string" ? o.rateLimitType : null;
    if (!type) continue;
    const prev = windows[type] ?? { utilization: null, resetsAt: null };
    windows[type] = {
      utilization: numOrNull(o.utilization) ?? prev.utilization,
      resetsAt: resetOrNull(o.resetsAt) ?? prev.resetsAt,
      status: typeof o.status === "string" ? o.status : prev.status
    };
  }

  const extra = rl && rl.extra_usage && typeof rl.extra_usage === "object"
    ? (rl.extra_usage as Record<string, unknown>)
    : null;

  return {
    ok: true,
    source: "oauth",
    subscriptionType: typeof d.subscription_type === "string" ? d.subscription_type : null,
    rateLimitsAvailable: d.rate_limits_available !== false,
    windows,
    extraUsage: extra,
    error: null,
    fetchedAt: Date.now()
  };
}

/**
 * 查订阅账号的用量。Console API Key 没有这个接口，调用前要判 kind。
 * timeoutMs 可配：加号后自动查的那条路要短一点，别把面板拖住。
 */
export async function fetchOauthUsage(cfg: Config, account: Account, timeoutMs = 15000): Promise<UsageSnapshot> {
  const base = cfg.upstreamBase.replace(/\/+$/, "");
  const url = base + "/api/oauth/usage";
  const fail = (msg: string): UsageSnapshot => ({
    ok: false,
    source: "oauth",
    windows: {},
    error: msg,
    fetchedAt: Date.now()
  });

  if (account.kind !== "oauth") return fail("只有订阅 OAuth 账号才有用量接口");
  if (!account.accessToken) return fail("账号没有 access_token");

  try {
    const res = await requestRaw(url, {
      cfg,
      method: "GET",
      headers: {
        authorization: "Bearer " + account.accessToken,
        "anthropic-version": ANTHROPIC_VERSION,
        "anthropic-beta": OAUTH_BETA,
        "user-agent": CC_UA,
        accept: "application/json"
      },
      timeoutMs
    });
    const text = res.text;
    if (!res.ok) return fail("HTTP " + res.status + " " + text.slice(0, 200));
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return fail("响应不是合法 JSON：" + text.slice(0, 120));
    }
    const snap = normalizeOauthUsage(parsed);
    /* 顺手把额度已耗尽这件事反映到窗口状态上 */
    for (const w of Object.values(snap.windows)) {
      if (w.status === undefined && w.utilization !== null && w.utilization >= 1) w.status = "rejected";
    }
    return snap;
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
}

/**
 * 从上游响应头抽取限流观测。
 * 订阅账号会带 anthropic-ratelimit-unified-*；Console Key 只有各维度的 limit/remaining/reset。
 */
export function observeRateLimit(headers: Record<string, unknown>): RateLimitObservation | null {
  const h: Record<string, string> = {};
  for (const k of Object.keys(headers)) {
    const v = headerValue(headers[k] as string | string[] | undefined);
    if (v) h[k.toLowerCase()] = v;
  }

  const num = (name: string): number | null => {
    const raw = h[name];
    if (raw === undefined) return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  };

  const dimensions: RateLimitObservation["dimensions"] = {};
  for (const dim of ["requests", "tokens", "input-tokens", "output-tokens"]) {
    const limit = num("anthropic-ratelimit-" + dim + "-limit");
    const remaining = num("anthropic-ratelimit-" + dim + "-remaining");
    const reset = num("anthropic-ratelimit-" + dim + "-reset");
    if (limit !== null || remaining !== null || reset !== null) {
      dimensions[dim] = { limit, remaining, reset };
    }
  }

  const unifiedStatus = h["anthropic-ratelimit-unified-status"] ?? null;
  const fiveHourReset = num("anthropic-ratelimit-unified-5h-reset");
  const sevenDayReset = num("anthropic-ratelimit-unified-7d-reset");
  const overageDisabledReason = h["anthropic-ratelimit-unified-overage-disabled-reason"] ?? null;

  if (!unifiedStatus && fiveHourReset === null && sevenDayReset === null && !Object.keys(dimensions).length) {
    return null;
  }

  return { unifiedStatus, fiveHourReset, sevenDayReset, overageDisabledReason, dimensions };
}

/** 把响应头观测转成窗口视图，用于 Console Key 这种没有 usage 接口的情况 */
export function windowsFromRateLimit(rl: RateLimitObservation | null): Record<string, UsageWindow> {
  if (!rl) return {};
  const out: Record<string, UsageWindow> = {};
  const now = Math.floor(Date.now() / 1000);

  if (rl.fiveHourReset !== null) {
    out.five_hour = { utilization: null, resetsAt: rl.fiveHourReset, status: rl.unifiedStatus ?? undefined };
  }
  if (rl.sevenDayReset !== null) {
    out.seven_day = { utilization: null, resetsAt: rl.sevenDayReset, status: rl.unifiedStatus ?? undefined };
  }

  for (const dim of Object.keys(rl.dimensions)) {
    const d = rl.dimensions[dim];
    if (d.limit === null || d.limit <= 0 || d.remaining === null) continue;
    out["dim:" + dim] = {
      utilization: (d.limit - d.remaining) / d.limit,
      resetsAt: d.reset !== null && d.reset > now ? d.reset : null
    };
  }
  return out;
}
