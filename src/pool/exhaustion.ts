import type { RateLimitObservation } from "../types.ts";

export interface ExhaustionVerdict {
  exhausted: boolean;
  /** 给人看的判定依据 */
  reason: string;
  /** 建议的恢复时刻（unix 秒） */
  resetAt: number | null;
}

/** 额度用尽的文案特征，取自客户端自身的错误分类表 */
const QUOTA_PHRASES: ReadonlyArray<readonly [string, string]> = [
  ["credit balance is too low", "余额不足（credit balance is too low）"],
  ["credit_balance_low", "余额不足（credit_balance_low）"],
  ["usage credits are required", "需要开启用量额度（usage credits are required）"],
  ["extra usage is required", "需要开启额外用量（extra usage is required）"],
  ["usage limit reached", "用量额度用尽（usage limit reached）"],
  ["reached your specified", "触达自定义用量上限（usage cap reached）"],
  ["out of credits", "额度耗尽（out of credits）"],
  ["insufficient credit", "额度不足（insufficient credit）"]
];

/** 客户端自己的错误分类：这些类型直接等价于「这个号今天不能用了」 */
const QUOTA_ERROR_TYPES = new Set(["billing_error"]);

/** 最长一次性禁用时长：即使上游给了更远的 7 天重置，也先按这个上限试探 */
const MAX_DISABLE_SEC = 6 * 3600;
const DEFAULT_DISABLE_SEC = 5 * 3600;

/**
 * 判断一次上游失败是不是「账号额度耗尽」。
 *
 * 判据来自 Claude Code 自身的错误分类表：
 *   billing_error        -> usage limit reached
 *   credit_balance_low   -> 余额不足
 *   usage_cap_reached    -> 触达自定义上限
 * 以及 anthropic-ratelimit-unified-status 为 rejected 的 429。
 */
export function detectExhaustion(input: {
  status: number;
  errorType?: string | null;
  message?: string | null;
  rateLimit?: RateLimitObservation | null;
  nowSec?: number;
}): ExhaustionVerdict {
  const now = input.nowSec ?? Math.floor(Date.now() / 1000);
  const msg = String(input.message ?? "").toLowerCase();
  const type = String(input.errorType ?? "");
  const rl = input.rateLimit ?? null;

  let hit: string | null = null;

  if (type && QUOTA_ERROR_TYPES.has(type)) {
    hit = "错误类型 " + type + "（上游判定为用量上限）";
  }

  if (!hit) {
    for (const [phrase, label] of QUOTA_PHRASES) {
      if (msg.includes(phrase)) {
        hit = label;
        break;
      }
    }
  }

  if (!hit && input.status === 429 && rl?.unifiedStatus === "rejected") {
    hit = "上游限流头标记为 rejected（额度窗口已打满）";
  }

  if (!hit) return { exhausted: false, reason: "", resetAt: null };

  if (rl?.overageDisabledReason && rl.overageDisabledReason !== "unknown") {
    hit += "；溢出额度不可用：" + rl.overageDisabledReason;
  }

  /* 取最早的可用重置时刻，并封顶到 MAX_DISABLE_SEC，
     免得因为 7 天窗口把号一次性关太久；到期后自然会被再试探一次 */
  const candidates: number[] = [];
  if (rl?.fiveHourReset && rl.fiveHourReset > now) candidates.push(rl.fiveHourReset);
  if (rl?.sevenDayReset && rl.sevenDayReset > now) candidates.push(rl.sevenDayReset);

  const earliest = candidates.length ? Math.min(...candidates) : now + DEFAULT_DISABLE_SEC;
  const resetAt = Math.min(earliest, now + MAX_DISABLE_SEC);

  return { exhausted: true, reason: hit, resetAt };
}
