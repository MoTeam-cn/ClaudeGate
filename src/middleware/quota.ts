import { dayString } from "../store/apikeys.ts";
import type { ApiKeyRecord, ApiKeyStore } from "../types.ts";

export interface QuotaDecision {
  ok: boolean;
  reason?: string;
  code?: string;
  retryAfterSec?: number;
}

export interface QuotaGuard {
  check(rec: ApiKeyRecord): QuotaDecision;
  commit(rec: ApiKeyRecord, usage: { promptTokens?: number; completionTokens?: number; cacheTokens?: number }): void;
  usageToday(keyId: string): { requests: number; tokens: number };
  flush(): void;
  stop(): void;
}

const WINDOW_MS = 60_000;
const FLUSH_MS = 3000;

interface Delta {
  requests: number;
  promptTokens: number;
  completionTokens: number;
  cacheTokens: number;
}

/**
 * 配额闸门。
 * 每分钟限速走内存滑窗；每日额度落库，写入攒批提交，
 * 避免每个请求一次事务（node:sqlite 是同步 API，会阻塞事件循环）。
 */
export function createQuotaGuard(keys: ApiKeyStore): QuotaGuard {
  const window = new Map<string, number[]>();
  const pending = new Map<string, Delta>();
  let timer: NodeJS.Timeout | null = null;

  function flush(): void {
    if (!pending.size) return;
    const day = dayString();
    const batch = [...pending.entries()];
    pending.clear();
    for (const [keyId, d] of batch) {
      try {
        keys.bumpUsage(keyId, day, d);
      } catch {
        /* 统计失败不影响请求 */
      }
    }
  }

  function schedule(): void {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      flush();
    }, FLUSH_MS);
    timer.unref();
  }

  function pendingFor(keyId: string): Delta {
    let d = pending.get(keyId);
    if (!d) {
      d = { requests: 0, promptTokens: 0, completionTokens: 0, cacheTokens: 0 };
      pending.set(keyId, d);
    }
    return d;
  }

  function usageToday(keyId: string): { requests: number; tokens: number } {
    const day = dayString();
    const stored = keys.usage(keyId, day);
    const p = pending.get(keyId);
    return {
      requests: stored.requests + (p?.requests ?? 0),
      tokens:
        stored.promptTokens + stored.completionTokens + stored.cacheTokens +
        (p?.promptTokens ?? 0) + (p?.completionTokens ?? 0) + (p?.cacheTokens ?? 0)
    };
  }

  function hitWindow(keyId: string, now: number): number {
    let arr = window.get(keyId);
    if (!arr) {
      arr = [];
      window.set(keyId, arr);
    }
    const cutoff = now - WINDOW_MS;
    let drop = 0;
    while (drop < arr.length && arr[drop] < cutoff) drop += 1;
    if (drop > 0) arr.splice(0, drop);
    return arr.length;
  }

  function check(rec: ApiKeyRecord): QuotaDecision {
    /* 配额是可控开关：关掉就完全不拦，但仍照常统计用量 */
    if (!rec.quotaEnabled) return { ok: true };

    const now = Date.now();

    if (rec.rateLimitPerMin > 0) {
      const used = hitWindow(rec.id, now);
      if (used >= rec.rateLimitPerMin) {
        return {
          ok: false,
          reason: "每分钟请求数已达上限 " + rec.rateLimitPerMin + "，请稍后重试。",
          code: "rate_limit_exceeded",
          retryAfterSec: 60
        };
      }
    }

    const today = usageToday(rec.id);

    if (rec.dailyRequestLimit > 0 && today.requests >= rec.dailyRequestLimit) {
      return {
        ok: false,
        reason: "今日请求数已达上限 " + rec.dailyRequestLimit + "，明日重置。",
        code: "daily_request_limit_exceeded"
      };
    }

    if (rec.dailyTokenLimit > 0 && today.tokens >= rec.dailyTokenLimit) {
      return {
        ok: false,
        reason: "今日 token 用量已达上限 " + rec.dailyTokenLimit + "，明日重置。",
        code: "daily_token_limit_exceeded"
      };
    }

    return { ok: true };
  }

  function commit(
    rec: ApiKeyRecord,
    usage: { promptTokens?: number; completionTokens?: number; cacheTokens?: number }
  ): void {
    const now = Date.now();
    if (rec.rateLimitPerMin > 0) {
      const arr = window.get(rec.id) ?? [];
      arr.push(now);
      window.set(rec.id, arr);
    }
    const d = pendingFor(rec.id);
    d.requests += 1;
    d.promptTokens += usage.promptTokens ?? 0;
    d.completionTokens += usage.completionTokens ?? 0;
    d.cacheTokens += usage.cacheTokens ?? 0;
    if (pending.size >= 500) flush();
    else schedule();
  }

  function stop(): void {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    flush();
  }

  return { check, commit, usageToday, flush, stop };
}
