import type { Outcome } from "./account.ts";

export interface RequestLogInput {
  id: string;
  ts: number;
  clientIp: string;
  apiKeyId: string | null;
  apiKeyName: string | null;
  protocol: string;
  method: string;
  path: string;
  model: string | null;
  upstreamModel: string | null;
  accountId: string | null;
  accountLabel: string | null;
  status: number | null;
  outcome: Outcome;
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

export interface RequestLogQuery {
  limit?: number;
  offset?: number;
  outcome?: string;
  protocol?: string;
  apiKeyId?: string;
  accountId?: string;
  since?: number;
  search?: string;
}

export interface RuntimeLogQuery {
  limit?: number;
  offset?: number;
  level?: string;
  scope?: string;
  since?: number;
  search?: string;
}

export interface RuntimeLogRow {
  id: number;
  ts: number;
  level: string;
  scope: string | null;
  message: string;
  detail: string | null;
}

/** 一次请求的记账对象，路由处理器边处理边填，server 在收尾时落库 */
export interface RequestTracker {
  status: number | null;
  model: string | null;
  upstreamModel: string | null;
  accountId: string | null;
  accountLabel: string | null;
  outcome: Outcome;
  blockReason: string | null;
  blockDetail: string | null;
  stream: boolean;
  promptTokens: number;
  completionTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  errorMessage: string | null;
  /** 上游返回的错误类型（billing_error / rate_limit_error / ...） */
  errorType: string | null;
  /** 判定为额度耗尽时的恢复时刻 */
  exhaustedUntil: number | null;
  /** 判定为额度耗尽的原因 */
  exhaustedReason: string | null;
  /** 流式请求：收尾落库的钩子，由 server 设置 */
  finish?: (patch: Partial<RequestTracker>) => void;
}
