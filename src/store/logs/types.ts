/** 日志存储的形状：行、分页、统计、批量写输入、句柄 */

import type { RequestLogInput, RequestLogQuery, RuntimeLogQuery, RuntimeLogRow } from "../../types.ts";

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

