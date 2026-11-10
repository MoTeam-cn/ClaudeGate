import { DEFAULT_REFRESH_LEAD_SEC } from "./credentials.ts";
import type { CredentialManager } from "./credentials.ts";
import type { Account, AccountStore, Config, Logger } from "../types.ts";

/** 一次巡检的明细 */
export interface TokenSweepResult {
  at: number;
  /** 强制模式下带 forced=true，表示不看剩余时间全部刷一遍 */
  forced: boolean;
  scanned: number;
  refreshed: number;
  failed: number;
  /** 命中了但刷新器内部跳过（停用 / 无 refresh_token） */
  skipped: number;
  results: Array<{ id: string; label: string; ok: boolean; error: string | null; expiresAt: number | null }>;
}

export interface TokenRefreshState {
  enabled: boolean;
  intervalSec: number;
  leadSec: number;
  /** 正在跑一轮巡检 */
  busy: boolean;
  lastRunAt: number | null;
  lastOkAt: number | null;
  lastError: string | null;
  lastScanned: number;
  lastRefreshed: number;
  lastFailed: number;
  totalRefreshed: number;
  totalFailed: number;
  /** 请求路径上兜底刷了几次 —— 这个数长期非零说明巡检没覆盖住 */
  requestPathRefreshes: number;
  nextRunAt: number | null;
}

export interface TokenRefreshLoop {
  start(): void;
  stop(): void;
  state(): TokenRefreshState;
  /** 扫一遍。force=true 时不看剩余时间，把所有 oauth 号都刷一遍 */
  sweep(force?: boolean): Promise<TokenSweepResult>;
  /** 只刷一个号 */
  refreshOne(accountId: string): Promise<TokenSweepResult>;
}

/**
 * access_token 的后台维护。
 *
 * 之前只有请求路径上的兜底（credentials.ensure）：请求来了发现快过期才去刷。
 * 问题是「快过期」和「已经过期」之间只有一个请求的间隔 —— 上游一旦在
 * 刷新过程中返回 401，那个请求就白失败了；并发一多还会几个请求同时发现过期。
 *
 * 现在改成后台定时巡检：每 intervalSec 秒扫一遍，剩余时间不足 leadSec 的提前刷掉。
 * 请求路径上的兜底保留，但它只是保险丝 —— 真触发时会 warn 并计数。
 */
