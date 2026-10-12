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
import { applyModelDisabled, applyModelLimits } from "./models.ts";
import type { ModelCatalogHandle } from "./model-catalog.ts";
import { createQuotaGuard } from "./middleware/quota.ts";
import { createAgent, createHttpAgent } from "./upstream.ts";
import { createDispatcher } from "./server/dispatch.ts";
import { hello, favicon, isOpenaiPath } from "./server/helpers.ts";
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
  /* 上下文限制：env 的 MODEL_LIMITS 是底座，面板里配的同名项覆盖它 */
  applyModelLimits(ctx);

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



  const dispatch = createDispatcher({ cfg, log, keys, logs, quota, scheduler, publicIndex, apiIndex });

  const server = http.createServer((req, res) => {
    void dispatch(req, res);
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
