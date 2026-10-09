/**
 * 订阅账号的档案。用来把「账号 1」这种占位名换成真名字。
 *
 * 端点从 Claude Code 二进制里还原（原文引用）：
 *   let n = `${cn().BASE_API_URL}/api/oauth/profile`;
 *   Et.get(n, { headers: { "User-Agent": Fo(), Authorization: `Bearer ${e}`,
 *                 "Content-Type": "application/json", "Cache-Control": "no-cache" }, timeout: 1e4 })
 *
 * 响应形状（同样从二进制的解析函数还原）：
 *   { organization: { organization_type, rate_limit_tier, seat_tier,
 *                     has_extra_usage_enabled, billing_type, cc_onboarding_flags,
 *                     claude_code_trial_ends_at, subscription_created_at, plan_display_name },
 *     account: { display_name, full_name, created_at } }
 *
 * 注意 organization_type 是 claude_max / claude_pro 这种，要映射成 max / pro。
 */
import { ANTHROPIC_VERSION, CC_UA } from "../constants.ts";
import { requestRaw } from "../net/request.ts";
import type { Config } from "../types.ts";

/** 二进制里的 b$ 映射表，逐项照抄 */
const ORG_TYPE_TO_PLAN: ReadonlyMap<string, string> = new Map([
  ["claude_max", "max"],
  ["claude_pro", "pro"],
  ["claude_enterprise", "enterprise"],
  ["claude_team", "team"]
]);

export interface OauthProfile {
  /** 优先展示这个 */
  displayName: string | null;
  fullName: string | null;
  email: string | null;
  organizationName: string | null;
  planDisplayName: string | null;
  /** max / pro / enterprise / team */
  subscriptionType: string | null;
  rateLimitTier: string | null;
  seatTier: string | null;
  billingType: string | null;
  hasExtraUsageEnabled: boolean | null;
  raw: unknown;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
}

function obj(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/** 从任意深度找第一个像邮箱的字段，兜底用 */
function deepEmail(v: unknown, depth = 0): string | null {
  if (depth > 4) return null;
  const o = obj(v);
  if (!o) return null;
  for (const k of ["email", "email_address", "account_email"]) {
    const s = str(o[k]);
    if (s && s.includes("@")) return s;
  }
  for (const k of Object.keys(o)) {
    const found = deepEmail(o[k], depth + 1);
    if (found) return found;
  }
  return null;
}

/** 把 /api/oauth/profile 的响应摊平成好用的形状 */
export function normalizeProfile(raw: unknown): OauthProfile {
  const d = obj(raw) ?? {};
  const org = obj(d.organization) ?? {};
  const acc = obj(d.account) ?? {};
  const orgType = str(org.organization_type);
  const extra = org.has_extra_usage_enabled;
  return {
    displayName: str(acc.display_name),
    fullName: str(acc.full_name),
    email: deepEmail(d),
    organizationName: str(org.organization_name),
    planDisplayName: str(org.plan_display_name),
    subscriptionType: (orgType !== null ? ORG_TYPE_TO_PLAN.get(orgType) : undefined) ?? orgType,
    rateLimitTier: str(org.rate_limit_tier),
    seatTier: str(org.seat_tier),
    billingType: str(org.billing_type),
    hasExtraUsageEnabled: typeof extra === "boolean" ? extra : null,
    raw
  };
}

/**
 * 这个档案适合拿来当账号名吗？
 * 二进制里对 plan_display_name 有字符白名单校验，这里对展示名也做一遍 ——
 * 免得上游返回带控制字符或超长的串把面板搞乱。
 */
export function profileLabel(p: OauthProfile): string | null {
  const candidates = [p.displayName, p.fullName, p.email, p.organizationName];
  for (const c of candidates) {
    if (!c) continue;
    if (c.length > 64) continue;
    /* 允许字母数字、空格、. + - _ @ 与中日韩字符 */
    if (!/^[\p{L}\p{N}][\p{L}\p{N} .+\-_@]*$/u.test(c)) continue;
    return c;
  }
  return null;
}

/**
 * 拉订阅账号档案。失败返回 null —— 名字拿不到不该影响建号。
 */
export async function fetchOauthProfile(
  cfg: Config,
  accessToken: string,
  timeoutMs = 10000
): Promise<OauthProfile | null> {
  if (!accessToken) return null;
  try {
    const res = await requestRaw(cfg.oauthProfileUrl, {
      cfg,
      method: "GET",
      headers: {
        authorization: "Bearer " + accessToken,
        "content-type": "application/json",
        "cache-control": "no-cache",
        "anthropic-version": ANTHROPIC_VERSION,
        "user-agent": CC_UA
      },
      timeoutMs
    });
    if (!res.ok) return null;
    const parsed: unknown = JSON.parse(res.text);
    const prof = normalizeProfile(parsed);
    /* 整个响应是空的就别当成功 */
    if (!prof.displayName && !prof.fullName && !prof.email && !prof.organizationName && !prof.subscriptionType) {
      return null;
    }
    return prof;
  } catch {
    return null;
  }
}
