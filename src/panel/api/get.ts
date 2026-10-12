import { sendJson } from "../../http/respond.ts";
import { clampInt } from "../../utils.ts";
import { catalogStatus } from "../../models.ts";
import { dayString } from "../../store/apikeys.ts";
import type { RequestLogQuery, RuntimeLogQuery } from "../../types.ts";
import type { IncomingMessage, ServerResponse } from "node:http";
import { publicAccount, publicKey } from "./views.ts";
import type { PanelDeps } from "./types.ts";

function overview(deps: PanelDeps): Record<string, unknown> {
  const { cfg, accounts, keys, logs, scheduler, quota } = deps.ctx;
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

export async function handleGet(
  deps: PanelDeps,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  action: string
): Promise<void> {
  const { cfg, accounts, keys, logs, settings } = deps.ctx;

  switch (action) {
    case "overview":
      sendJson(res, 200, { ok: true, data: overview(deps) });
      return;

    /* 面板登录密钥的当前状态。只读，不含任何密钥材料，只有模式与时间 */
    case "admin.keyinfo":
      sendJson(res, 200, { ok: true, data: deps.ctx.adminKey.info() });
      return;

    case "accounts":
      sendJson(res, 200, { ok: true, data: accounts.list().map(publicAccount) });
      return;

    case "keys":
      sendJson(res, 200, { ok: true, data: keys.list().map((k) => publicKey(k, deps.ctx)) });
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
      sendJson(res, 200, { ok: true, data: catalogStatus(deps.ctx) });
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
