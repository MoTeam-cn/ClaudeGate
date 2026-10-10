import { callUpstream } from "../proxy.ts";
import { pipeUpstream, decodeStream, collect, passThroughHeaders } from "../upstream.ts";
import { openaiError, sendJson } from "../http/respond.ts";
import { readJson } from "../http/body.ts";
import { requestIdOf, getTracker } from "../http/context.ts";
import { inspectPayload } from "../security/inspect.ts";
import { checkKeyPolicy, sessionKeyOf } from "../middleware/auth.ts";
import { noteUpstream, noteUpstreamError } from "../pool/observe.ts";
import { openaiToAnthropic } from "../translate/openai-in.ts";
import { anthropicToOpenai, streamAnthropicToOpenai } from "../translate/openai-out.ts";
import { listModels, checkModelAllowed } from "../models.ts";
import { checkContext } from "../model-limits.ts";
import { bool, safeJson } from "../utils.ts";
import { withBeta } from "../constants.ts";
import { isUpstreamError } from "../types.ts";
import type { AnthropicResponse, AuthState, GatewayContext, OpenAIChatRequest } from "../types.ts";
import type { IncomingMessage, ServerResponse } from "node:http";

export function createOpenaiRoutes(ctx: GatewayContext) {
  const cfg = ctx.cfg;
  const log = ctx.log;

  /** POST /v1/chat/completions —— OpenAI 协议，内部转 Anthropic */
  async function chat(req: IncomingMessage, res: ServerResponse, auth: AuthState): Promise<void> {
    const tracker = getTracker(res);

    let input: OpenAIChatRequest;
    try {
      input = (await readJson(req, cfg.maxBodyBytes)) as OpenAIChatRequest;
    } catch (e) {
      openaiError(res, 400, "invalid JSON body: " + (e instanceof Error ? e.message : String(e)));
      return;
    }
    if (!Array.isArray(input.messages) || !input.messages.length) {
      openaiError(res, 400, "messages is required");
      return;
    }

    const verdict = inspectPayload(input, cfg);
    if (verdict.action === "block") {
      if (tracker) {
        tracker.outcome = "blocked";
        tracker.blockReason = verdict.code ?? null;
        tracker.blockDetail = verdict.message ?? null;
      }
      log.warn("[" + (requestIdOf(res) ?? "-") + "] blocked: " + (verdict.code ?? ""));
      openaiError(res, 400, verdict.message ?? "blocked", "invalid_request_error", verdict.code ?? null);
      return;
    }
    const clean = verdict.payload as OpenAIChatRequest;

    const wantStream = !!clean.stream;
    const payload = openaiToAnthropic(clean, cfg);
    payload.stream = wantStream;
    const model = payload.model ?? cfg.defaultModel;
    const requested = typeof clean.model === "string" ? clean.model : null;

    if (tracker) {
      tracker.stream = wantStream;
      tracker.model = requested;
      tracker.upstreamModel = model;
    }

    const policy = checkKeyPolicy(auth, "openai", requested);
    if (!policy.ok) {
      if (tracker) {
        tracker.outcome = "blocked";
        tracker.blockReason = policy.code ?? "policy_rejected";
        tracker.blockDetail = policy.reason ?? null;
      }
      log.warn("[" + (requestIdOf(res) ?? "-") + "] policy reject: " + (policy.code ?? ""));
      openaiError(res, 403, policy.reason ?? "rejected", "permission_error", policy.code ?? "policy_rejected");
      return;
    }

    /* 模型必须在 /v1/models 那份清单里 */
    const mcheck = checkModelAllowed(ctx, requested);
    if (!mcheck.ok) {
      if (tracker) {
        tracker.outcome = "blocked";
        tracker.blockReason = "model_not_found";
        tracker.blockDetail = mcheck.reason;
      }
      log.warn("[" + (requestIdOf(res) ?? "-") + "] 模型不在清单里：" + String(requested));
      openaiError(res, 400, mcheck.reason, "invalid_request_error", "model_not_found");
      return;
    }

    /* 上下文超限检查。量的是真正要发上游的那份（已翻译成 Anthropic 形状） */
    if (ctx.cfg.contextGuard !== "off") {
      const ccheck = checkContext(ctx.cfg, requested, payload);
      if (ccheck.compaction) {
        log.debug("[" + (requestIdOf(res) ?? "-") + "] 压缩请求，跳过上下文检查（约 " + ccheck.estimated + " tokens）");
      }
      if (!ccheck.ok) {
        log.warn(
          "[" + (requestIdOf(res) ?? "-") + "] 上下文超限：约 " + ccheck.estimated +
          " tokens，上限 " + ccheck.ceiling
        );
        if (ctx.cfg.contextGuard === "block") {
          if (tracker) {
            tracker.outcome = "blocked";
            tracker.blockReason = "context_too_long";
            tracker.blockDetail = ccheck.reason;
          }
          openaiError(res, 400, ccheck.reason, "invalid_request_error", "context_too_long");
          return;
        }
      }
    }

    let up;
    try {
      /* 必须带 ?beta=true：官方客户端就是这么打的，缺了会被按另一条路径限流 */
      up = await callUpstream(ctx, req, auth, withBeta("/v1/messages"), payload, {
        stream: wantStream,
        sessionKey: sessionKeyOf(req, auth)
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (tracker) {
        tracker.outcome = "error";
        tracker.errorMessage = msg;
      }
      openaiError(res, 502, "upstream request failed: " + msg, "api_error");
      return;
    }
    if (isUpstreamError(up)) {
      /* 挑不到号不是「你的 Key 不对」，所以不给 401 —— 401 会让客户端以为密钥废了。
         503 才能让它按可重试处理。原因由调度器给出：空池 / 冷却 / 耗尽 / 停用，各不相同。 */
      const why = up.reason ?? "号池里没有可用账号。";
      if (tracker) {
        tracker.outcome = "error";
        tracker.errorMessage = "no_credential: " + why;
      }
      log.warn("[" + (requestIdOf(res) ?? "-") + "] " + why);
      /* 全在冷却 = 暂时性的限流，用 429 + Retry-After，客户端会退避重试；
         其余（空池 / 全停用）才是 503 —— 重试也不会好 */
      if (up.retryAfterSec) res.setHeader("retry-after", String(up.retryAfterSec));
      openaiError(
        res,
        up.retryAfterSec ? 429 : 503,
        why,
        up.retryAfterSec ? "rate_limit_error" : "api_error",
        "no_credential"
      );
      return;
    }

    if (tracker) noteUpstream(ctx, tracker, up);

    if (up.status >= 400) {
      const buf = await collect(decodeStream(up.raw, up.headers["content-encoding"]), 8 * 1024 * 1024).catch(() => Buffer.alloc(0));
      const text = buf.toString("utf8");
      const note = tracker ? noteUpstreamError(tracker, up, text) : null;
      /* 上游报错要进运行日志：请求日志只留一列，塞不下完整响应体 */
      log.warn("[" + (requestIdOf(res) ?? "-") + "] 上游 " + up.status + "：" + (note?.message ?? ""));
      openaiError(
        res,
        up.status,
        note?.message ?? ("HTTP " + up.status),
        note?.errorType ?? "api_error"
      );
      return;
    }

    if (wantStream) {
      streamAnthropicToOpenai(
        res,
        decodeStream(up.raw, up.headers["content-encoding"]),
        model,
        bool(clean.stream_options?.include_usage, false),
        (u) => {
          if (!tracker) return;
          tracker.promptTokens = u.promptTokens;
          tracker.completionTokens = u.completionTokens;
          tracker.cacheCreationTokens = u.cacheCreationTokens;
          tracker.cacheReadTokens = u.cacheReadTokens;
          tracker.outcome = "ok";
        }
      );
      return;
    }

    await pipeUpstream(res, up, {
      json: true,
      transform: (parsed) => {
        const p = parsed as AnthropicResponse;
        if (tracker) {
          tracker.promptTokens = p.usage?.input_tokens ?? 0;
          tracker.completionTokens = p.usage?.output_tokens ?? 0;
          tracker.cacheCreationTokens = p.usage?.cache_creation_input_tokens ?? 0;
          tracker.cacheReadTokens = p.usage?.cache_read_input_tokens ?? 0;
          tracker.outcome = "ok";
        }
        return anthropicToOpenai(p, model);
      }
    });
  }

  /** GET /v1/models */
  function models(req: IncomingMessage, res: ServerResponse): void {
    /* ensure() 只在缓存过期时后台刷一次，这个请求永远读内存 */
    const snapshot = ctx.modelCatalog.ensure();
    sendJson(res, 200, { object: "list", data: listModels(ctx), catalog: { source: snapshot.source, fetchedAt: snapshot.fetchedAt, version: snapshot.version, error: snapshot.error } });
  }

  return { chat, models };
}
