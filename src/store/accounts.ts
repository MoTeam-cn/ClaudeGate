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
import { toAccount } from "./accounts/schema.ts";
import type { Row } from "./accounts/schema.ts";
import { createAccountOps } from "./accounts/ops.ts";
export * from "./accounts/schema.ts";

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

  /* 状态与生命周期整体搬到 accounts/ops.ts 了 */
  const ops = createAccountOps(db);
  const {
    setStatus, markOk, markError, bumpRequest, clearCooldowns, countByStatus,
    markExhausted, reviveDue, clearExhausted, ensureDeviceId, ensureCcVersion,
    saveUsage, saveRateLimit
  } = ops;

  return { list, get, create, update, remove, ...ops };
}
