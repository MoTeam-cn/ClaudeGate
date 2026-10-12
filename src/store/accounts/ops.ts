import { bind } from "../db.ts";
import type { Database } from "../db.ts";
import { newDeviceId } from "../../userid.ts";
import { pickVersion } from "../../fingerprint/attribution.ts";
import type { AccountStatus, RateLimitObservation, UsageSnapshot } from "../../types.ts";

/**
 * 账号的状态与生命周期操作。
 *
 * 这些原本是 createAccountStore 里的闭包，靠外层的 raw 打库。
 * 搬出来时在 createAccountOps 里重新定义 raw = db.raw，
 * 所以每个函数的函数体一字未改。
 */
export function createAccountOps(db: Database) {
  const raw = db.raw;

  function setStatus(id: string, status: AccountStatus, lastError?: string | null): void {
    raw
      .prepare("UPDATE accounts SET status = ?, last_error = ?, updated_at = ? WHERE id = ?")
      .run(...bind([status, lastError ?? null, Math.floor(Date.now() / 1000), id]));
  }

  function markOk(id: string): void {
    raw
      .prepare("UPDATE accounts SET error_count = 0, last_error = NULL, cooldown_until = NULL, updated_at = ? WHERE id = ?")
      .run(...bind([Math.floor(Date.now() / 1000), id]));
  }

  function markError(id: string, message: string, cooldownMs: number): void {
    const now = Math.floor(Date.now() / 1000);
    const cooldownUntil = cooldownMs > 0 ? now + Math.floor(cooldownMs / 1000) : null;
    raw
      .prepare(
        "UPDATE accounts SET error_count = error_count + 1, last_error = ?, cooldown_until = ?, updated_at = ? WHERE id = ?"
      )
      .run(...bind([message.slice(0, 500), cooldownUntil, now, id]));
  }

  function bumpRequest(id: string): void {
    raw.prepare("UPDATE accounts SET request_count = request_count + 1, updated_at = ? WHERE id = ?")
      .run(...bind([Math.floor(Date.now() / 1000), id]));
  }

  function clearCooldowns(): void {
    raw.prepare("UPDATE accounts SET cooldown_until = NULL").run();
  }

  function countByStatus(): Record<string, number> {
    const rows = raw.prepare("SELECT status, COUNT(*) AS n FROM accounts GROUP BY status").all() as unknown as Array<{
      status: string;
      n: number;
    }>;
    const out: Record<string, number> = {};
    for (const r of rows) out[r.status] = r.n;
    return out;
  }

  function markExhausted(id: string, reason: string, untilSec: number): void {
    const now = Math.floor(Date.now() / 1000);
    raw
      .prepare(
        "UPDATE accounts SET status = 'exhausted', exhausted_until = ?, exhausted_reason = ?, last_error = ?, cooldown_until = NULL, updated_at = ? WHERE id = ?"
      )
      .run(...bind([untilSec, reason.slice(0, 300), reason.slice(0, 500), now, id]));
  }

  function reviveDue(nowSec: number): number {
    const r = raw
      .prepare(
        "UPDATE accounts SET status = 'active', exhausted_until = NULL, exhausted_reason = NULL, error_count = 0, last_error = NULL, updated_at = ? " +
          "WHERE status = 'exhausted' AND (exhausted_until IS NULL OR exhausted_until <= ?)"
      )
      .run(...bind([Math.floor(Date.now() / 1000), nowSec]));
    return Number(r.changes);
  }

  /** 取这个号的 device_id；没有就生成一个并落库，之后固定不变 */
  function ensureDeviceId(id: string): string {
    const row = raw.prepare("SELECT device_id FROM accounts WHERE id = ?").get(...bind([id])) as
      | { device_id: string | null }
      | undefined;
    if (row?.device_id) return row.device_id;
    const fresh = newDeviceId();
    raw
      .prepare("UPDATE accounts SET device_id = ?, updated_at = ? WHERE id = ?")
      .run(...bind([fresh, Math.floor(Date.now() / 1000), id]));
    return fresh;
  }

  /**
   * 版本号按号固定，且只升不降。
   *
   * 为什么不能直接用客户端报的：device_id 是按号固定的（一个号 = 一台设备），
   * 而版本号如果跟着客户端走，同一个 device_id 上就会出现
   * 2.1.300 -> 2.1.290 -> 2.1.300 这种**物理上不可能**的模式
   * —— 真机自动更新只会往前走，没人会退回旧版。
   * 多人共用一个号池时必然撞上，所以在这里钉住。
   */
  function ensureCcVersion(id: string, seen: string | null): string {
    const row = raw.prepare("SELECT cc_version FROM accounts WHERE id = ?").get(...bind([id])) as
      | { cc_version: string | null }
      | undefined;
    const stored = row?.cc_version ?? null;
    const { use, update } = pickVersion(stored, seen);
    if (update) {
      raw
        .prepare("UPDATE accounts SET cc_version = ?, updated_at = ? WHERE id = ?")
        .run(...bind([use, Math.floor(Date.now() / 1000), id]));
    }
    return use;
  }

  function clearExhausted(id: string): void {
    raw
      .prepare(
        "UPDATE accounts SET status = 'active', exhausted_until = NULL, exhausted_reason = NULL, error_count = 0, last_error = NULL, updated_at = ? WHERE id = ?"
      )
      .run(...bind([Math.floor(Date.now() / 1000), id]));
  }

  function saveUsage(id: string, usage: UsageSnapshot): void {
    raw
      .prepare("UPDATE accounts SET usage_json = ?, usage_at = ?, updated_at = ? WHERE id = ?")
      .run(...bind([JSON.stringify(usage), usage.fetchedAt, Math.floor(Date.now() / 1000), id]));
  }

  function saveRateLimit(id: string, rl: RateLimitObservation): void {
    raw
      .prepare("UPDATE accounts SET rate_limit_json = ?, updated_at = ? WHERE id = ?")
      .run(...bind([JSON.stringify(rl), Math.floor(Date.now() / 1000), id]));
  }

  return {
    setStatus,
    markOk,
    markError,
    bumpRequest,
    clearCooldowns,
    countByStatus,
    markExhausted,
    reviveDue,
    clearExhausted,
    ensureDeviceId,
    ensureCcVersion,
    saveUsage,
    saveRateLimit
  };
}
