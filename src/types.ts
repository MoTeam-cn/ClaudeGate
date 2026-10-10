import type { IncomingMessage, ServerResponse, IncomingHttpHeaders } from "node:http";
import type { Readable } from "node:stream";
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
import type { ModelCatalogHandle } from "./model-catalog.ts";

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

/** 单个模型的上下文窗口与最大输出 */
export interface ModelLimit {
  /** 上下文窗口（token） */
  context: number;
  /** 最大输出（token）；null 表示不限制 */
  maxOutput: number | null;
}

export interface Config {
  port: number;
  host: string;
  publicUrl: string;
  /** 上游 429/5xx 时最多换几个号重试（含第一次，所以 1 = 不重试） */
  upstreamRetries: number;
  /** 注入 Claude Code 的归因头（system 第一段）。关掉只用于对照排查 */
  attributionHeader: boolean;
  /** cc_entrypoint 的值，默认 cli */
  attributionEntrypoint: string;
  /**
   * 每个模型的上下文窗口与最大输出。键是归一化后的模型名（小写、去 [1m]、去日期后缀），
   * "*" 是兜底项。见 src/model-limits.ts 的语法说明。
   */
  modelLimits: Record<string, ModelLimit>;
  /** 上下文超限怎么处理：block 拒绝（默认）/ log 只记 / off 不查 */
  contextGuard: "block" | "log" | "off";
  /** 超限容差。0.1 = 允许超出 10% 才拒绝 —— 客户端计数和真实计数不会完全一致 */
  contextHeadroom: number;
  dataDir: string;
  secret: string;

  upstreamBase: string;
  upstreamProxy: string;
  /** 上游通道：auto / https / fetch */
  transport: "auto" | "https" | "fetch";
  /** metadata.user_id 的重写模式 */
  rewriteUserId: import("./userid.ts").UserIdMode;
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
  /** 主密钥；首次启动自动生成并镜像进 .env */
  adminSecret: string;
  /** .env 路径；空串表示不读也不镜像 */
  envFile: string;
  tokenTtlDays: number;

  oauthMode: OAuthMode;
  oauthClientId: string;
  oauthScopes: string[];
  oauthAuthorizeUrl: string;
  oauthTokenUrl: string;
  oauthManualRedirect: string;
  oauthRolesUrl: string;
  /** GET /api/oauth/profile，用来拿真名字 */
  oauthProfileUrl: string;
  /** 出口自检用的 IP 回显服务 */
  ipCheckUrl: string;
  /** Claude Code 的模型目录地址 */
  modelCatalogUrl: string;
  /** 目录缓存多久算过期（毫秒） */
  modelCatalogTtlMs: number;
  /** 消息接口的模型校验：strict 不在目录里就报错 / off 放行 */
  modelValidation: "strict" | "off";
  /** 部署级隐藏清单（MODEL_DISABLED），跟面板里勾掉的取并集 */
  modelDisabled: string[];
  /** 出口自检模式：off / warn / block */
  ipCheckMode: "off" | "warn" | "block";
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

/** 面板管理员密钥的句柄。结构写在这里，免得 types 反向依赖 admin-key */
export interface AdminKeyHandle {
  info(): {
    mode: "derived" | "custom" | "env";
    envOverride: boolean;
    createdAt: number;
    rotatedAt: number;
    masterFingerprint: string;
    keyFile: string;
    envFile: string;
    envMirrored: boolean;
  };
  verify(presented: string): boolean;
  reset(custom?: string): string;
  readonly announce: string | null;
}

export interface GatewayContext {
  cfg: Config;
  adminKey: AdminKeyHandle;
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
  modelCatalog: ModelCatalogHandle;
}

export interface UpstreamResponse {
  status: number;
  headers: IncomingHttpHeaders;
  raw: Readable;
}

/** 成功建立的上游调用，带上本次使用的号池账号 */
export interface UpstreamOk extends UpstreamResponse {
  account: Account | null;
}

export interface UpstreamError {
  error: "no_credential";
  /** 为什么挑不到号：空池 / 全在冷却 / 全耗尽 / 全停用，尽量说清 */
  reason?: string;
  /** 全在冷却时给出「多少秒后重试」，调用方据此退避 */
  retryAfterSec?: number | null;
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
  /** limits[] 里带 scope 的行，服务端给的展示标签（模型名或界面名） */
  scopeLabel?: string;
  /** 服务端挑出来的「头条」行 —— 单值指示器显示的就是它 */
  isActive?: boolean;
}

export interface UsageSnapshot {
  /** 上游原始响应（截断）。面板上能看，省得「窗口在但没数字」时只能猜 */
  raw?: string;
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
  /** 响应头里直接给的百分比（0-100）。有了它就不必再打用量接口 ——
   *  官方客户端就是这么读的，sgproxy 也走这条路。 */
  fiveHourUtilization: number | null;
  sevenDayUtilization: number | null;
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
  /** 这个号专属的 device_id，首次用到时生成，之后固定不变 */
  deviceId: string | null;
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

