import type { IncomingMessage, ServerResponse, IncomingHttpHeaders } from "node:http";
import type { Agent as HttpsAgent } from "node:https";
import type { Agent as HttpAgent } from "node:http";
import type { ProxySpec } from "./net/proxy.ts";
import type { Database } from "./store/db.ts";
import type { AccountStore } from "./store/accounts.ts";
import type { ApiKeyStore } from "./store/apikeys.ts";
import type { LogStore } from "./store/logs.ts";
import type { SettingsStore } from "./store/settings.ts";
import type { Scheduler } from "./pool/scheduler.ts";
import type { CredentialManager } from "./pool/credentials.ts";
import type { QuotaGuard } from "./middleware/quota.ts";

/* 存储与调度的接口在这里转出，消费方只需要认 types.ts 一个入口 */
export type { Database } from "./store/db.ts";
export type { AccountStore } from "./store/accounts.ts";
export type { ApiKeyStore } from "./store/apikeys.ts";
export type { LogStore } from "./store/logs.ts";
export type { SettingsStore } from "./store/settings.ts";
export type { Scheduler } from "./pool/scheduler.ts";
export type { CredentialManager } from "./pool/credentials.ts";
export type { QuotaGuard } from "./middleware/quota.ts";

export type GuardMode = "strict" | "lenient" | "off";
export type StegoMode = "block" | "strip" | "log" | "off";
export type ReqIdMode = "error" | "always" | "off";
export type Protocol = "anthropic" | "openai" | "admin" | "other";

/** 每请求上下文：请求 ID、来源、协议，供响应与日志共用 */
export interface RequestMeta {
  id: string;
  startedAt: number;
  clientIp: string;
  protocol: Protocol;
  method: string;
  path: string;
  reqIdInResponse: ReqIdMode;
}
export type OAuthMode = "claude_ai" | "console" | "design";
export type LogLevel = "debug" | "info" | "warn" | "error";
export type CredentialKind = "oauth" | "apikey";

export interface Config {
  port: number;
  host: string;
  publicUrl: string;
  dataDir: string;
  secret: string;

  upstreamBase: string;
  upstreamProxy: string;
  tlsMin: string;
  /** 出站 TLS 密码套件；空串表示用 Node 默认 */
  tlsCiphers: string;
  tlsMax: string;
  upstreamAlpn: string;
  upstreamTimeoutMs: number;
  upstreamMaxSockets: number;

  maxBodyBytes: number;
  shutdownGraceMs: number;

  guardMode: GuardMode;
  guardRequire: string[];
  injectMissing: boolean;

  stegoMode: StegoMode;
  reqIdInResponse: ReqIdMode;

  trustProxy: boolean;
  adminToken: string;
  tokenTtlDays: number;

  oauthMode: OAuthMode;
  oauthClientId: string;
  oauthScopes: string[];
  oauthAuthorizeUrl: string;
  oauthTokenUrl: string;
  oauthManualRedirect: string;
  oauthRolesUrl: string;
  apiKeyUrl: string;

  defaultModel: string;
  maxTokensDefault: number;
  logLevel: LogLevel;

  /** 内部：到上游的 keep-alive Agent（https 目标） */
  agent?: HttpsAgent;
  /** 内部：到上游的 keep-alive Agent（http 目标，测试与内网用） */
  agentHttp?: HttpAgent;
  /** 内部：解析好的出站代理；null 表示直连 */
  proxy?: ProxySpec | null;
}

export interface Credential {
  kind: CredentialKind;
  access_token?: string;
  refresh_token?: string | null;
  api_key?: string;
  expires_at?: number;
  scope?: string;
  client_id?: string;
  mode?: string;
  created_at?: string;
  account?: unknown;
}

export interface PendingAuth {
  codeVerifier: string;
  redirectUri: string;
  createdAt: number;
  mode: "auto" | "manual";
}

export interface GatewayTokenPayload {
  sub: string;
  iat: number;
  exp: number;
}

export interface AuthState {
  ok: boolean;
  reason?: string;
  /** 展示用令牌（网关令牌或 API Key 明文） */
  token?: string;
  payload?: GatewayTokenPayload;
  /** 直接把上游 sk-ant-* 透传 */
  passthroughKey?: string;
  /** 命中的数据库 API Key */
  apiKey?: ApiKeyRecord;
  /** 是否启用 Claude Code 指纹守卫（与 apiKey.fingerprintMode 联动） */
  useClaudeFingerprint?: boolean;
}

export interface Logger {
  readonly level: string;
  debug(msg: string, extra?: unknown): void;
  info(msg: string, extra?: unknown): void;
  warn(msg: string, extra?: unknown): void;
  error(msg: string, extra?: unknown): void;
}

export interface Store {
  readonly credential: Credential | null;
  saveCredential(cred: Credential): void;
  clearCredential(): void;
  putPending(state: string, value: PendingAuth): void;
  takePending(state: string): PendingAuth | undefined;
  refreshInFlight: Promise<Credential | null> | null;
}

export interface GatewayContext {
  cfg: Config;
  log: Logger;
  store: Store;
  db: Database;
  accounts: AccountStore;
  keys: ApiKeyStore;
  logs: LogStore;
  settings: SettingsStore;
  scheduler: Scheduler;
  credentials: CredentialManager;
  quota: QuotaGuard;
}

export interface UpstreamResponse {
  status: number;
  headers: IncomingHttpHeaders;
  raw: IncomingMessage;
}

/** 成功建立的上游调用，带上本次使用的号池账号 */
export interface UpstreamOk extends UpstreamResponse {
  account: Account | null;
}

export interface UpstreamError {
  error: "no_credential";
}

