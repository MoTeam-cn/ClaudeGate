import { headerValue } from "../../utils.ts";
import { USAGE_WINDOWS } from "./parse.ts";
import type { RateLimitObservation, UsageWindow } from "../../types.ts";

/** 从响应头观察限流状态；没有用量接口的 Console Key 靠这条路拿到窗口 */

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
  /*
   * 百分比也在响应头里 —— 二进制里这几个头名（原文引用）：
   *   anthropic-ratelimit-unified-5h-utilization
   *   anthropic-ratelimit-unified-7d-utilization
   * 原先只读了 -reset 没读 -utilization，于是窗口有、数字永远空。
   * 这条路比 /api/oauth/usage 更可靠：每个请求都会带，Console Key 也有。
   */
  const fiveHourUtilization = num("anthropic-ratelimit-unified-5h-utilization");
  const sevenDayUtilization = num("anthropic-ratelimit-unified-7d-utilization");
  const overageDisabledReason = h["anthropic-ratelimit-unified-overage-disabled-reason"] ?? null;

  if (
    !unifiedStatus &&
    fiveHourReset === null &&
    sevenDayReset === null &&
    fiveHourUtilization === null &&
    sevenDayUtilization === null &&
    !Object.keys(dimensions).length
  ) {
    return null;
  }

  return {
    unifiedStatus,
    fiveHourReset,
    sevenDayReset,
    fiveHourUtilization,
    sevenDayUtilization,
    overageDisabledReason,
    dimensions
  };
}

/** 把响应头观测转成窗口视图，用于 Console Key 这种没有 usage 接口的情况 */
export function windowsFromRateLimit(rl: RateLimitObservation | null): Record<string, UsageWindow> {
  if (!rl) return {};
  const out: Record<string, UsageWindow> = {};
  const now = Math.floor(Date.now() / 1000);

  /*
   * 响应头 anthropic-ratelimit-unified-5h-utilization / -7d-utilization 是 **0-1 的小数**，
   * 不是百分数。官方客户端自己写的（原文引用，unifiedWindows 字段的 describe）：
   *   "utilization is the fraction of the window used (usually 0-1, same scale as the
   *    top-level utilization field; values above 1 occur when usage legitimately runs
   *    past a window's cap)"
   * 它渲染时再乘 100（原文引用）：used_percentage: UPt(ot.five_hour.utilization)，
   * 其中 UPt(e)=Math.round(e*1000)/10。
   * 所以这里**原样用**。以前写成除以 100，凡走响应头这条路的账号都会少 100 倍。
   */
  const frac = (v: number | null): number | null => (v === null || !Number.isFinite(v) ? null : v);
  if (rl.fiveHourReset !== null || rl.fiveHourUtilization !== null) {
    out.five_hour = {
      utilization: frac(rl.fiveHourUtilization),
      resetsAt: rl.fiveHourReset,
      status: rl.unifiedStatus ?? undefined
    };
  }
  if (rl.sevenDayReset !== null || rl.sevenDayUtilization !== null) {
    out.seven_day = {
      utilization: frac(rl.sevenDayUtilization),
      resetsAt: rl.sevenDayReset,
      status: rl.unifiedStatus ?? undefined
    };
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

