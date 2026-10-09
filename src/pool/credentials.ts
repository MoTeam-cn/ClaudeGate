import { refreshUpstream } from "../oauth.ts";
import { nowSec } from "../utils.ts";
import type { Account, AccountStore, Config, Logger } from "../types.ts";

export interface CredentialManager {
  /** 取到可用的上游凭据，临近过期自动刷新（同一账号并发去重） */
  ensure(account: Account): Promise<Account>;
  /** 刷新失败后标记，强制下次重新拉 */
  invalidate(accountId: string): void;
}

const REFRESH_WINDOW_SEC = 180;

export function createCredentialManager(cfg: Config, log: Logger, accounts: AccountStore): CredentialManager {
  const inFlight = new Map<string, Promise<Account>>();

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
      log.info("account token refreshed", { account: account.id });
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

  async function ensure(account: Account): Promise<Account> {
    if (account.kind === "apikey") return account;
    if (account.expiresAt && account.expiresAt - nowSec() > REFRESH_WINDOW_SEC) return account;
    if (!account.refreshToken) return account;

    const running = inFlight.get(account.id);
    if (running) return running;

    const task = refresh(account).finally(() => inFlight.delete(account.id));
    inFlight.set(account.id, task);
    return task;
  }

  function invalidate(accountId: string): void {
    inFlight.delete(accountId);
  }

  return { ensure, invalidate };
}
