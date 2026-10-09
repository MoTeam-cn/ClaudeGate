import { observeRateLimit } from "./usage.ts";
import { detectExhaustion } from "./exhaustion.ts";
import { safeJson } from "../utils.ts";
import type { GatewayContext, RequestTracker, UpstreamOk, UpstreamResponse } from "../types.ts";

/** 记录这次用的是哪个号，并把响应头里的限流观测交给调度器 */
export function noteUpstream(ctx: GatewayContext, tracker: RequestTracker, up: UpstreamOk | UpstreamResponse): void {
  const withAccount = up as UpstreamOk;
  tracker.status = up.status;
  tracker.accountId = withAccount.account?.id ?? null;
  tracker.accountLabel = withAccount.account?.label ?? null;

  if (withAccount.account) {
    const rl = observeRateLimit(up.headers as Record<string, unknown>);
    if (rl) ctx.scheduler.observeRateLimit(withAccount.account.id, rl);
  }
}

export interface ErrorNote {
  message: string;
  errorType: string | null;
  exhausted: boolean;
  resetAt: number | null;
  reason: string;
}

/**
 * 处理上游错误响应：抽出错误类型与文案，判断是不是额度耗尽。
 * 额度耗尽与普通 429 要分开：前者要禁用账号并等到重置，后者只需短暂冷却。
 */
export function noteUpstreamError(
  tracker: RequestTracker,
  up: UpstreamResponse,
  bodyText: string
): ErrorNote {
  const parsed = safeJson<{ error?: { type?: string; message?: string } }>(bodyText);
  const errorType = typeof parsed.error?.type === "string" ? parsed.error.type : null;
  const message = parsed.error?.message ?? (bodyText.slice(0, 500) || "HTTP " + up.status);

  const rl = observeRateLimit(up.headers as Record<string, unknown>);
  const verdict = detectExhaustion({
    status: up.status,
    errorType,
    message: bodyText,
    rateLimit: rl
  });

  tracker.outcome = "error";
  tracker.errorType = errorType;
  tracker.errorMessage = message.slice(0, 500);
  if (verdict.exhausted) {
    tracker.exhaustedUntil = verdict.resetAt;
    tracker.exhaustedReason = verdict.reason;
  }

  return {
    message,
    errorType,
    exhausted: verdict.exhausted,
    resetAt: verdict.resetAt,
    reason: verdict.reason
  };
}
