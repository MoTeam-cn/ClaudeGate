import { sendJson } from "../http/respond.ts";
import { readJson } from "../http/body.ts";
import { clampInt } from "../utils.ts";
import { applyRuntimeSettings } from "../config.ts";
import { dayString } from "../store/apikeys.ts";
import { fetchOauthUsage, windowsFromRateLimit } from "../pool/usage.ts";
import { startOAuth, finishOAuth } from "../oauth-flow.ts";
import type { Account, ApiKeyRecord, GatewayContext, RequestLogQuery, RuntimeLogQuery } from "../types.ts";
import type { IncomingMessage, ServerResponse } from "node:http";

const SETTING_KEYS = ["guardMode", "stegoMode", "reqIdInResponse", "injectMissing", "logRetentionDays", "runtimeLogMax"];

/** 面板可见的账号视图：绝不回传任何凭据原文 */
function publicAccount(a: Account): Record<string, unknown> {
  /* 订阅号有 usage 接口；Console Key 只有响应头，用观察到的限流窗口顶上 */
  const windows = a.usage?.windows && Object.keys(a.usage.windows).length
    ? a.usage.windows
    : windowsFromRateLimit(a.rateLimit);

  return {
    id: a.id,
    label: a.label,
    kind: a.kind,
    status: a.status,
    exhaustedUntil: a.exhaustedUntil,
    exhaustedReason: a.exhaustedReason,
    usage: {
      source: a.usage?.source ?? (a.rateLimit ? "headers" : "none"),
      ok: a.usage?.ok ?? false,
      error: a.usage?.error ?? null,
      subscriptionType: a.usage?.subscriptionType ?? null,
      extraUsage: a.usage?.extraUsage ?? null,
      windows
    },
    usageAt: a.usageAt,
    rateLimit: a.rateLimit
      ? {
          unifiedStatus: a.rateLimit.unifiedStatus,
          overageDisabledReason: a.rateLimit.overageDisabledReason,
          dimensions: a.rateLimit.dimensions
        }
      : null,
    email: a.email,
    mode: a.mode,
    scope: a.scope,
    expiresAt: a.expiresAt,
    errorCount: a.errorCount,
    lastError: a.lastError,
    cooldownUntil: a.cooldownUntil,
    weight: a.weight,
    hasAccessToken: !!a.accessToken,
    hasRefreshToken: !!a.refreshToken,
    hasApiKey: !!a.apiKey,
    apiKeyPreview: a.apiKey ? a.apiKey.slice(0, 14) + "..." : null,
    createdAt: a.createdAt,
    updatedAt: a.updatedAt
  };
}

function publicKey(k: ApiKeyRecord, ctx: GatewayContext): Record<string, unknown> {
  const usage = ctx.quota.usageToday(k.id);
  return {
    id: k.id,
    name: k.name,
    keyPrefix: k.keyPrefix,
    enabled: k.enabled,
    fingerprintMode: k.fingerprintMode,
    allowedModels: k.allowedModels,
    allowedProtocols: k.allowedProtocols,
    quotaEnabled: k.quotaEnabled,
    rateLimitPerMin: k.rateLimitPerMin,
    dailyRequestLimit: k.dailyRequestLimit,
    dailyTokenLimit: k.dailyTokenLimit,
    boundAccountId: k.boundAccountId,
    createdAt: k.createdAt,
    usageToday: {
      requests: usage.requests,
      tokens: usage.tokens
    }
  };
}

function str(v: unknown, d = ""): string {
  return typeof v === "string" ? v : d;
}

function strList(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean);
  if (typeof v === "string") {
    return v.split(/[\n,]/).map((s) => s.trim()).filter(Boolean);
  }
  return [];
}

function asBool(v: unknown): boolean {
  return v === true || v === "true" || v === 1 || v === "1";
}

export interface PanelApi {
  handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void>;
}

