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

/**
 * 从 scope 里取展示标签。
 * 二进制 schema 里 scope 是 { model: { display_name }, surface: { display_name } }，
 * 老形状（或别的实现）可能直接给 label —— 都认。
 */
function scopeLabelOf(scope: Record<string, unknown> | null): string | null {
  if (!scope) return null;
  if (typeof scope.label === "string" && scope.label) return scope.label;
  for (const key of ["model", "surface"]) {
    const sub = scope[key];
    if (sub && typeof sub === "object") {
      const dn = (sub as Record<string, unknown>).display_name;
      if (typeof dn === "string" && dn) return dn;
    }
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

  /* ---- 老形状：rate_limits.<name>.utilization（0-1 的小数） ---- */
  const rlRaw = d.rate_limits;
  const rl = rlRaw && typeof rlRaw === "object" ? (rlRaw as Record<string, unknown>) : null;

  if (rl) {
    for (const key of Object.keys(rl)) {
      /* extra_usage 与 limits 不是窗口本身：前者是溢出额度对象，后者是新形状的数组 */
      if (key === "extra_usage" || key === "limits") continue;
      const w = rl[key];
      if (!w || typeof w !== "object" || Array.isArray(w)) continue;
      const o = w as Record<string, unknown>;
      windows[key] = {
        utilization: numOrNull(o.utilization),
        resetsAt: resetOrNull(o.resets_at ?? o.resetsAt)
      };
    }
  }

  /* ---- 新形状：limits[] 是权威数组。
     字段名从二进制里的 Zod schema 抠出来（原文引用）：
       limits: array({ kind, group, percent, resets_at, scope, severity, is_active })
     · 百分比叫 **percent**（0-100），不叫 utilization —— 之前就是这里读错了，
       于是 utilization 恒为 null，面板上「有窗口但没数字」。
     · resets_at 是 ISO 8601 字符串，不是 unix 秒。
     · scope 是 { model: { display_name }, surface: { display_name } }，不是 { label }。
     · is_active 是服务端挑的头条行。
     有的形状把整个数组套在 rate_limits 下面，两种都认。 ---- */
  const limits = Array.isArray(d.limits)
    ? d.limits
    : rl && Array.isArray(rl.limits)
      ? rl.limits
      : [];
  for (const item of limits) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    /* 行名：新的是 kind，老的叫 rateLimitType；再兜一层 group */
    const name =
      (typeof o.kind === "string" && o.kind) ||
      (typeof o.rateLimitType === "string" && o.rateLimitType) ||
      (typeof o.group === "string" && o.group) ||
      null;
    if (!name) continue;

    /* 百分比：新形状是 percent，老形状是 utilization。percent 可能是 0，所以用 ?? 而不是 || */
    const rawUtil = numOrNull(o.percent ?? o.utilization ?? o.used_percent);
    /* 0-100 -> 0-1。老形状本身就是小数，所以只在明显超过 1 时才换算 */
    const util = rawUtil === null ? null : rawUtil > 1.5 ? rawUtil / 100 : rawUtil;

    const prev = windows[name] ?? { utilization: null, resetsAt: null };
    const sev = typeof o.severity === "string" ? o.severity : (typeof o.status === "string" ? o.status : undefined);
    const scope = o.scope && typeof o.scope === "object" ? (o.scope as Record<string, unknown>) : null;

    windows[name] = {
      utilization: util ?? prev.utilization,
      resetsAt: resetOrNull(o.resets_at ?? o.resetsAt) ?? prev.resetsAt,
      status: sev ?? prev.status,
      ...(scopeLabelOf(scope) ? { scopeLabel: scopeLabelOf(scope) as string } : {}),
      ...(o.is_active === true ? { isActive: true } : {})
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
    /* 二进制里对应这句（原文引用）：
         "Usage fetch returned a fieldless or non-object body (in-band error)"
       上游会回一个什么字段都没有的 body。以前这里直接返回 ok:true + windows:{}，
       面板看起来像「查到了但没有额度」，其实是没解析到。现在如实报错并把原文带上，
       免得用户对着一片空白猜。 */
    if (Object.keys(snap.windows).length === 0 && !snap.subscriptionType) {
      return fail("上游返回的用量里没有任何可识别字段（既没有 rate_limits 也没有 limits）。原始响应：" + text.slice(0, 300));
    }
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
