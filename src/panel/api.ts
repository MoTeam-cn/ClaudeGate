import { sendJson } from "../http/respond.ts";
import { readJson } from "../http/body.ts";
import { clampInt } from "../utils.ts";
import { applyRuntimeSettings } from "../config.ts";
import { dayString } from "../store/apikeys.ts";
import { fetchOauthUsage, windowsFromRateLimit } from "../pool/usage.ts";
import { fetchOauthProfile, profileLabel } from "../pool/profile.ts";
import { checkEgress } from "../net/ipcheck.ts";
import { catalogStatus, applyModelDisabled, parseDisabledSetting, applyModelLimits, limitsEditorState } from "../models.ts";
import { parseLimitsSetting } from "../model-limits.ts";
import { startOAuth, finishOAuth } from "../oauth-flow.ts";
import type { Account, ApiKeyRecord, GatewayContext, RequestLogQuery, RuntimeLogQuery, UsageSnapshot } from "../types.ts";
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
    /* 面板「设备指纹」列读的就是这个。之前没传，所以永远显示「待生成」 */
    deviceId: a.deviceId,
    accountUuid: a.accountUuid,
    mode: a.mode,
    scope: a.scope,
    expiresAt: a.expiresAt,
    errorCount: a.errorCount,
    /* 面板「请求」列读的就是这个。以前漏传，前端拿到 undefined，
       CG.fmtNum 兜底成 0 —— 看起来就像「后端根本没返回这一项」 */
    requestCount: a.requestCount,
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

      /* 面板登录密钥的当前状态。只读，不含任何密钥材料，只有模式与时间 */
      case "admin.keyinfo":
        sendJson(res, 200, { ok: true, data: ctx.adminKey.info() });
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

      /* 模型清单的状态：来源、条数、拉取时间、错误 */
      case "models.status":
        sendJson(res, 200, { ok: true, data: catalogStatus(ctx) });
        return;

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

  /** 名字还是系统给的占位符？（这种才值得去上游补真名） */
  function isPlaceholderLabel(label: string): boolean {
    const t = label.trim();
    return (
      /^账号\s*\d+$/.test(t) ||
      t === "OAuth 账号" ||
      t === "Console Key" ||
      t === "从 credential.json 迁移" ||
      /^[0-9a-f]{8}$/.test(t)
    );
  }

  /**
   * 查一次额度并落库；用量接口明说窗口 rejected 就封印到重置时刻。
   * account.usage 与 oauth.finish（加号后自动查）共用这一份，别让封印逻辑长成两套。
   */
  async function refreshUsage(acc: Account, timeoutMs = 15000): Promise<{ snap: UsageSnapshot; sealedUntil: number | null }> {
    const snap = await fetchOauthUsage(cfg, acc, timeoutMs);
    accounts.saveUsage(acc.id, snap);

    /* 名字还是占位的话顺手把档案拉回来。
       粘贴 refresh_token 建的号在创建时没有 access_token，只有走到这里才拿得到真名 */
    if (acc.kind === "oauth" && acc.accessToken && isPlaceholderLabel(acc.label)) {
      const prof = await fetchOauthProfile(cfg, acc.accessToken, 8000);
      const name = prof ? profileLabel(prof) : null;
      if (name) {
        const patch: Record<string, unknown> = { label: name };
        if (prof && prof.email && !acc.email) patch.email = prof.email;
        accounts.update(acc.id, patch as never);
        ctx.log.info("panel: 账号 " + acc.id + " 名称补全为 " + name);
      }
    }

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
    return { snap, sealedUntil: sealed };
  }

  async function post(req: IncomingMessage, res: ServerResponse, url: URL, action: string): Promise<void> {
    const body = (await readJson(req, cfg.maxBodyBytes)) as Record<string, unknown>;

    switch (action) {
      /* 重置登录密钥。传 key 用自定义值，不传就随机生成。
         明文只在这一次响应里回去，之后只留 scrypt 哈希 —— 不再进日志 */
      case "admin.keyreset": {
        const custom = str(body.key).trim();
        try {
          const key = ctx.adminKey.reset(custom || undefined);
          ctx.log.warn("panel: 登录密钥已重置（" + (custom ? "自定义" : "随机生成") + "）");
          sendJson(res, 200, { ok: true, data: { key, info: ctx.adminKey.info() } });
        } catch (e) {
          sendJson(res, 400, { error: { message: e instanceof Error ? e.message : String(e), code: "reset_failed" } });
        }
        return;
      }

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

          /* 建完号顺手查一次额度，省得再手点「查用量」。
             订阅号才有这个接口；超时压到 8 秒，别把面板拖住。
             账号此时已经建好了，这里失败也不影响它 */
          let usage: UsageSnapshot | null = null;
          if (done.account.kind === "oauth") {
            const r = await refreshUsage(done.account, 8000);
            usage = r.snap;
            ctx.log.info("panel: oauth usage for " + done.account.id + " ok=" + r.snap.ok + (r.snap.ok ? "" : " err=" + String(r.snap.error ?? "")));
          }
          /* 把档案一并带回去：面板可以顺手显示套餐档位，不用再单开一个接口 */
          sendJson(res, 200, {
            ok: true,
            data: { ...publicAccount(done.account), usage, displayName: done.displayName, profile: done.profile }
          });
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

      /* 出口自检。启动时跑过一次，这里是手动再跑 —— 换了代理不用重启就能验 */
      /* 手动重拉模型目录。平时不刷 —— /v1/models 只读内存 */
      case "models.refresh": {
        const st = await ctx.modelCatalog.refresh();
        ctx.log.info("panel: 模型目录刷新 " + st.entries.length + " 个 source=" + st.source);
        sendJson(res, 200, { ok: true, data: catalogStatus(ctx) });
        return;
      }

      /* 每个模型的上下文窗口与最大输出。编辑器的初始状态 */
      case "models.limits":
        sendJson(res, 200, { ok: true, data: limitsEditorState(ctx) });
        return;

      /*
       * 保存模型限制。只存「专门给这个模型配的」那些项，
       * 没配的留给 "*" 兜底 —— 这样以后目录里加新模型会自动继承兜底值，
       * 不用挨个补一遍。
       */
      case "models.limits.save": {
        const raw = body.limits;
        const incoming = parseLimitsSetting(typeof raw === "string" ? raw : JSON.stringify(raw ?? {}));
        settings.set("modelLimits", JSON.stringify(incoming));
        applyModelLimits(ctx);
        ctx.log.info("panel: 模型上下文限制更新为 " + Object.keys(incoming).length + " 项");
        sendJson(res, 200, { ok: true, data: limitsEditorState(ctx) });
        return;
      }

      /* 面板里勾掉/勾上哪些模型。存进 settings，然后立刻重新应用一遍隐藏清单 */
      case "models.disable": {
        const ids = Array.isArray(body.ids) ? body.ids.map((x) => String(x)).filter(Boolean) : [];
        settings.set("modelDisabled", JSON.stringify(ids));
        applyModelDisabled(ctx);
        const st = catalogStatus(ctx);
        ctx.log.info("panel: 模型隐藏清单更新为 " + ids.length + " 项，对外 " + st.count + " 个模型");
        sendJson(res, 200, { ok: true, data: st });
        return;
      }

      /*
       * 刷新账号信息：拉档案（真名 / 邮箱 / 套餐）+ 查一次额度。
       * 跟「查用量」的区别是这里**强制**拉档案 —— 老号的备注名是建号时瞎填的默认值，
       * 那些值不一定长得像占位符，靠 refreshUsage 里的启发式补不全，得手动刷一次。
       */
      case "account.refresh": {
        const one = str(body.id).trim();
        const all = accounts.list();
        const targets = one ? all.filter((x) => x.id === one) : all;
        if (one && !targets.length) {
          sendJson(res, 404, { error: { message: "账号不存在", code: "not_found" } });
          return;
        }
        const out: Array<Record<string, unknown>> = [];
        for (const acc of targets) {
          let name: string | null = null;
          let email: string | null = null;
          let plan: string | null = null;
          let profileError: string | null = null;
          if (acc.kind === "oauth") {
            if (!acc.accessToken) {
              profileError = "这个号还没有 access_token（先去查一次用量让它刷新）";
            } else {
              const prof = await fetchOauthProfile(cfg, acc.accessToken, 10000);
              if (!prof) {
                profileError = "档案接口没返回可用数据";
              } else {
                name = profileLabel(prof);
                email = prof.email;
                plan = prof.planDisplayName ?? prof.subscriptionType;
                const patch: Record<string, unknown> = {};
                if (name) patch.label = name;
                if (email) patch.email = email;
                if (Object.keys(patch).length) accounts.update(acc.id, patch as never);
              }
            }
          } else {
            profileError = "Console Key 没有档案接口，只能查额度";
          }
          const fresh = accounts.get(acc.id) ?? acc;
          let usageOk: boolean | null = null;
          let usageError: string | null = null;
          try {
            const r = await refreshUsage(fresh, 15000);
            usageOk = r.snap.ok;
            usageError = r.snap.ok ? null : (r.snap.error ?? "查询失败");
          } catch (e) {
            usageError = e instanceof Error ? e.message : String(e);
          }
          const after = accounts.get(acc.id) ?? fresh;
          out.push({
            id: acc.id,
            before: acc.label,
            label: after.label,
            email: after.email,
            plan: after.usage?.subscriptionType ?? plan,
            profileError,
            usageOk,
            usageError
          });
        }
        ctx.log.info("panel: 刷新账号信息 " + out.length + " 个");
        sendJson(res, 200, { ok: true, data: { refreshed: out.length, results: out } });
        return;
      }

      case "net.ipcheck": {
        const chk = await checkEgress(cfg, 8000);
        ctx.log.info("panel: 出口自检 " + chk.summary);
        sendJson(res, 200, { ok: true, data: chk });
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
          const { snap, sealedUntil } = await refreshUsage(acc);
          results.push({ id: acc.id, label: acc.label, sealedUntil, ...snap });
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

      /* 重置密钥：只换明文，其它配置保留。新明文只在这条响应里回一次 */
      case "key.reset": {
        const id = str(body.id);
        const done = keys.resetSecret(id);
        if (!done) {
          sendJson(res, 404, { error: { message: "Key 不存在", code: "not_found" } });
          return;
        }
        ctx.log.warn("panel: api key secret reset " + id);
        sendJson(res, 200, { ok: true, data: { key: publicKey(done.record, ctx), plaintext: done.plaintext } });
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