export type UpstreamResult = UpstreamOk | UpstreamError;

export function isUpstreamError(r: UpstreamResult): r is UpstreamError {
  return (r as UpstreamError).error === "no_credential";
}

export interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  [k: string]: unknown;
}

export interface PendingCall {
  path: string;
  method?: string;
  headers: Record<string, string | string[] | undefined>;
  body?: Buffer;
}

export type PublicHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  url: URL
) => Promise<void> | void;

export type ApiHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  auth: AuthState,
  url: URL
) => Promise<void> | void;

export interface PublicRoute {
  method: string;
  path: string;
  handler: PublicHandler;
}

export interface ApiRoute {
  method: string;
  path: string;
  handler: ApiHandler;
}

/* ---- OpenAI / Anthropic 协议形状（只声明用到的字段） ---- */

export interface OpenAIToolCall {
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
}

export interface OpenAIMessage {
  role?: string;
  content?: unknown;
  tool_call_id?: string;
  tool_calls?: OpenAIToolCall[];
}

export interface OpenAIChatRequest {
  model?: string;
  messages?: OpenAIMessage[];
  max_tokens?: number;
  max_completion_tokens?: number;
  temperature?: number;
  top_p?: number;
  top_k?: number;
  stop?: string | string[];
  stream?: boolean;
  stream_options?: { include_usage?: boolean };
  tools?: Array<Record<string, unknown>>;
  tool_choice?: unknown;
  metadata?: Record<string, unknown>;
}

export interface AnthropicContentBlock {
  type?: string;
  text?: string;
  tool_use_id?: string;
  content?: unknown;
  thinking?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  source?: Record<string, unknown>;
}

export interface AnthropicMessage {
  role: string;
  content: string | AnthropicContentBlock[];
}

export interface AnthropicRequest {
  model?: string;
  messages: AnthropicMessage[];
  system?: string;
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  top_k?: number;
  stop_sequences?: string[];
  stream?: boolean;
  tools?: Array<Record<string, unknown>>;
  tool_choice?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

export interface AnthropicResponse {
  id?: string;
  model?: string;
  content?: AnthropicContentBlock[];
  stop_reason?: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
}

/* ================= 存储层类型 ================= */

export type AccountKind = "oauth" | "apikey";
export type AccountStatus = "active" | "disabled" | "error" | "exhausted";

/** 单个限流窗口（5 小时 / 7 天 / 按模型周窗） */
export interface UsageWindow {
  utilization: number | null;
  resetsAt: number | null;
  status?: string;
}

export interface UsageSnapshot {
  ok: boolean;
  /** oauth = 查了 /api/oauth/usage；headers = 从响应头推断；none = 没数据 */
  source: "oauth" | "headers" | "none";
  subscriptionType?: string | null;
  rateLimitsAvailable?: boolean;
  windows: Record<string, UsageWindow>;
  extraUsage?: Record<string, unknown> | null;
  error?: string | null;
  fetchedAt: number;
}

export interface RateLimitObservation {
  unifiedStatus: string | null;
  fiveHourReset: number | null;
  sevenDayReset: number | null;
  overageDisabledReason: string | null;
  dimensions: Record<string, { limit: number | null; remaining: number | null; reset: number | null }>;
}
export type FingerprintMode = "claude_code" | "passthrough";
export type Outcome = "ok" | "blocked" | "error";

export interface Account {
  id: string;
  label: string;
  kind: AccountKind;
  accessToken: string | null;
  refreshToken: string | null;
  apiKey: string | null;
  expiresAt: number | null;
  scope: string | null;
  clientId: string | null;
  mode: string | null;
  accountUuid: string | null;
  email: string | null;
  status: AccountStatus;
  lastError: string | null;
  errorCount: number;
  requestCount: number;
  weight: number;
  cooldownUntil: number | null;
  /** 额度耗尽的恢复时刻（unix 秒）；到期自动回到 active */
  exhaustedUntil: number | null;
  /** 为什么被标记为耗尽，给人看的 */
  exhaustedReason: string | null;
  /** 最近一次用量快照 */
  usage: UsageSnapshot | null;
  usageAt: number | null;
  /** 最近一次从上游响应头观察到的限流状态 */
  rateLimit: RateLimitObservation | null;
  createdAt: number;
  updatedAt: number;
}

export interface AccountInput {
  label: string;
  kind: AccountKind;
  accessToken?: string | null;
  refreshToken?: string | null;
  apiKey?: string | null;
  expiresAt?: number | null;
  scope?: string | null;
  clientId?: string | null;
  mode?: string | null;
  accountUuid?: string | null;
  email?: string | null;
  weight?: number;
}

export interface ApiKeyRecord {
  id: string;
  name: string;
  keyHash: string;
  keyPrefix: string;
  enabled: boolean;
  fingerprintMode: FingerprintMode;
  /** 空数组表示不限制 */
  allowedModels: string[];
  allowedProtocols: string[];
  quotaEnabled: boolean;
  rateLimitPerMin: number;
  dailyRequestLimit: number;
  dailyTokenLimit: number;
  boundAccountId: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface ApiKeyInput {
  name: string;
  fingerprintMode?: FingerprintMode;
  allowedModels?: string[];
  allowedProtocols?: string[];
  quotaEnabled?: boolean;
  rateLimitPerMin?: number;
  dailyRequestLimit?: number;
  dailyTokenLimit?: number;
  boundAccountId?: string | null;
}

export interface ApiKeyUsage {
  keyId: string;
  day: string;
  requests: number;
  promptTokens: number;
  completionTokens: number;
  cacheTokens: number;
}

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

