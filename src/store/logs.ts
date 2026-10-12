import { bind } from "./db.ts";
import type { Database } from "./db.ts";
import type { RequestLogInput, RequestLogQuery, RuntimeLogQuery, RuntimeLogRow } from "../types.ts";
import { queryRequests as qRequests, queryRuntime as qRuntime } from "./logs/query.ts";
import type { LogStats, LogStore, RuntimeLogInput } from "./logs/types.ts";
export * from "./logs/types.ts";

/* 运行日志批量写：攒批提交，避免每条日志一次事务 */
const RUNTIME_BATCH_MAX = 200;
const RUNTIME_FLUSH_MS = 400;

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

  /* 两条查询搬到 logs/query.ts 了，这里包一层把 db 传进去 */
  return {
    writeRequest,
    queryRequests: (q) => qRequests(db, q),
    runtime,
    queryRuntime: (q) => qRuntime(db, q, flush),
    flush,
    prune,
    stats,
    close
  };
}