export function createPanelApi(ctx: GatewayContext, requireAdmin: (req: IncomingMessage, url: URL) => boolean): PanelApi {
  const { cfg, accounts, keys, logs, settings, scheduler, quota } = ctx;

  function guard(req: IncomingMessage, res: ServerResponse, url: URL): boolean {
    if (requireAdmin(req, url)) return true;
    sendJson(res, 401, { error: { message: "管理员令牌无效或缺失", code: "unauthorized" } });
    return false;
  }

  function overview(): Record<string, unknown> {
    /* 概览是读路径，但要把攒批中的用量先落库，否则今日统计会滞后几秒 */
    quota.flush();
    const snap = scheduler.snapshot();
    const all = accounts.list();
    const now = Date.now();
    return {
      publicUrl: cfg.publicUrl,
      guardMode: cfg.guardMode,
      stegoMode: cfg.stegoMode,
      reqIdInResponse: cfg.reqIdInResponse,
      injectMissing: cfg.injectMissing,
      upstreamBase: cfg.upstreamBase,
      pool: {
        total: snap.accounts,
        active: snap.active,
        cooling: snap.cooling,
        exhausted: snap.exhausted,
        sticky: snap.sticky,
        disabled: all.filter((a) => a.status === "disabled").length,
        errored: all.filter((a) => a.status === "error").length,
        oauth: all.filter((a) => a.kind === "oauth").length,
        apikey: all.filter((a) => a.kind === "apikey").length,
        coolingList: all
          .filter((a) => a.cooldownUntil && a.cooldownUntil * 1000 > now)
          .map((a) => ({ id: a.id, label: a.label, until: a.cooldownUntil })),
        exhaustedList: all
          .filter((a) => a.status === "exhausted")
          .map((a) => ({
            id: a.id,
            label: a.label,
            until: a.exhaustedUntil,
            reason: a.exhaustedReason
          }))
      },
      keys: keys.list().length,
      stats: logs.stats(),
      today: keys.todayTotals(dayString())
    };
  }

  async function get(req: IncomingMessage, res: ServerResponse, url: URL, action: string): Promise<void> {
    switch (action) {
      case "overview":
        sendJson(res, 200, { ok: true, data: overview() });
        return;

      case "accounts":
        sendJson(res, 200, { ok: true, data: accounts.list().map(publicAccount) });
        return;

      case "keys":
        sendJson(res, 200, { ok: true, data: keys.list().map((k) => publicKey(k, ctx)) });
        return;

      case "logs.requests": {
        const q: RequestLogQuery = {
          limit: clampInt(url.searchParams.get("limit"), 50, 1, 500),
          offset: clampInt(url.searchParams.get("offset"), 0, 0, 1_000_000),
          outcome: url.searchParams.get("outcome") ?? undefined,
          protocol: url.searchParams.get("protocol") ?? undefined,
          apiKeyId: url.searchParams.get("apiKeyId") ?? undefined,
          accountId: url.searchParams.get("accountId") ?? undefined,
          search: url.searchParams.get("search") ?? undefined,
          since: url.searchParams.get("since") ? Number(url.searchParams.get("since")) : undefined
        };
        sendJson(res, 200, { ok: true, ...logs.queryRequests(q) });
        return;
      }

      case "logs.runtime": {
        const q: RuntimeLogQuery = {
          limit: clampInt(url.searchParams.get("limit"), 100, 1, 500),
          offset: clampInt(url.searchParams.get("offset"), 0, 0, 1_000_000),
          level: url.searchParams.get("level") ?? undefined,
          scope: url.searchParams.get("scope") ?? undefined,
          search: url.searchParams.get("search") ?? undefined,
          since: url.searchParams.get("since") ? Number(url.searchParams.get("since")) : undefined
        };
        sendJson(res, 200, { ok: true, ...logs.queryRuntime(q) });
        return;
      }

      case "settings":
        sendJson(res, 200, {
          ok: true,
          data: {
            guardMode: cfg.guardMode,
            stegoMode: cfg.stegoMode,
            reqIdInResponse: cfg.reqIdInResponse,
            injectMissing: cfg.injectMissing,
            logRetentionDays: Number(settings.get("logRetentionDays", "14")),
            runtimeLogMax: Number(settings.get("runtimeLogMax", "20000"))
          }
        });
        return;

      case "account.export":
        sendJson(res, 200, {
          ok: true,
          data: accounts.list().map((a) => ({
            id: a.id,
            label: a.label,
            kind: a.kind,
            status: a.status,
            email: a.email,
            scope: a.scope,
            expiresAt: a.expiresAt,
            hasRefreshToken: !!a.refreshToken,
            hasApiKey: !!a.apiKey
          }))
        });
        return;

      default:
        sendJson(res, 400, { error: { message: "unknown action: " + action, code: "unknown_action" } });
    }
  }

  async function post(req: IncomingMessage, res: ServerResponse, url: URL, action: string): Promise<void> {
    const body = (await readJson(req, cfg.maxBodyBytes)) as Record<string, unknown>;

    switch (action) {
      /* 授权登录第一步：生成 PKCE、记下 pending、把链接给前端让用户去登录。
         面板固定走 manual 回调（platform.claude.com/oauth/code/callback），
         因为面板可能在内网、浏览器与网关不在一台机器上，localhost 回调够不着。 */
      case "oauth.start": {
        const started = startOAuth(ctx, { redirectUri: cfg.oauthManualRedirect, mode: "manual" });
        ctx.log.info("panel: oauth start state=" + started.state.slice(0, 8));
        sendJson(res, 200, { ok: true, data: { state: started.state, authorizeUrl: started.authorizeUrl, redirectUri: started.redirectUri, mode: started.mode } });
        return;
      }

      /* 授权登录第二步：拿回调码换令牌并建号。授权页给的是 code 或 code#state，两种都认 */
      case "oauth.finish": {
        const state = str(body.state).trim();
        const code = str(body.code).trim();
        if (!state || !code) {
          sendJson(res, 400, { error: { message: "缺少 state 或授权码", code: "invalid_input" } });
          return;
        }
        try {
          const done = await finishOAuth(ctx, state, code);
          ctx.log.info("panel: oauth finish account=" + done.account.id + " email=" + String(done.email ?? "-"));
          sendJson(res, 200, { ok: true, data: publicAccount(done.account) });
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          ctx.log.warn("panel: oauth finish failed: " + msg);
          sendJson(res, 400, { error: { message: msg, code: "oauth_failed" } });
        }
        return;
      }

      case "account.create": {
        const kind = str(body.kind, "apikey") === "oauth" ? "oauth" : "apikey";
        const secret = str(body.secret).trim();
        if (!secret) {
          sendJson(res, 400, { error: { message: "secret 不能为空", code: "invalid_input" } });
          return;
        }
        const label = str(body.label).trim() || (kind === "apikey" ? "Console Key" : "OAuth 账号");
        const acc = accounts.create(
          kind === "apikey"
            ? { label, kind, apiKey: secret }
            : { label, kind, refreshToken: secret, clientId: cfg.oauthClientId }
        );
        ctx.log.info("panel: account created " + acc.id + " kind=" + kind);
        sendJson(res, 200, { ok: true, data: publicAccount(acc) });
        return;
      }

      case "account.batch": {
        const kind = str(body.kind, "apikey") === "oauth" ? "oauth" : "apikey";
        const raw = str(body.lines);
        const lines = raw
          .split(/\r?\n/)
          .map((s) => s.trim())
          .filter((s) => s && !s.startsWith("#"));
        let created = 0;
        const errors: string[] = [];
        for (const line of lines) {
          const parts = line.split("|").map((s) => s.trim());
          const label = parts.length > 1 ? parts[0] : "";
          const secret = parts.length > 1 ? parts[1] : parts[0];
          if (!secret) continue;
          try {
            accounts.create(
              kind === "apikey"
                ? { label: label || "Console Key", kind, apiKey: secret }
                : { label: label || "OAuth 账号", kind, refreshToken: secret, clientId: cfg.oauthClientId }
            );
            created += 1;
          } catch (e) {
            errors.push(secret.slice(0, 10) + "...: " + (e instanceof Error ? e.message : String(e)));
          }
        }
        ctx.log.info("panel: batch import created=" + created + " failed=" + errors.length);
        sendJson(res, 200, { ok: true, data: { created, failed: errors.length, errors: errors.slice(0, 20) } });
        return;
      }

      case "account.update": {
        const id = str(body.id);
        const patch: Record<string, unknown> = {};
        if (body.label !== undefined) patch.label = str(body.label);
        if (body.weight !== undefined) patch.weight = clampInt(body.weight, 1, 1, 10);
        if (body.status !== undefined) {
          const s = str(body.status);
          if (s === "active" || s === "disabled" || s === "error") patch.status = s;
        }
        const next = accounts.update(id, patch as never);
        /* 手动启用要把「额度耗尽」的封印一并解除 */
        if (body.status === "active") accounts.clearExhausted(id);
        if (!next) {
          sendJson(res, 404, { error: { message: "账号不存在", code: "not_found" } });
          return;
        }
        sendJson(res, 200, { ok: true, data: publicAccount(next) });
        return;
      }

      case "account.delete": {
        const id = str(body.id);
        const ok = accounts.remove(id);
        ctx.log.info("panel: account deleted " + id);
        sendJson(res, ok ? 200 : 404, ok ? { ok: true } : { error: { message: "账号不存在", code: "not_found" } });
        return;
      }

      case "account.revive": {
        const id = str(body.id);
        const all = asBool(body.all);
        if (all) {
          const list = accounts.list().filter((a) => a.status === "exhausted");
          for (const a of list) accounts.clearExhausted(a.id);
          ctx.log.info("panel: revived " + list.length + " exhausted account(s)");
          sendJson(res, 200, { ok: true, data: { revived: list.length } });
          return;
        }
        const before = accounts.get(id);
        if (!before) {
          sendJson(res, 404, { error: { message: "账号不存在", code: "not_found" } });
          return;
        }
        accounts.clearExhausted(id);
        ctx.log.info("panel: revived exhausted account " + id);
        sendJson(res, 200, { ok: true, data: { revived: 1 } });
        return;
      }

      case "account.usage": {
        const all = asBool(body.all);
        const id = str(body.id);
        const targets = all ? accounts.list() : accounts.list().filter((a) => a.id === id);
        if (!targets.length) {
          sendJson(res, 404, { error: { message: "账号不存在", code: "not_found" } });
          return;
        }
        const results: Array<Record<string, unknown>> = [];
        for (const acc of targets) {
          const snap = await fetchOauthUsage(cfg, acc);
          accounts.saveUsage(acc.id, snap);

          /* 用量接口明说窗口 rejected，就直接封印到重置时刻 */
          let sealed: number | null = null;
          if (snap.ok) {
            for (const w of Object.values(snap.windows)) {
              if (w.status !== "rejected") continue;
              const nowSec = Math.floor(Date.now() / 1000);
              const at = w.resetsAt && w.resetsAt > nowSec ? w.resetsAt : nowSec + 5 * 3600;
              sealed = sealed === null ? at : Math.min(sealed, at);
            }
            if (sealed !== null) {
              const capped = Math.min(sealed, Math.floor(Date.now() / 1000) + 6 * 3600);
              accounts.markExhausted(acc.id, "用量接口显示窗口已 rejected", capped);
            }
          }
          results.push({ id: acc.id, label: acc.label, sealedUntil: sealed, ...snap });
        }
        ctx.log.info("panel: usage queried for " + results.length + " account(s)");
        sendJson(res, 200, { ok: true, data: results });
        return;
      }

      case "account.reset": {
        const id = str(body.id);
        const all = asBool(body.all);
        if (all) {
          accounts.clearCooldowns();
          sendJson(res, 200, { ok: true, data: { cleared: "all" } });
          return;
        }
        accounts.markOk(id);
        sendJson(res, 200, { ok: true, data: { cleared: id } });
        return;
      }

      case "key.create": {
        const input = {
          name: str(body.name).trim() || "未命名 Key",
          fingerprintMode: str(body.fingerprintMode, "claude_code") === "passthrough" ? ("passthrough" as const) : ("claude_code" as const),
          allowedModels: strList(body.allowedModels),
          allowedProtocols: strList(body.allowedProtocols),
          quotaEnabled: asBool(body.quotaEnabled),
          rateLimitPerMin: clampInt(body.rateLimitPerMin, 0, 0, 100000),
          dailyRequestLimit: clampInt(body.dailyRequestLimit, 0, 0, 10_000_000),
          dailyTokenLimit: clampInt(body.dailyTokenLimit, 0, 0, 1_000_000_000),
          boundAccountId: str(body.boundAccountId) || null
        };
        const { record, plaintext } = keys.create(input);
        ctx.log.info("panel: api key created " + record.id + " name=" + record.name);
        sendJson(res, 200, { ok: true, data: { key: publicKey(record, ctx), plaintext } });
        return;
      }

      case "key.update": {
        const id = str(body.id);
        const patch: Record<string, unknown> = {};
        if (body.name !== undefined) patch.name = str(body.name);
        if (body.enabled !== undefined) patch.enabled = asBool(body.enabled);
        if (body.fingerprintMode !== undefined) {
          patch.fingerprintMode = str(body.fingerprintMode) === "passthrough" ? "passthrough" : "claude_code";
        }
        if (body.allowedModels !== undefined) patch.allowedModels = strList(body.allowedModels);
        if (body.allowedProtocols !== undefined) patch.allowedProtocols = strList(body.allowedProtocols);
        if (body.quotaEnabled !== undefined) patch.quotaEnabled = asBool(body.quotaEnabled);
        if (body.rateLimitPerMin !== undefined) patch.rateLimitPerMin = clampInt(body.rateLimitPerMin, 0, 0, 100000);
        if (body.dailyRequestLimit !== undefined) patch.dailyRequestLimit = clampInt(body.dailyRequestLimit, 0, 0, 10_000_000);
        if (body.dailyTokenLimit !== undefined) patch.dailyTokenLimit = clampInt(body.dailyTokenLimit, 0, 0, 1_000_000_000);
        if (body.boundAccountId !== undefined) patch.boundAccountId = str(body.boundAccountId) || null;
        const next = keys.update(id, patch as never);
        if (!next) {
          sendJson(res, 404, { error: { message: "Key 不存在", code: "not_found" } });
          return;
        }
        sendJson(res, 200, { ok: true, data: publicKey(next, ctx) });
        return;
      }

      case "key.delete": {
        const id = str(body.id);
        const ok = keys.remove(id);
        ctx.log.info("panel: api key deleted " + id);
        sendJson(res, ok ? 200 : 404, ok ? { ok: true } : { error: { message: "Key 不存在", code: "not_found" } });
        return;
      }

      case "settings.save": {
        const patch: Record<string, string> = {};
        for (const k of SETTING_KEYS) {
          if (body[k] !== undefined) patch[k] = String(body[k]);
        }
        settings.setMany(patch);
        applyRuntimeSettings(cfg, patch);
        ctx.log.info("panel: settings saved", patch);
        sendJson(res, 200, { ok: true, data: patch });
        return;
      }

      case "logs.prune": {
        const days = clampInt(body.days ?? settings.get("logRetentionDays", "14"), 14, 1, 3650);
        const maxRows = clampInt(body.maxRows ?? settings.get("runtimeLogMax", "20000"), 20000, 100, 5_000_000);
        logs.prune(days, maxRows);
        sendJson(res, 200, { ok: true, data: { days, maxRows } });
        return;
      }

      default:
        sendJson(res, 400, { error: { message: "unknown action: " + action, code: "unknown_action" } });
    }
  }

  async function handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    if (!guard(req, res, url)) return;
    const action = url.searchParams.get("action") ?? "overview";
    try {
      if ((req.method ?? "GET").toUpperCase() === "POST") await post(req, res, url, action);
      else await get(req, res, url, action);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      ctx.log.error("panel api error: " + msg);
      if (!res.headersSent) {
        sendJson(res, 500, { error: { message: msg, code: "internal_error" } });
      }
    }
  }

  return { handle };
}
