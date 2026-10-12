import type { Config, ReqIdMode } from "./config.ts";
import type { ApiKeyRecord } from "./keys.ts";
import type { Database } from "../store/db.ts";
import type { AccountStore } from "../store/accounts.ts";
import type { ApiKeyStore } from "../store/apikeys.ts";
import type { LogStore } from "../store/logs.ts";
import type { SettingsStore } from "../store/settings.ts";
import type { Scheduler } from "../pool/scheduler.ts";
import type { CredentialManager } from "../pool/credentials.ts";
import type { QuotaGuard } from "../middleware/quota.ts";
import type { ModelCatalogHandle } from "../model-catalog.ts";

export type Protocol = "anthropic" | "openai" | "admin" | "other";
export type CredentialKind = "oauth" | "apikey";

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
