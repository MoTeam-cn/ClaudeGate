import { sendJson } from "../http/respond.ts";
import { setRequestMeta, setTracker } from "../http/context.ts";
import { newRequestId } from "../ids.ts";
import { applyGuard } from "../guard.ts";
import { authenticate, rejectUnauthorized, rejectGuard, rejectQuota } from "../middleware/auth.ts";
import type { IncomingMessage, ServerResponse } from "node:http";
import type {
  ApiKeyStore, ApiRoute, AuthState, Config, LogStore, Logger,
  PublicRoute, QuotaGuard, RequestMeta, RequestTracker, Scheduler
} from "../types.ts";
import { clientIpOf, isOpenaiPath, protocolOf, shouldLogRequest } from "./helpers.ts";

/**
 * 请求分发器的依赖。
 *
 * handler 原本是 createGateway 里的闭包，直接捕获了这些值；
 * 搬出来之后必须显式传进来。publicIndex / apiIndex 是路由表。
 */
export interface DispatcherDeps {
  cfg: Config;
  log: Logger;
  keys: ApiKeyStore;
  logs: LogStore;
  quota: QuotaGuard;
  scheduler: Scheduler;
  publicIndex: Map<string, PublicRoute>;
  apiIndex: Map<string, ApiRoute>;
}

export function createDispatcher(deps: DispatcherDeps) {
  const { cfg, log, keys, logs, quota, scheduler, publicIndex, apiIndex } = deps;

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

  return handler;
}
