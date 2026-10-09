import path from "node:path";
import { PROD, DEFAULT_SCOPES, GUARD_MODES, OAUTH_MODES, BORINGSSL_CIPHERS } from "./constants.ts";
import { num, bool, stripSlash } from "./utils.ts";
import type { Config, GuardMode, OAuthMode, LogLevel, StegoMode, ReqIdMode } from "./types.ts";

const LOG_LEVELS: readonly LogLevel[] = ["debug", "info", "warn", "error"];
const STEGO_MODES: readonly StegoMode[] = ["block", "strip", "log", "off"];
const REQ_ID_MODES: readonly ReqIdMode[] = ["error", "always", "off"];

type Env = Record<string, string | undefined>;

/**
 * 出站 TLS 套件列表。
 * 默认按 BoringSSL（真 Claude Code 用的那份）发，缩掉 Node 默认多出来的 35 个老套件 ——
 * 套件列表是 TLS 指纹里权重最大的一段。
 * 传 default / node / off 表示退回 Node 自带默认。
 */
function resolveTlsCiphers(raw: string | undefined): string {
  if (raw === undefined || raw.trim() === "") return BORINGSSL_CIPHERS;
  const t = raw.trim().toLowerCase();
  if (t === "default" || t === "node" || t === "off") return "";
  return raw;
}

/** 取第一个非空的代理变量：UPSTREAM_PROXY 优先，其次标准变量 */
function firstNonEmpty(values: Array<string | undefined>): string {
  for (const v of values) {
    const s = String(v ?? "").trim();
    if (s) return s;
  }
  return "";
}

