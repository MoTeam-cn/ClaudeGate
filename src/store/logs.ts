import { bind } from "./db.ts";
import type { Database } from "./db.ts";
import type { RequestLogInput, RequestLogQuery, RuntimeLogQuery, RuntimeLogRow } from "../types.ts";

export interface RequestLogRow {
  id: string;
  ts: number;
  clientIp: string | null;
  apiKeyId: string | null;
  apiKeyName: string | null;
  protocol: string | null;
  method: string | null;
  path: string | null;
  model: string | null;
  upstreamModel: string | null;
  accountId: string | null;
  accountLabel: string | null;
  status: number | null;
  outcome: string;
  blockReason: string | null;
  blockDetail: string | null;
  durationMs: number | null;
  stream: boolean;
  promptTokens: number;
  completionTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  errorMessage: string | null;
  userAgent: string | null;
}

export interface Paged<T> {
  rows: T[];
  total: number;
}

export interface LogStats {
  totalRequests: number;
  blocked: number;
  errors: number;
  last24h: number;
  runtimeEntries: number;
}

export interface RuntimeLogInput {
  ts: number;
  level: string;
  scope: string | null;
  message: string;
  detail: string | null;
}

const RUNTIME_BATCH_MAX = 200;
const RUNTIME_FLUSH_MS = 400;

export interface LogStore {
  writeRequest(input: RequestLogInput): void;
  queryRequests(q: RequestLogQuery): Paged<RequestLogRow>;
  runtime(level: string, scope: string, message: string, detail?: unknown): void;
  queryRuntime(q: RuntimeLogQuery): Paged<RuntimeLogRow>;
  flush(): void;
  prune(maxAgeDays: number, maxRuntimeRows: number): void;
  stats(): LogStats;
  close(): void;
}

