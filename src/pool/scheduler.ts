import type { Account, AccountStore, Logger, RateLimitObservation } from "../types.ts";

const STICKY_TTL_MS = 30 * 60 * 1000;
const STICKY_MAX = 4096;
const RL_FLUSH_MS = 5000;

export interface PickOptions {
  /** 会话键：同一会话优先复用同一个号 */
  sessionKey: string;
  /** API Key 绑定的账号，优先使用 */
  preferredAccountId?: string | null;
}

export interface Scheduler {
  pick(opts: PickOptions): Account | null;
  reportSuccess(accountId: string): void;
  reportFailure(accountId: string, status: number, message: string): void;
  /** 额度耗尽：标记并记下恢复时刻 */
  reportExhausted(accountId: string, reason: string, resetAtSec: number): void;
  /** 暂存从响应头观察到的限流状态，批量落库 */
  observeRateLimit(accountId: string, rl: RateLimitObservation): void;
  invalidateSession(sessionKey: string): void;
  snapshot(): { accounts: number; active: number; sticky: number; cooling: number; exhausted: number };
  stop(): void;
}

interface StickyEntry {
  accountId: string;
  at: number;
}

export function createScheduler(accounts: AccountStore, log: Logger): Scheduler {
  const sticky = new Map<string, StickyEntry>();
  const rlPending = new Map<string, RateLimitObservation>();
  let rr = 0;
  let rlTimer: NodeJS.Timeout | null = null;

  function healthy(a: Account, now: number): boolean {
    if (a.status !== "active") return false;
    if (a.cooldownUntil && a.cooldownUntil * 1000 > now) return false;
    return true;
  }

  /**
   * 到期的耗尽账号放回池子。
   * 不做时间节流，而是先用已经读出来的账号列表判断「有没有到期的」，
   * 有才写库——既不会每请求一次写，也不会让刚到点的号多关一会儿。
   */
  function reviveIfDue(all: Account[], nowSec: number): Account[] {
    const due = all.some(
      (a) => a.status === "exhausted" && (!a.exhaustedUntil || a.exhaustedUntil <= nowSec)
    );
    if (!due) return all;
    try {
      const n = accounts.reviveDue(nowSec);
      if (n > 0) {
        log.info("revived " + n + " exhausted account(s) after quota reset");
        return accounts.list();
      }
    } catch (e) {
      log.warn("reviveDue failed: " + (e instanceof Error ? e.message : String(e)));
    }
    return all;
  }

  function pruneSticky(now: number): void {
    if (sticky.size <= STICKY_MAX) {
      for (const [k, v] of sticky) if (now - v.at > STICKY_TTL_MS) sticky.delete(k);
      return;
    }
    const entries = [...sticky.entries()].sort((a, b) => a[1].at - b[1].at);
    const drop = entries.slice(0, entries.length - STICKY_MAX);
    for (const [k] of drop) sticky.delete(k);
  }

  /** 轮询：按 weight 展开成槽位，依次取 */
  function roundRobin(pool: Account[]): Account | null {
    if (!pool.length) return null;
    const slots: Account[] = [];
    for (const a of pool) {
      const w = Math.max(1, Math.min(10, a.weight));
      for (let i = 0; i < w; i++) slots.push(a);
    }
    const chosen = slots[rr % slots.length];
    rr = (rr + 1) % Math.max(1, slots.length);
    return chosen ?? null;
  }

  function pick(opts: PickOptions): Account | null {
    const now = Date.now();
    pruneSticky(now);

    let all = accounts.list();
    all = reviveIfDue(all, Math.floor(now / 1000));
    const pool = all.filter((a) => healthy(a, now));

    /* 1) API Key 绑定了固定账号 */
    if (opts.preferredAccountId) {
      const bound = pool.find((a) => a.id === opts.preferredAccountId);
      if (bound) return bound;
    }

    /* 2) 会话粘性 */
    const st = sticky.get(opts.sessionKey);
    if (st) {
      const held = pool.find((a) => a.id === st.accountId);
      if (held) {
        st.at = now;
        return held;
      }
      sticky.delete(opts.sessionKey);
    }

    /* 3) 轮询 */
    const chosen = roundRobin(pool);
    if (chosen) sticky.set(opts.sessionKey, { accountId: chosen.id, at: now });
    return chosen;
  }

  function reportSuccess(accountId: string): void {
    const a = accounts.get(accountId);
    if (a && (a.errorCount > 0 || a.cooldownUntil)) {
      accounts.markOk(accountId);
    }
  }

  function dropStickyFor(accountId: string): void {
    for (const [k, v] of sticky) if (v.accountId === accountId) sticky.delete(k);
  }

  function reportFailure(accountId: string, status: number, message: string): void {
    const cooldown = status === 401 || status === 403 ? 10 * 60_000 : status === 429 ? 60_000 : 30_000;
    accounts.markError(accountId, "HTTP " + status + " " + message, cooldown);
    dropStickyFor(accountId);
    log.warn("account cooled down", { account: accountId, status, cooldownMs: cooldown });
  }

  function reportExhausted(accountId: string, reason: string, resetAtSec: number): void {
    accounts.markExhausted(accountId, reason, resetAtSec);
    dropStickyFor(accountId);
    log.warn("account marked exhausted", {
      account: accountId,
      reason,
      resumeAt: new Date(resetAtSec * 1000).toISOString()
    });
  }

  function flushRateLimits(): void {
    if (!rlPending.size) return;
    const batch = [...rlPending.entries()];
    rlPending.clear();
    for (const [id, rl] of batch) {
      try {
        accounts.saveRateLimit(id, rl);
      } catch (e) {
        log.warn("saveRateLimit failed: " + (e instanceof Error ? e.message : String(e)));
      }
    }
  }

  function observeRateLimit(accountId: string, rl: RateLimitObservation): void {
    rlPending.set(accountId, rl);
    if (!rlTimer) {
      rlTimer = setTimeout(() => {
        rlTimer = null;
        flushRateLimits();
      }, RL_FLUSH_MS);
      rlTimer.unref();
    }
  }

  function invalidateSession(sessionKey: string): void {
    sticky.delete(sessionKey);
  }

  function snapshot(): { accounts: number; active: number; sticky: number; cooling: number; exhausted: number } {
    const now = Date.now();
    const all = accounts.list();
    return {
      accounts: all.length,
      active: all.filter((a) => healthy(a, now)).length,
      sticky: sticky.size,
      cooling: all.filter((a) => a.cooldownUntil && a.cooldownUntil * 1000 > now).length,
      exhausted: all.filter((a) => a.status === "exhausted").length
    };
  }

  function stop(): void {
    if (rlTimer) {
      clearTimeout(rlTimer);
      rlTimer = null;
    }
    flushRateLimits();
    sticky.clear();
  }

  return {
    pick,
    reportSuccess,
    reportFailure,
    reportExhausted,
    observeRateLimit,
    invalidateSession,
    snapshot,
    stop
  };
}
