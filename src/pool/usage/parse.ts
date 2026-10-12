import { headerValue } from "../../utils.ts";
import type { UsageSnapshot, UsageWindow } from "../../types.ts";

/** 上游用量响应的解析：把各种形状的字段归一成 UsageSnapshot */

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

/**
 * 从一行用量里取「已用比例」（0-1）。
 *
 * **单位由字段名决定，不看数值大小。**
 * 早先写成「超过 1.5 就除以 100」，那是错的：上游给 1（=1%）会被当成 1.0，
 * 面板渲染成 100%；给 1.2 就渲染成 120%。
 *
 * 二进制里两个字段各有各的单位：
 *   · rate_limits.limits[].percent —— "Share of the window used, 0-100."，百分数
 *   · cedar-ember 的 percent_used —— 同样是 0-100，还是个按 limit_type 索引的映射
 *   · 老形状的 utilization —— 0-1 的小数
 */
function utilizationOf(o: Record<string, unknown>, name: string): number | null {
  /* 百分数：一律除以 100 */
  const pct = numOrNull(o.percent ?? o.used_percent ?? o.percentUsed);
  if (pct !== null) return pct / 100;
  const rec = o.percent_used;
  if (rec && typeof rec === "object" && !Array.isArray(rec)) {
    const m = rec as Record<string, unknown>;
    const exact = numOrNull(m[name]);
    if (exact !== null) return exact / 100;
    let best: number | null = null;
    for (const k of Object.keys(m)) {
      const x = numOrNull(m[k]);
      if (x !== null && (best === null || x > best)) best = x;
    }
    if (best !== null) return best / 100;
  }
  /* 裸 utilization 也按百分数读（0-100）。
     官方 /usage 对话框就是这么渲染的（原文引用）：
       i.push(`${r}: ${Math.floor(l.utilization)}% used${u}`)
     它直接拿 utilization 当百分数用，所以响应体里凡是百分比字段都是 0-100。
     0-1 的只有响应头那一套（见 windowsFromRateLimit）。 */
  const util = numOrNull(o.utilization);
  return util === null ? null : util / 100;
}

/**
 * 不带时区标记的 ISO 串，例如 2026-10-11T00:00:00 或 2026-10-11 00:00:00。
 *
 * Date.parse 对这种串是按**本机时区**解释的 —— 也就是网关进程所在容器的 TZ。
 * 容器 TZ 一变，同一份上游数据就解析出不同的时刻。上游给的重置时间全是 UTC 语义
 * （见下面 resetOrNull 的注释），所以这里显式补 Z，把环境依赖彻底去掉。
 */
const NAIVE_DATETIME_RE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/;

/**
 * resets_at 可能是 unix 秒、unix 毫秒，或 ISO 字符串。
 * 统一归一化成 **unix 秒**（与时区无关），前端再按浏览器所在时区渲染。
 *
 * 上游两种来源的真实语义：
 *   · GET /api/oauth/usage 的 resets_at 是 **ISO 8601 带 Z**（UTC）。
 *     官方客户端自己也是这么转的（原文引用，SPEC.md）：
 *       let o=(s)=>s?{utilization:s.utilization*100, resets_at:new Date(s.resets_at*1000).toISOString()}:void 0
 *   · 响应头 anthropic-ratelimit-unified-5h-reset / -7d-reset 是 **unix 秒**，
 *     本来就是时区无关的。
 */
function resetOrNull(v: unknown): number | null {
  const n = numOrNull(v);
  if (n !== null) return n > 1e12 ? Math.floor(n / 1000) : Math.floor(n);
  if (typeof v === "string") {
    const s = v.trim();
    const t = Date.parse(NAIVE_DATETIME_RE.test(s) ? s.replace(" ", "T") + "Z" : s);
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
      /* 老形状的 utilization 也是百分数。官方 schema 原文引用：
           utilization: k().nullable().describe("Percentage of the window used, 0-100.")
         所以同样要除以 100 —— 以前这里原样用，42 会渲染成 4200%。 */
      const rawUtil = numOrNull(o.utilization);
      windows[key] = {
        utilization: rawUtil === null ? null : rawUtil / 100,
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

    /* 单位由字段名决定，不看大小 —— 见 utilizationOf 的注释 */
    const util = utilizationOf(o, name);

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