export function loadConfig(env: Env): Config {
  const rawMode = String(env.GUARD_MODE ?? "strict").toLowerCase();
  const guardMode: GuardMode = (GUARD_MODES as readonly string[]).includes(rawMode)
    ? (rawMode as GuardMode)
    : "strict";

  const rawOAuth = String(env.OAUTH_MODE ?? "claude_ai").toLowerCase();
  const oauthMode: OAuthMode = (OAUTH_MODES as readonly string[]).includes(rawOAuth)
    ? (rawOAuth as OAuthMode)
    : "claude_ai";

  const rawStego = String(env.STEGO_MODE ?? "block").toLowerCase();
  const stegoMode: StegoMode = (STEGO_MODES as readonly string[]).includes(rawStego)
    ? (rawStego as StegoMode)
    : "block";

  const rawReqId = String(env.REQ_ID_IN_RESPONSE ?? "error").toLowerCase();
  const reqIdInResponse: ReqIdMode = (REQ_ID_MODES as readonly string[]).includes(rawReqId)
    ? (rawReqId as ReqIdMode)
    : "error";

  const rawLog = String(env.LOG_LEVEL ?? "info").toLowerCase();
  const logLevel: LogLevel = (LOG_LEVELS as readonly string[]).includes(rawLog)
    ? (rawLog as LogLevel)
    : "info";

  const cfg: Config = {
    port: num(env.PORT, 8080),
    host: env.HOST ?? "0.0.0.0",
    publicUrl: stripSlash(env.PUBLIC_URL ?? ""),
    dataDir: path.resolve(env.DATA_DIR ?? "./data"),
    secret: env.SECRET ?? "",

    upstreamBase: stripSlash(env.UPSTREAM_BASE ?? PROD.BASE_API_URL),
    upstreamProxy: firstNonEmpty([
    env.UPSTREAM_PROXY,
    env.ALL_PROXY,
    env.all_proxy,
    env.HTTPS_PROXY,
    env.https_proxy,
    env.HTTP_PROXY,
    env.http_proxy
  ]),
    tlsMin: env.TLS_MIN ?? "TLSv1.2",
    tlsCiphers: resolveTlsCiphers(env.TLS_CIPHERS),
    tlsMax: env.TLS_MAX ?? "TLSv1.3",
    upstreamAlpn: env.UPSTREAM_ALPN ?? "http/1.1",
    upstreamTimeoutMs: num(env.UPSTREAM_TIMEOUT_MS, 600000),
    upstreamMaxSockets: num(env.UPSTREAM_MAX_SOCKETS, 64),

    maxBodyBytes: num(env.MAX_BODY_BYTES, 32 * 1024 * 1024),
    shutdownGraceMs: num(env.SHUTDOWN_GRACE_MS, 5000),

    guardMode,
    guardRequire: String(env.GUARD_REQUIRE ?? "user-agent,x-app,anthropic-version,x-claude-code-session-id")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
    injectMissing: bool(env.INJECT_MISSING, false),

    stegoMode,
    reqIdInResponse,

    trustProxy: bool(env.TRUST_PROXY, true),
    adminToken: env.ADMIN_TOKEN ?? "",
    tokenTtlDays: num(env.TOKEN_TTL_DAYS, 365),

    oauthMode,
    oauthClientId: env.OAUTH_CLIENT_ID ?? "",
    oauthScopes: String(env.OAUTH_SCOPES ?? "").split(/[ ,]+/).filter(Boolean),
    oauthAuthorizeUrl: env.OAUTH_AUTHORIZE_URL ?? "",
    oauthTokenUrl: env.OAUTH_TOKEN_URL ?? "",
    oauthManualRedirect: env.OAUTH_MANUAL_REDIRECT ?? PROD.MANUAL_REDIRECT_URL,
    oauthRolesUrl: env.OAUTH_ROLES_URL ?? PROD.ROLES_URL,
    apiKeyUrl: env.API_KEY_URL ?? PROD.API_KEY_URL,

    defaultModel: env.DEFAULT_MODEL ?? "claude-sonnet-4-5-20250929",
    maxTokensDefault: num(env.MAX_TOKENS_DEFAULT, 8192),
    logLevel
  };

  if (!cfg.oauthClientId) {
    cfg.oauthClientId = cfg.oauthMode === "design" ? PROD.DESIGN_CLIENT_ID : PROD.CLIENT_ID;
  }
  if (!cfg.oauthScopes.length) cfg.oauthScopes = [...DEFAULT_SCOPES];
  if (!cfg.oauthAuthorizeUrl) {
    cfg.oauthAuthorizeUrl = cfg.oauthMode === "console" ? PROD.CONSOLE_AUTHORIZE_URL : PROD.CLAUDE_AI_AUTHORIZE_URL;
  }
  if (!cfg.oauthTokenUrl) cfg.oauthTokenUrl = PROD.TOKEN_URL;

  return cfg;
}

export function configWarnings(cfg: Config): string[] {
  const w: string[] = [];
  if (cfg.guardMode === "off") w.push("GUARD_MODE=off：任何客户端都能调用，建议只在调试时使用");
  if (!cfg.publicUrl) w.push("PUBLIC_URL 未设置：首页展示的接入地址会退回本机端口");
  if (cfg.injectMissing && cfg.guardMode === "strict") {
    w.push("INJECT_MISSING=true 且 GUARD_MODE=strict：注入后必然通过，等同于放宽守卫，建议改 GUARD_MODE=lenient");
  }
  return w;
}

/**
 * 把面板里保存的设置应用到运行中的 Config。
 * 只覆盖那几项可热改的策略，其它仍然只认 .env。
 */
export function applyRuntimeSettings(cfg: Config, patch: Record<string, string>): void {
  const guard = patch.guardMode;
  if (guard && (["strict", "lenient", "off"] as string[]).includes(guard)) cfg.guardMode = guard as GuardMode;

  const stego = patch.stegoMode;
  if (stego && (["block", "strip", "log", "off"] as string[]).includes(stego)) cfg.stegoMode = stego as StegoMode;

  const reqId = patch.reqIdInResponse;
  if (reqId && (["error", "always", "off"] as string[]).includes(reqId)) cfg.reqIdInResponse = reqId as ReqIdMode;

  if (patch.injectMissing !== undefined) {
    cfg.injectMissing = patch.injectMissing === "true" || patch.injectMissing === "1";
  }
}
