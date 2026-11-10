import { refreshUpstream } from "../oauth.ts";
import { nowSec } from "../utils.ts";
import type { Account, AccountStore, Config, Logger } from "../types.ts";

export interface CredentialManager {
  /** 请求路径上的兜底：临近过期才刷，正常情况下应当由后台巡检提前刷好 */
  ensure(account: Account): Promise<Account>;
  /** 强制刷新，不看剩余时间。后台巡检与面板「刷新凭证」按钮都走这里 */
  refreshNow(account: Account): Promise<Account>;
  /** 这个号该不该刷新了（oauth + 有 refresh_token + 剩余时间不足 leadSec） */
  needsRefresh(account: Account, leadSec?: number): boolean;
  /** 刷新失败后标记，强制下次重新拉 */
  invalidate(accountId: string): void;
  /** 请求路径上真的触发了刷新 —— 说明后台巡检漏了，用于告警 */
  stats(): { requestPathRefreshes: number; lastRequestPathRefreshAt: number | null };
}

/** 请求路径上的提前量。后台巡检比它宽得多，这个值只用于兜底 */
const REFRESH_WINDOW_SEC = 180;

/**
 * 默认提前量：10 分钟。
 * 后台巡检间隔默认 60 秒，10 分钟的提前量能容忍 10 次巡检失败，
 * 足够扛过 FClash 抖动或上游 5xx 连发。
 */
export const DEFAULT_REFRESH_LEAD_SEC = 600;

export function createCredentialManager(cfg: Config, log: Logger, accounts: AccountStore): CredentialManager {
  const inFlight = new Map<string, Promise<Account>>();
  let requestPathRefreshes = 0;
  let lastRequestPathRefreshAt: number | null = null;

  async function refresh(account: Account): Promise<Account> {
    try {
      const tok = await refreshUpstream(cfg, {
        kind: "oauth",
        refresh_token: account.refreshToken ?? undefined,
        client_id: account.clientId ?? undefined,
        scope: account.scope ?? undefined
      });
      const expiresAt = nowSec() + (Number(tok.expires_in) || 3600);
      const next = accounts.update(account.id, {
        accessToken: tok.access_token,
        refreshToken: tok.refresh_token ?? account.refreshToken,
        expiresAt,
        scope: tok.scope ?? account.scope
      });
      accounts.markOk(account.id);
      log.info("account token refreshed", { account: account.id, expiresIn: Number(tok.expires_in) || 3600 });
      return next ?? account;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log.error("account token refresh failed", { account: account.id, error: msg });
      /* 刷新令牌被拒基本等于号废了，拉长冷却让调度器避开 */
      const dead = /invalid_grant|invalid_client|40[13]/.test(msg);
      accounts.markError(account.id, "refresh failed: " + msg, dead ? 30 * 60_000 : 60_000);
      if (dead) accounts.setStatus(account.id, "error", "refresh token rejected");
      return account;
    }
  }

  function needsRefresh(account: Account, leadSec: number = DEFAULT_REFRESH_LEAD_SEC): boolean {
    if (account.kind !== "oauth") return false;
    if (!account.refreshToken) return false;
    /* 停用的号不刷 —— 刷了也没人用，还白耗刷新令牌 */
    if (account.status === "disabled") return false;
    /* 没有 expires_at 说明建号时没拿到 expires_in，只能等请求路径兜底 */
    if (!account.expiresAt) return false;
    return account.expiresAt - nowSec() <= leadSec;
  }

  async function refreshNow(account: Account): Promise<Account> {
    if (account.kind !== "oauth" || !account.refreshToken) return account;

    const running = inFlight.get(account.id);
    if (running) return running;

    const task = refresh(account).finally(() => inFlight.delete(account.id));
    inFlight.set(account.id, task);
    return task;
  }

  async function ensure(account: Account): Promise<Account> {
    if (account.kind === "apikey") return account;
    /* 走请求路径说明后台巡检没赶上 —— 记一笔，面板能看到 */
    if (account.expiresAt && account.expiresAt - nowSec() > REFRESH_WINDOW_SEC) return account;
    if (!account.refreshToken) return account;

    const running = inFlight.get(account.id);
    if (running) return running;

    requestPathRefreshes++;
    lastRequestPathRefreshAt = Date.now();
    log.warn("token refreshed on request path (background sweep missed it)", { account: account.id });
    return refreshNow(account);
  }

  function invalidate(accountId: string): void {
    inFlight.delete(accountId);
  }

  function stats(): { requestPathRefreshes: number; lastRequestPathRefreshAt: number | null } {
    return { requestPathRefreshes, lastRequestPathRefreshAt };
  }

  return { ensure, refreshNow, needsRefresh, invalidate, stats };
}
