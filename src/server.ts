import http from "node:http";

import { loadConfig, configWarnings, applyRuntimeSettings } from "./config.ts";
import { createLogger } from "./logger.ts";
import { createStore } from "./store.ts";
import { openDatabase } from "./store/db.ts";
import { createAccountStore } from "./store/accounts.ts";
import { createApiKeyStore } from "./store/apikeys.ts";
import { createLogStore } from "./store/logs.ts";
import { createSettingsStore } from "./store/settings.ts";
import { createScheduler } from "./pool/scheduler.ts";
import { createCredentialManager } from "./pool/credentials.ts";
import { createModelCatalog } from "./model-catalog.ts";
import { applyModelDisabled } from "./models.ts";
import type { ModelCatalogHandle } from "./model-catalog.ts";
import { createQuotaGuard } from "./middleware/quota.ts";
import { createAgent, createHttpAgent } from "./upstream.ts";
import { parseProxySpec, describeProxy } from "./net/proxy.ts";
import { applyGuard } from "./guard.ts";
import { authenticate, rejectUnauthorized, rejectGuard, rejectQuota } from "./middleware/auth.ts";
import { sendJson } from "./http/respond.ts";
import { setRequestMeta, setTracker } from "./http/context.ts";
import { newRequestId } from "./ids.ts";

import { createAdminRoutes } from "./routes/admin.ts";
import { createAdminKey } from "./admin-key.ts";
import { loadEnvFile } from "./env-file.ts";
import { resolveEnvFilePath } from "./config.ts";
import { createAuthRoutes } from "./routes/auth.ts";
import { createAnthropicRoutes } from "./routes/anthropic.ts";
import { createOpenaiRoutes } from "./routes/openai.ts";
import { createPanelRoutes } from "./routes/panel.ts";

import type {
  ApiRoute,
  AuthState,
  Config,
  GatewayContext,
  Logger,
  Protocol,
  PublicRoute,
  RequestMeta,
  RequestTracker,
  Store
} from "./types.ts";
import type { AccountStore, AdminKeyHandle, ApiKeyStore, LogStore, SettingsStore, Scheduler, CredentialManager, QuotaGuard, Database } from "./types.ts";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export interface Gateway {
  readonly server: http.Server;
  readonly cfg: Config;
  readonly store: Store;
  readonly log: Logger;
  readonly db: Database;
  readonly accounts: AccountStore;
  readonly keys: ApiKeyStore;
  readonly logs: LogStore;
  readonly settings: SettingsStore;
  readonly scheduler: Scheduler;
  readonly credentials: CredentialManager;
  readonly quota: QuotaGuard;
  readonly modelCatalog: ModelCatalogHandle;
  readonly adminKey: AdminKeyHandle;
  readonly warnings: string[];
  readonly routes: { public: PublicRoute[]; api: ApiRoute[] };
  listen(port?: number, host?: string): Promise<AddressInfo>;
  close(): Promise<void>;
}

function protocolOf(pathname: string): Protocol {
  if (pathname.startsWith("/v1/chat") || pathname.startsWith("/v1/models") || pathname.startsWith("/v1/completions")) {
    return "openai";
  }
  if (pathname.startsWith("/v1/messages")) return "anthropic";
  if (pathname.startsWith("/v1/")) return "other";
  return "admin";
}

function clientIpOf(req: IncomingMessage, trustProxy: boolean): string {
  if (trustProxy) {
    const xff = req.headers["x-forwarded-for"];
    const raw = Array.isArray(xff) ? xff[0] : xff;
    if (raw) {
      const first = raw.split(",")[0]?.trim();
      if (first) return first;
    }
    const real = req.headers["x-real-ip"];
    const realRaw = Array.isArray(real) ? real[0] : real;
    if (realRaw) return realRaw.trim();
  }
  return req.socket.remoteAddress ?? "unknown";
}

/** 只有真正打上游的路径才进请求日志，面板与健康检查不记 */
function shouldLogRequest(pathname: string): boolean {
  return pathname.startsWith("/v1/");
}

