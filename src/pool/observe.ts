import { observeRateLimit } from "./usage.ts";
import { detectExhaustion } from "./exhaustion.ts";
import { safeJson } from "../utils.ts";
import type { GatewayContext, RateLimitObservation, RequestTracker, UpstreamOk, UpstreamResponse } from "../types.ts";

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
  /** 响应头里观测到的限流状态，调用方决定要不要交给调度器 */
  rateLimit: RateLimitObservation | null;
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
  const note = classifyUpstreamError(up, bodyText);
  tracker.outcome = "error";
  tracker.errorType = note.errorType;
  tracker.errorMessage = note.message.slice(0, 500);
  if (note.exhausted) {
    tracker.exhaustedUntil = note.resetAt;
    tracker.exhaustedReason = note.reason;
  }
  return note;
}

/**
 * 从一次上游错误响应里抽出全部可判定信息。不碰 tracker，
 * 所以换号重试放弃某个号时也能用同一套判定 —— 否则被放弃的号只会被记成普通失败，
 * 「额度耗尽」这种要封印到重置的状态就丢了。
 */
export function classifyUpstreamError(up: UpstreamResponse, bodyText: string): ErrorNote {
  const parsed = safeJson<{ error?: { type?: string; message?: string } }>(bodyText);
  const errorType = typeof parsed.error?.type === "string" ? parsed.error.type : null;
  const parsedMsg = typeof parsed.error?.message === "string" ? parsed.error.message.trim() : "";
  const raw = bodyText.trim();
  /*
   * 上游偶尔只回一句没有信息量的 message（实测遇到过就一个 "Error"）。
   * 这种时候如果只用 message，请求日志里等于没报错 —— 排查时完全没线索。
   * 所以：message 够长就用它，否则把原始响应体一起留下来。
   */
  const informative = parsedMsg.length >= 12;
  const message = informative
    ? parsedMsg
    : raw.slice(0, 500) || parsedMsg || ("HTTP " + up.status);
  const combined =
    parsedMsg && raw && raw.indexOf(parsedMsg) === -1 && !informative
      ? parsedMsg + " | " + raw
      : message;

  const rl = observeRateLimit(up.headers as Record<string, unknown>);
  const verdict = detectExhaustion({
    status: up.status,
    errorType,
    message: bodyText,
    rateLimit: rl
  });

  return {
    message: combined,
    errorType,
    exhausted: verdict.exhausted,
    resetAt: verdict.resetAt,
    reason: verdict.reason,
    rateLimit: rl
  };
}