export function createLogStore(db: Database): LogStore {
  const raw = db.raw;

  /* ---- 运行日志批量写：攒批提交，避免每条日志一次事务 ---- */
  let pending: RuntimeLogInput[] = [];
  let timer: NodeJS.Timeout | null = null;

  function flush(): void {
    if (!pending.length) return;
    const batch = pending;
    pending = [];
    const stmt = raw.prepare("INSERT INTO runtime_logs (ts, level, scope, message, detail) VALUES (?, ?, ?, ?, ?)");
    raw.exec("BEGIN");
    try {
      for (const r of batch) stmt.run(...bind([r.ts, r.level, r.scope, r.message, r.detail]));
      raw.exec("COMMIT");
    } catch {
      try {
        raw.exec("ROLLBACK");
      } catch {
        /* 回滚失败就丢弃这批，日志不能拖垮主流程 */
      }
    }
  }

  function schedule(): void {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      flush();
    }, RUNTIME_FLUSH_MS);
    timer.unref();
  }

  function runtime(level: string, scope: string, message: string, detail?: unknown): void {
    let d: string | null = null;
    if (detail !== undefined) {
      try {
        d = JSON.stringify(detail);
      } catch {
        d = String(detail);
      }
    }
    pending.push({ ts: Date.now(), level, scope: scope || null, message, detail: d });
    if (pending.length >= RUNTIME_BATCH_MAX) flush();
    else schedule();
  }

  function writeRequest(input: RequestLogInput): void {
    raw
      .prepare(
        "INSERT OR REPLACE INTO request_logs (id, ts, client_ip, api_key_id, api_key_name, protocol, method, path, model, upstream_model, account_id, account_label, status, outcome, block_reason, block_detail, duration_ms, stream, prompt_tokens, completion_tokens, cache_creation_tokens, cache_read_tokens, error_message, user_agent) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
      )
      .run(
        ...bind([
          input.id,
          input.ts,
          input.clientIp,
          input.apiKeyId,
          input.apiKeyName,
          input.protocol,
          input.method,
          input.path,
          input.model,
          input.upstreamModel,
          input.accountId,
          input.accountLabel,
          input.status,
          input.outcome,
          input.blockReason,
          input.blockDetail,
          input.durationMs,
          input.stream ? 1 : 0,
          input.promptTokens,
          input.completionTokens,
          input.cacheCreationTokens,
          input.cacheReadTokens,
          input.errorMessage,
          input.userAgent
        ])
      );
  }

  function queryRequests(q: RequestLogQuery): Paged<RequestLogRow> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (q.outcome) {
      where.push("outcome = ?");
      params.push(q.outcome);
    }
    if (q.protocol) {
      where.push("protocol = ?");
      params.push(q.protocol);
    }
    if (q.apiKeyId) {
      where.push("api_key_id = ?");
      params.push(q.apiKeyId);
    }
    if (q.accountId) {
      where.push("account_id = ?");
      params.push(q.accountId);
    }
    if (q.since) {
      where.push("ts >= ?");
      params.push(q.since);
    }
    if (q.search) {
      where.push("(id LIKE ? OR path LIKE ? OR model LIKE ? OR account_label LIKE ? OR error_message LIKE ? OR block_reason LIKE ? OR client_ip LIKE ?)");
      const like = "%" + q.search + "%";
      for (let i = 0; i < 7; i++) params.push(like);
    }
    const clause = where.length ? " WHERE " + where.join(" AND ") : "";

    const totalRow = raw.prepare("SELECT COUNT(*) AS n FROM request_logs" + clause).get(...bind(params)) as
      | { n: number }
      | undefined;
    const total = totalRow?.n ?? 0;

    const limit = Math.max(1, Math.min(500, q.limit ?? 50));
    const offset = Math.max(0, q.offset ?? 0);
    const rows = raw
      .prepare("SELECT * FROM request_logs" + clause + " ORDER BY ts DESC LIMIT ? OFFSET ?")
      .all(...bind([...params, limit, offset])) as unknown as Array<Record<string, unknown>>;

    return {
      rows: rows.map((r) => ({
        id: String(r.id),
        ts: Number(r.ts),
        clientIp: (r.client_ip as string) ?? null,
        apiKeyId: (r.api_key_id as string) ?? null,
        apiKeyName: (r.api_key_name as string) ?? null,
        protocol: (r.protocol as string) ?? null,
        method: (r.method as string) ?? null,
        path: (r.path as string) ?? null,
        model: (r.model as string) ?? null,
        upstreamModel: (r.upstream_model as string) ?? null,
        accountId: (r.account_id as string) ?? null,
        accountLabel: (r.account_label as string) ?? null,
        status: r.status === null || r.status === undefined ? null : Number(r.status),
        outcome: String(r.outcome),
        blockReason: (r.block_reason as string) ?? null,
        blockDetail: (r.block_detail as string) ?? null,
        durationMs: r.duration_ms === null || r.duration_ms === undefined ? null : Number(r.duration_ms),
        stream: Number(r.stream) === 1,
        promptTokens: Number(r.prompt_tokens ?? 0),
        completionTokens: Number(r.completion_tokens ?? 0),
        cacheCreationTokens: Number(r.cache_creation_tokens ?? 0),
        cacheReadTokens: Number(r.cache_read_tokens ?? 0),
        errorMessage: (r.error_message as string) ?? null,
        userAgent: (r.user_agent as string) ?? null
      })),
      total
    };
  }

  function queryRuntime(q: RuntimeLogQuery): Paged<RuntimeLogRow> {
    flush();
    const where: string[] = [];
    const params: unknown[] = [];
    if (q.level) {
      where.push("level = ?");
      params.push(q.level);
    }
    if (q.scope) {
      where.push("scope = ?");
      params.push(q.scope);
    }
    if (q.since) {
      where.push("ts >= ?");
      params.push(q.since);
    }
    if (q.search) {
      where.push("(message LIKE ? OR detail LIKE ?)");
      const like = "%" + q.search + "%";
      params.push(like, like);
    }
    const clause = where.length ? " WHERE " + where.join(" AND ") : "";

    const totalRow = raw.prepare("SELECT COUNT(*) AS n FROM runtime_logs" + clause).get(...bind(params)) as
      | { n: number }
      | undefined;

    const limit = Math.max(1, Math.min(500, q.limit ?? 100));
    const offset = Math.max(0, q.offset ?? 0);
    const rows = raw
      .prepare("SELECT * FROM runtime_logs" + clause + " ORDER BY id DESC LIMIT ? OFFSET ?")
      .all(...bind([...params, limit, offset])) as unknown as RuntimeLogRow[];

    return { rows, total: totalRow?.n ?? 0 };
  }

  function prune(maxAgeDays: number, maxRuntimeRows: number): void {
    flush();
    const cutoff = Date.now() - maxAgeDays * 86400000;
    raw.prepare("DELETE FROM request_logs WHERE ts < ?").run(...bind([cutoff]));
    raw.prepare("DELETE FROM runtime_logs WHERE ts < ?").run(...bind([cutoff]));
    raw
      .prepare("DELETE FROM runtime_logs WHERE id NOT IN (SELECT id FROM runtime_logs ORDER BY id DESC LIMIT ?)")
      .run(...bind([maxRuntimeRows]));
  }

  function stats(): LogStats {
    flush();
    const now = Date.now();
    const total = raw.prepare("SELECT COUNT(*) AS n FROM request_logs").get() as { n: number } | undefined;
    const blocked = raw.prepare("SELECT COUNT(*) AS n FROM request_logs WHERE outcome = 'blocked'").get() as
      | { n: number }
      | undefined;
    const errors = raw.prepare("SELECT COUNT(*) AS n FROM request_logs WHERE outcome = 'error'").get() as
      | { n: number }
      | undefined;
    const recent = raw.prepare("SELECT COUNT(*) AS n FROM request_logs WHERE ts >= ?").get(...bind([now - 86400000])) as
      | { n: number }
      | undefined;
    const rt = raw.prepare("SELECT COUNT(*) AS n FROM runtime_logs").get() as { n: number } | undefined;
    return {
      totalRequests: total?.n ?? 0,
      blocked: blocked?.n ?? 0,
      errors: errors?.n ?? 0,
      last24h: recent?.n ?? 0,
      runtimeEntries: rt?.n ?? 0
    };
  }

  function close(): void {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    flush();
  }

  return { writeRequest, queryRequests, runtime, queryRuntime, flush, prune, stats, close };
}