export function createTokenRefreshLoop(
  cfg: Config,
  log: Logger,
  accounts: AccountStore,
  credentials: CredentialManager
): TokenRefreshLoop {
  let timer: NodeJS.Timeout | null = null;
  let busy = false;

  let lastRunAt: number | null = null;
  let lastOkAt: number | null = null;
  let lastError: string | null = null;
  let lastScanned = 0;
  let lastRefreshed = 0;
  let lastFailed = 0;
  let totalRefreshed = 0;
  let totalFailed = 0;

  const intervalSec = Math.max(15, cfg.tokenRefreshIntervalSec);
  const leadSec = Math.max(60, cfg.tokenRefreshLeadSec || DEFAULT_REFRESH_LEAD_SEC);

  function emptyResult(forced: boolean): TokenSweepResult {
    return { at: Date.now(), forced, scanned: 0, refreshed: 0, failed: 0, skipped: 0, results: [] };
  }

  /** 返回 null 表示上一轮还在跑、这轮直接放弃；调用方据此决定要不要覆盖统计 */
  async function run(forced: boolean, only: Account | null): Promise<TokenSweepResult | null> {
    const out = emptyResult(forced);
    if (busy) {
      /* 上一轮还没跑完。不排队 —— 下一轮 60 秒后又来，排下去只会堆起来 */
      return null;
    }
    busy = true;
    try {
      const all = only ? [only] : accounts.list();
      out.scanned = all.length;

      for (const acc of all) {
        if (acc.kind !== "oauth") {
          out.skipped++;
          continue;
        }
        if (!acc.refreshToken || acc.status === "disabled") {
          out.skipped++;
          continue;
        }
        if (!forced && !credentials.needsRefresh(acc, leadSec)) continue;

        const before = acc.expiresAt;
        let next: Account;
        try {
          next = await credentials.refreshNow(acc);
        } catch (e) {
          /* refreshNow 内部已经 try/catch 并落库了，这里只是兜住意外 */
          const msg = e instanceof Error ? e.message : String(e);
          out.failed++;
          out.results.push({ id: acc.id, label: acc.label, ok: false, error: msg, expiresAt: before });
          continue;
        }

        /*
         * 成功判定不能只看 expires_at：账号可能刚建好、剩余时间本来就是这个值，
         * 刷完之后算出来的 expires_at 与 before 一模一样，会被误判成失败。
         * 令牌本身变了才是硬证据 —— 失败时 refreshNow 原样返回传入的账号。
         */
        const fresh = accounts.get(acc.id) ?? next;
        const ok = next.accessToken !== acc.accessToken || next.expiresAt !== before;
        if (ok) out.refreshed++;
        else out.failed++;
        out.results.push({
          id: acc.id,
          label: fresh.label,
          ok,
          error: ok ? null : (fresh.lastError ?? "刷新后 expires_at 没变"),
          expiresAt: fresh.expiresAt
        });
      }
      return out;
    } finally {
      busy = false;
    }
  }

  function record(out: TokenSweepResult): void {
    lastRunAt = out.at;
    lastScanned = out.scanned;
    lastRefreshed = out.refreshed;
    lastFailed = out.failed;
    totalRefreshed += out.refreshed;
    totalFailed += out.failed;
    if (out.failed > 0) {
      const bad = out.results.filter((r) => !r.ok);
      lastError = bad.length ? bad.map((r) => r.label + ": " + String(r.error ?? "")).join("; ") : "刷新失败";
      log.warn("token sweep finished with failures", { refreshed: out.refreshed, failed: out.failed });
    } else {
      lastError = null;
      lastOkAt = out.at;
      if (out.refreshed > 0) log.info("token sweep refreshed", { refreshed: out.refreshed });
    }
  }

  async function sweep(force = false): Promise<TokenSweepResult> {
    const out = await run(force, null);
    /* 撞上正在跑的上一轮就回空结果，但绝不拿它覆盖上一轮的真实统计 */
    if (!out) return emptyResult(force);
    record(out);
    return out;
  }

  async function refreshOne(accountId: string): Promise<TokenSweepResult> {
    const acc = accounts.get(accountId);
    if (!acc) {
      const out = emptyResult(true);
      out.results.push({ id: accountId, label: accountId, ok: false, error: "账号不存在", expiresAt: null });
      out.failed = 1;
      return out;
    }
    const out = await run(true, acc);
    if (out) record(out);
    return out ?? emptyResult(true);
  }

  function tick(): void {
    if (!cfg.tokenAutoRefresh) return;
    void sweep(false).catch((e) => {
      lastError = e instanceof Error ? e.message : String(e);
      log.error("token sweep crashed: " + lastError);
    });
  }

  function start(): void {
    if (timer) return;
    if (!cfg.tokenAutoRefresh) {
      log.info("token auto refresh disabled");
      return;
    }
    log.info("token auto refresh every " + intervalSec + "s, lead " + leadSec + "s");
    /* 启动后先跑一轮：进程刚起来时库里可能已经躺着一堆过期号 */
    setTimeout(tick, 3000).unref();
    timer = setInterval(tick, intervalSec * 1000);
    timer.unref();
  }

  function stop(): void {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  function state(): TokenRefreshState {
    return {
      enabled: cfg.tokenAutoRefresh,
      intervalSec,
      leadSec,
      busy,
      lastRunAt,
      lastOkAt,
      lastError,
      lastScanned,
      lastRefreshed,
      lastFailed,
      totalRefreshed,
      totalFailed,
      requestPathRefreshes: credentials.stats().requestPathRefreshes,
      nextRunAt: timer && cfg.tokenAutoRefresh ? Date.now() + intervalSec * 1000 : null
    };
  }

  return { start, stop, state, sweep, refreshOne };
}
