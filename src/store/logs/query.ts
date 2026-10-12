import { bind } from "../db.ts";
import type { Database } from "../db.ts";
import type { Paged, RequestLogRow } from "./types.ts";
import type { RequestLogQuery, RuntimeLogRow, RuntimeLogQuery } from "../../types.ts";

/** 两条分页查询。原本是 createLogStore 的闭包，搬出来改成显式吃 db。 */

export function queryRequests(db: Database, q: RequestLogQuery): Paged<RequestLogRow> {
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

  const totalRow = db.raw.prepare("SELECT COUNT(*) AS n FROM request_logs" + clause).get(...bind(params)) as
    | { n: number }
    | undefined;
  const total = totalRow?.n ?? 0;

  const limit = Math.max(1, Math.min(500, q.limit ?? 50));
  const offset = Math.max(0, q.offset ?? 0);
  const rows = db.raw
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

export function queryRuntime(db: Database, q: RuntimeLogQuery, flush: () => void): Paged<RuntimeLogRow> {
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

  const totalRow = db.raw.prepare("SELECT COUNT(*) AS n FROM runtime_logs" + clause).get(...bind(params)) as
    | { n: number }
    | undefined;

  const limit = Math.max(1, Math.min(500, q.limit ?? 100));
  const offset = Math.max(0, q.offset ?? 0);
  const rows = db.raw
    .prepare("SELECT * FROM runtime_logs" + clause + " ORDER BY id DESC LIMIT ? OFFSET ?")
    .all(...bind([...params, limit, offset])) as unknown as RuntimeLogRow[];

  return { rows, total: totalRow?.n ?? 0 };
}