export function createGateway(env: Record<string, string | undefined> = process.env): Gateway {
  /* 先读工作目录的 .env（真实环境变量优先，.env 只补空缺），再读配置。
     面板登录密钥的首次派发要写回这里，所以必须真的读它 —— 之前只有 .env.example，没有加载器 */
  const envFile = resolveEnvFilePath(env);
  const envLoaded = envFile ? loadEnvFile(envFile, env) : { path: "", exists: false, applied: 0, seen: 0 };

  const cfg = loadConfig(env);
  cfg.envFile = envFile;
  const store = createStore(cfg);

  const db = openDatabase(cfg.dataDir);
  const accounts = createAccountStore(db);
  const keys = createApiKeyStore(db);
  const logs = createLogStore(db);
  const settings = createSettingsStore(db);

  /* 面板里保存过的策略在启动时优先于 .env */
  applyRuntimeSettings(cfg, settings.all());

  const baseLog = createLogger(cfg.logLevel);
  const log: Logger = {
    level: baseLog.level,
    debug(msg, extra) {
      baseLog.debug(msg, extra);
      logs.runtime("debug", "app", msg, extra);
    },
    info(msg, extra) {
      baseLog.info(msg, extra);
      logs.runtime("info", "app", msg, extra);
    },
    warn(msg, extra) {
      baseLog.warn(msg, extra);
      logs.runtime("warn", "app", msg, extra);
    },
    error(msg, extra) {
      baseLog.error(msg, extra);
      logs.runtime("error", "app", msg, extra);
    }
  };

  /* 面板管理员密钥：首次启动自动派发，登录密钥单向派生自主密钥。
     明文只在首次派发时交给 index.ts 打印一次，这里不做任何输出 */
  const adminKey = createAdminKey({
    dataDir: cfg.dataDir,
    adminToken: cfg.adminToken,
    adminSecret: cfg.adminSecret,
    envFile: cfg.envFile,
    /* 用户显式指了 CG_ENV_FILE 就照写，不受「只在默认数据目录才创建 .env」那条守卫限制 */
    envFileExplicit: env.CG_ENV_FILE !== undefined && String(env.CG_ENV_FILE).trim() !== "",
    log
  });
  if (envLoaded.exists && envLoaded.applied > 0) {
    log.debug("env: 从 " + envLoaded.path + " 补进 " + envLoaded.applied + " 项");
  }

  /* 老版本的单凭据文件自动迁移进号池，避免升级后凭空少一个号 */
  if (accounts.list().length === 0 && store.credential) {
    const c = store.credential;
    try {
      accounts.create({
        label: "从 credential.json 迁移",
        kind: c.kind === "apikey" ? "apikey" : "oauth",
        accessToken: c.access_token ?? null,
        refreshToken: c.refresh_token ?? null,
        apiKey: c.api_key ?? null,
        expiresAt: c.expires_at ?? null,
        scope: c.scope ?? null,
        clientId: c.client_id ?? null,
        mode: c.mode ?? null
      });
      log.info("migrated legacy credential.json into account pool");
    } catch (e) {
      log.warn("legacy credential migration failed: " + (e instanceof Error ? e.message : String(e)));
    }
  }

  const scheduler = createScheduler(accounts, log);
  const credentials = createCredentialManager(cfg, log, accounts);
  const quota = createQuotaGuard(keys);

  try {
    cfg.proxy = parseProxySpec(cfg.upstreamProxy);
  } catch (e) {
    /* 代理写错就直接拒绝启动，免得跑到线上才发现全都不通 */
    log.error("出站代理配置有误：" + (e instanceof Error ? e.message : String(e)));
    throw e;
  }
  if (cfg.proxy) log.info("出站代理 " + describeProxy(cfg.proxy));
  cfg.agent = createAgent(cfg);
  cfg.agentHttp = createHttpAgent(cfg);

  /* 必须在 cfg.proxy / cfg.agent 就绪之后建 —— 它自己要出网拉目录，
     早建一步就会绕过代理直连，正好踩中这个项目最想避免的坑 */
  const modelCatalog = createModelCatalog(cfg, log);

  const ctx: GatewayContext = { cfg, adminKey, log, store, db, accounts, keys, logs, settings, scheduler, credentials, quota, modelCatalog };
  /* 隐藏清单：部署级 env + 面板里勾掉的，取并集 */
  applyModelDisabled(ctx);

  const admin = createAdminRoutes(ctx);
  const auth = createAuthRoutes(ctx);
  const anthropic = createAnthropicRoutes(ctx);
  const openai = createOpenaiRoutes(ctx);
  const panel = createPanelRoutes(ctx, admin.requireAdmin);

  /** 公开路由：无需网关令牌（面板与登录相关自带管理员令牌校验） */
  const publicRoutes: PublicRoute[] = [
    { method: "GET", path: "/", handler: admin.root },
    { method: "GET", path: "/login", handler: auth.login },
    { method: "GET", path: "/callback", handler: auth.callback },
    { method: "POST", path: "/login/manual", handler: auth.manual },
    { method: "GET", path: "/token", handler: admin.token },
    { method: "GET", path: "/healthz", handler: admin.health },
    { method: "POST", path: "/oauth/token", handler: auth.oauthToken },
    { method: "POST", path: "/logout", handler: admin.logout },
    { method: "GET", path: "/favicon.ico", handler: favicon },
    { method: "HEAD", path: "/api/hello", handler: hello },
    { method: "GET", path: "/api/hello", handler: hello },
    { method: "GET", path: "/panel", handler: panel.page },
    { method: "GET", path: "/panel/api", handler: panel.api },
    { method: "POST", path: "/panel/api", handler: panel.api },
    /* 面板样式与脚本（/panel/assets/*），路径由 PANEL_ASSETS 派生 */
    ...panel.assetRoutes
  ];

  /** 受保护路由：先过令牌，再按 Key 策略决定守卫 */
  const apiRoutes: ApiRoute[] = [
    { method: "POST", path: "/v1/messages", handler: anthropic.messages },
    { method: "POST", path: "/v1/messages/count_tokens", handler: anthropic.countTokens },
    { method: "POST", path: "/v1/chat/completions", handler: openai.chat },
    { method: "GET", path: "/v1/models", handler: openai.models }
  ];

  /* 路由表静态，装配期建索引，避免每请求线性扫描 */
  const publicIndex = new Map<string, PublicRoute>();
  for (const r of publicRoutes) publicIndex.set(r.method + " " + r.path, r);
  const apiIndex = new Map<string, ApiRoute>();
  for (const r of apiRoutes) apiIndex.set(r.method + " " + r.path, r);

  /**
   * HEAD /api/hello —— Claude Code 的连接预热探测。
   *
   * 官方网关兼容指南把它列为「启动期尽力而为的流量，网关可以直接拒绝而不影响功能」，
   * 但 404 与 200 是可观测的差异，照着 api.anthropic.com 的真实响应回一份最省事：
   * 那边是 200 + {"message":"hello"} + application/json。
   * 探测不带任何凭据，也不需要转发上游。
   */
  function hello(_req: IncomingMessage, res: ServerResponse): void {
    /* 真端点带一个空格，content-length 是 20；少个空格就对不上了 */
    const body = Buffer.from('{"message": "hello"}', "utf8");
    res.writeHead(200, {
      "content-type": "application/json",
      "content-length": String(body.length),
      "x-robots-tag": "none"
    });
    /* HEAD 不能带 body，Node 会自己丢掉，但显式区分更清楚 */
    if ((_req.method ?? "GET").toUpperCase() === "HEAD") { res.end(); return; }
    res.end(body);
  }

  /** 浏览器会无条件请求 favicon，回 204 免得面板控制台一直挂个 404 */
  function favicon(_req: IncomingMessage, res: ServerResponse): void {
    res.writeHead(204, { "cache-control": "max-age=86400" });
    res.end();
  }

  function isOpenaiPath(pathname: string): boolean {
    return pathname === "/v1/chat/completions" || pathname === "/v1/models" ||
      pathname.startsWith("/v1/chat/") || pathname.startsWith("/v1/completions");
  }

  async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://" + (req.headers.host ?? "localhost"));
    const pathname = url.pathname;
    const key = (req.method ?? "GET") + " " + pathname;

    const meta: RequestMeta = {
      id: newRequestId(),
      startedAt: Date.now(),
      clientIp: clientIpOf(req, cfg.trustProxy),
      protocol: protocolOf(pathname),
      method: req.method ?? "GET",
      path: pathname,
      reqIdInResponse: cfg.reqIdInResponse
    };
    setRequestMeta(res, meta);

    const tracker: RequestTracker = {
      status: null,
      model: null,
      upstreamModel: null,
      accountId: null,
      accountLabel: null,
      outcome: "ok",
      blockReason: null,
      blockDetail: null,
      stream: false,
      promptTokens: 0,
      completionTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      errorMessage: null,
      errorType: null,
      exhaustedUntil: null,
      exhaustedReason: null
    };
    setTracker(res, tracker);

    let authState: AuthState | null = null;
    let finalized = false;

    function finalize(): void {
      if (finalized) return;
      finalized = true;

      const durationMs = Date.now() - meta.startedAt;

      try {
        /* 只统计真正转发出去的请求：被守卫/隐写/配额自己拦下的不占额度，
           否则被拒的请求会不断推高自己的计数，形成自锁 */
        if (authState?.apiKey && tracker.outcome !== "blocked") {
          quota.commit(authState.apiKey, {
            promptTokens: tracker.promptTokens,
            completionTokens: tracker.completionTokens,
            cacheTokens: tracker.cacheCreationTokens + tracker.cacheReadTokens
          });
        }
      } catch (e) {
        log.warn("quota commit failed: " + (e instanceof Error ? e.message : String(e)));
      }

      if (tracker.accountId) {
        const st = tracker.status ?? 0;
        if (tracker.exhaustedUntil) {
          /* 额度耗尽和普通限流要分开：这个要禁用账号并等重置，不是冷却几分钟 */
          scheduler.reportExhausted(
            tracker.accountId,
            tracker.exhaustedReason ?? "额度耗尽",
            tracker.exhaustedUntil
          );
        } else if (st === 401 || st === 403 || st === 429 || st >= 500) {
          scheduler.reportFailure(tracker.accountId, st, tracker.errorMessage ?? "");
        } else if (st > 0 && st < 400) {
          scheduler.reportSuccess(tracker.accountId);
        }
      }

      if (!shouldLogRequest(meta.path)) return;

      try {
        logs.writeRequest({
          id: meta.id,
          ts: meta.startedAt,
          clientIp: meta.clientIp,
          apiKeyId: authState?.apiKey?.id ?? null,
          apiKeyName: authState?.apiKey?.name ?? (authState?.payload ? "gateway-token" : null),
          protocol: meta.protocol,
          method: meta.method,
          path: meta.path,
          model: tracker.model,
          upstreamModel: tracker.upstreamModel,
          accountId: tracker.accountId,
          accountLabel: tracker.accountLabel,
          status: tracker.status,
          outcome: tracker.outcome,
          blockReason: tracker.blockReason,
          blockDetail: tracker.blockDetail,
          durationMs,
          stream: tracker.stream,
          promptTokens: tracker.promptTokens,
          completionTokens: tracker.completionTokens,
          cacheCreationTokens: tracker.cacheCreationTokens,
          cacheReadTokens: tracker.cacheReadTokens,
          errorMessage: tracker.errorMessage,
          userAgent: String(req.headers["user-agent"] ?? "") || null
        });
      } catch (e) {
        log.error("request log write failed: " + (e instanceof Error ? e.message : String(e)));
      }
    }

    res.once("close", finalize);

    try {
      if (req.method === "OPTIONS") {
        res.writeHead(204, {
          "access-control-allow-origin": "*",
          "access-control-allow-headers": "*",
          "access-control-allow-methods": "GET,POST,OPTIONS",
          "access-control-max-age": "86400"
        });
        res.end();
        return;
      }

      const pub = publicIndex.get(key);
      if (pub) {
        await pub.handler(req, res, url);
        return;
      }

      const api = apiIndex.get(key);
      if (!api) {
        if (pathname.startsWith("/v1/")) {
          if (isOpenaiPath(pathname)) {
            sendJson(res, 404, {
              error: { message: "unknown endpoint: " + pathname, type: "invalid_request_error", code: "not_found", param: null }
            });
          } else {
            sendJson(res, 404, {
              type: "error",
              error: { type: "not_found_error", message: "unknown endpoint: " + pathname }
            });
          }
        } else {
          sendJson(res, 404, { error: "not found" });
        }
        return;
      }

      const isOpenai = isOpenaiPath(pathname);

      authState = authenticate(cfg, req, keys);
      if (!authState.ok) {
        tracker.outcome = "error";
        tracker.errorMessage = authState.reason ?? "unauthorized";
        tracker.status = 401;
        rejectUnauthorized(res, isOpenai, authState.reason ?? "unauthorized");
        return;
      }

      if (authState.apiKey) {
        const decision = quota.check(authState.apiKey);
        if (!decision.ok) {
          tracker.outcome = "blocked";
          tracker.blockReason = decision.code ?? "quota_exceeded";
          tracker.blockDetail = decision.reason ?? null;
          tracker.status = 429;
          log.warn("[" + meta.id + "] quota reject: " + (decision.code ?? ""));
          rejectQuota(res, isOpenai, decision.reason ?? "quota exceeded", decision.code ?? "quota_exceeded");
          return;
        }
      }

      const g = applyGuard(req, authState, cfg, log);
      if (!g.ok) {
        tracker.outcome = "blocked";
        tracker.blockReason = "header_guard_rejected";
        tracker.blockDetail = g.missing.join(", ");
        tracker.status = 403;
        rejectGuard(res, isOpenai, g.missing);
        return;
      }

      /* 守卫后的头写回 req，路由与上游组装都用它 */
      req.headers = g.headers as typeof req.headers;

      await api.handler(req, res, authState, url);
    } catch (e) {
      log.error("[" + meta.id + "] handler error: " + (e instanceof Error && e.stack ? e.stack : String(e)));
      tracker.outcome = "error";
      tracker.errorMessage = e instanceof Error ? e.message : String(e);
      if (!res.headersSent) {
        tracker.status = 500;
        const msg = "internal error: " + (e instanceof Error ? e.message : String(e));
        if (isOpenaiPath(pathname)) {
          sendJson(res, 500, { error: { message: msg, type: "api_error", code: null, param: null } });
        } else {
          sendJson(res, 500, { type: "error", error: { type: "api_error", message: msg } });
        }
      } else {
        try {
          res.end();
        } catch {
          /* 连接已断 */
        }
      }
    }
  }

  const server = http.createServer((req, res) => {
    void handler(req, res);
  });

  /* 长连接 + 大 prompt，但避免 fd 被无限占用 */
  server.headersTimeout = 0;
  server.requestTimeout = 0;
  server.keepAliveTimeout = 120000;
  server.maxRequestsPerSocket = 0;

  return {
    server,
    cfg,
    store,
    log,
    db,
    accounts,
    keys,
    logs,
    settings,
    scheduler,
    credentials,
    quota,
    modelCatalog,
    adminKey,
    warnings: configWarnings(cfg),
    routes: { public: publicRoutes, api: apiRoutes },

    listen(port?: number, host?: string): Promise<AddressInfo> {
      return new Promise((resolve) => {
        server.listen(
          port === undefined ? cfg.port : port,
          host === undefined ? cfg.host : host,
          () => resolve(server.address() as AddressInfo)
        );
      });
    },

    close(): Promise<void> {
      return new Promise((resolve) => {
        scheduler.stop();
        quota.stop();
        logs.close();
        server.close(() => {
          db.close();
          resolve();
        });
        const timer = setTimeout(() => {
          if (typeof server.closeAllConnections === "function") {
            try {
              server.closeAllConnections();
            } catch {
              /* 已关闭 */
            }
          }
        }, cfg.shutdownGraceMs);
        timer.unref();
        if (typeof server.closeIdleConnections === "function") {
          try {
            server.closeIdleConnections();
          } catch {
            /* 忽略 */
          }
        }
      });
    }
  };
}
