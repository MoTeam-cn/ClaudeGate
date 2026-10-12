import { bind } from "./db.ts";
import type { Database } from "./db.ts";
import { randHex } from "../utils.ts";
import { newDeviceId } from "../userid.ts";
import { pickVersion } from "../fingerprint/attribution.ts";
import type {
  Account,
  AccountInput,
  AccountKind,
  AccountStatus,
  RateLimitObservation,
  UsageSnapshot
} from "../types.ts";

interface Row {
  id: string;
  label: string;
  kind: string;
  access_token: string | null;
  refresh_token: string | null;
  api_key: string | null;
  expires_at: number | null;
  scope: string | null;
  client_id: string | null;
  mode: string | null;
  account_uuid: string | null;
  device_id: string | null;
  cc_version: string | null;
  email: string | null;
  status: string;
  last_error: string | null;
  error_count: number;
  request_count: number;
  weight: number;
  cooldown_until: number | null;
  exhausted_until: number | null;
  exhausted_reason: string | null;
  usage_json: string | null;
  usage_at: number | null;
  rate_limit_json: string | null;
  created_at: number;
  updated_at: number;
}

function parseJson<T>(s: string | null): T | null {
  if (!s) return null;
  try {
    return JSON.parse(s) as T;
  } catch {
    return null;
  }
}

function toAccount(r: Row): Account {
  return {
    id: r.id,
    label: r.label,
    kind: r.kind as AccountKind,
    accessToken: r.access_token,
    refreshToken: r.refresh_token,
    apiKey: r.api_key,
    expiresAt: r.expires_at,
    scope: r.scope,
    clientId: r.client_id,
    mode: r.mode,
    accountUuid: r.account_uuid,
    deviceId: r.device_id,
    ccVersion: r.cc_version,
    email: r.email,
    status: r.status as AccountStatus,
    lastError: r.last_error,
    errorCount: r.error_count,
    requestCount: r.request_count,
    weight: r.weight,
    cooldownUntil: r.cooldown_until,
    exhaustedUntil: r.exhausted_until,
    exhaustedReason: r.exhausted_reason,
    usage: parseJson<UsageSnapshot>(r.usage_json),
    usageAt: r.usage_at,
    rateLimit: parseJson<RateLimitObservation>(r.rate_limit_json),
    createdAt: r.created_at,
    updatedAt: r.updated_at
  };
}

export interface AccountStore {
  list(): Account[];
  get(id: string): Account | null;
  create(input: AccountInput): Account;
  update(id: string, patch: Partial<AccountInput> & { status?: AccountStatus }): Account | null;
  remove(id: string): boolean;
  setStatus(id: string, status: AccountStatus, lastError?: string | null): void;
  markOk(id: string): void;
  markError(id: string, message: string, cooldownMs: number): void;
  bumpRequest(id: string): void;
  clearCooldowns(): void;
  countByStatus(): Record<string, number>;
  /** 额度耗尽：标记为 exhausted 并记下恢复时刻 */
  markExhausted(id: string, reason: string, untilSec: number): void;
  /** 把到期的 exhausted 账号放回 active，返回放回的数量 */
  reviveDue(nowSec: number): number;
  /** 手动解除耗尽 */
  clearExhausted(id: string): void;
  /** 取号专属 device_id；没有就生成并落库 */
  ensureDeviceId(id: string): string;
  /**
   * 取这个号钉住的 Claude Code 版本号，**单调递增**：客户端报得更高就更新，
   * 报得更低则保持原值（真机自动更新不会回退）。
   * seen 为 null（客户端没带 UA）时只读不写。返回空串表示这个号还没有版本号。
   */
  ensureCcVersion(id: string, seen: string | null): string;
  /** 保存用量快照 */
  saveUsage(id: string, usage: UsageSnapshot): void;
  /** 保存从响应头观察到的限流状态 */
  saveRateLimit(id: string, rl: RateLimitObservation): void;
}

export function createAccountStore(db: Database): AccountStore {
  const raw = db.raw;

  function get(id: string): Account | null {
    const row = raw.prepare("SELECT * FROM accounts WHERE id = ?").get(...bind([id])) as Row | undefined;
    return row ? toAccount(row) : null;
  }

  function list(): Account[] {
    const rows = raw.prepare("SELECT * FROM accounts ORDER BY created_at ASC").all() as unknown as Row[];
    return rows.map(toAccount);
  }

  function create(input: AccountInput): Account {
    const now = Math.floor(Date.now() / 1000);
    const id = "acc_" + randHex(8);
    raw
      .prepare(
        "INSERT INTO accounts (id, label, kind, access_token, refresh_token, api_key, expires_at, scope, client_id, mode, account_uuid, email, status, last_error, error_count, request_count, weight, cooldown_until, created_at, updated_at) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', NULL, 0, 0, ?, NULL, ?, ?)"
      )
      .run(
        ...bind([
          id,
          input.label,
          input.kind,
          input.accessToken ?? null,
          input.refreshToken ?? null,
          input.apiKey ?? null,
          input.expiresAt ?? null,
          input.scope ?? null,
          input.clientId ?? null,
          input.mode ?? null,
          input.accountUuid ?? null,
          input.email ?? null,
          input.weight ?? 1,
          now,
          now
        ])
      );
    const created = get(id);
    if (!created) throw new Error("account insert failed");
    return created;
  }

  function update(id: string, patch: Partial<AccountInput> & { status?: AccountStatus }): Account | null {
    const cur = get(id);
    if (!cur) return null;
    const now = Math.floor(Date.now() / 1000);
    const next = {
      label: patch.label ?? cur.label,
      kind: patch.kind ?? cur.kind,
      accessToken: patch.accessToken !== undefined ? patch.accessToken : cur.accessToken,
      refreshToken: patch.refreshToken !== undefined ? patch.refreshToken : cur.refreshToken,
      apiKey: patch.apiKey !== undefined ? patch.apiKey : cur.apiKey,
      expiresAt: patch.expiresAt !== undefined ? patch.expiresAt : cur.expiresAt,
      scope: patch.scope !== undefined ? patch.scope : cur.scope,
      clientId: patch.clientId !== undefined ? patch.clientId : cur.clientId,
      mode: patch.mode !== undefined ? patch.mode : cur.mode,
      accountUuid: patch.accountUuid !== undefined ? patch.accountUuid : cur.accountUuid,
      email: patch.email !== undefined ? patch.email : cur.email,
      weight: patch.weight !== undefined ? patch.weight : cur.weight,
      status: patch.status ?? cur.status
    };
    raw
      .prepare(
        "UPDATE accounts SET label = ?, kind = ?, access_token = ?, refresh_token = ?, api_key = ?, expires_at = ?, scope = ?, client_id = ?, mode = ?, account_uuid = ?, email = ?, weight = ?, status = ?, updated_at = ? WHERE id = ?"
      )
      .run(
        ...bind([
          next.label,
          next.kind,
          next.accessToken,
          next.refreshToken,
          next.apiKey,
          next.expiresAt,
          next.scope,
          next.clientId,
          next.mode,
          next.accountUuid,
          next.email,
          next.weight,
          next.status,
          now,
          id
        ])
      );
    return get(id);
  }

  function remove(id: string): boolean {
    const r = raw.prepare("DELETE FROM accounts WHERE id = ?").run(...bind([id]));
    return Number(r.changes) > 0;
  }

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
    list,
    get,
    create,
    update,
    remove,
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
