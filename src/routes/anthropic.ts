import { callUpstream } from "../proxy.ts";
import {
  pipeUpstream,
  collect,
  decodeStream,
  createUsageSniffer,
  passThroughHeaders,
  StreamHeadError
} from "../upstream.ts";
import type { PipeResult } from "../upstream.ts";
import { anthropicError } from "../http/respond.ts";
import { readJson } from "../http/body.ts";
import { requestIdOf, getTracker } from "../http/context.ts";
import { inspectPayload } from "../security/inspect.ts";
import { askedForClassifier, answeredByClassifier, createClassifierSniffer, logClassifier } from "../security/classifier.ts";
import { checkKeyPolicy, sessionKeyOf } from "../middleware/auth.ts";
import { checkModelAllowed } from "../models.ts";
import { checkContext } from "../model-limits.ts";
import { checkIdentity } from "../security/identity.ts";
import { withBeta } from "../constants.ts";
import { noteUpstream, noteUpstreamError } from "../pool/observe.ts";
import { isUpstreamError } from "../types.ts";
import type { AnthropicResponse, AuthState, GatewayContext } from "../types.ts";
import type { IncomingMessage, ServerResponse } from "node:http";

export function createAnthropicRoutes(ctx: GatewayContext) {
  const cfg = ctx.cfg;
  const log = ctx.log;

  function blocked(res: ServerResponse, code: string | undefined, message: string | undefined): void {
    log.warn("[" + (requestIdOf(res) ?? "-") + "] blocked: " + (code ?? ""));
    anthropicError(res, 400, message ?? "blocked", "invalid_request_error", code ?? null);
  }

  function rejectPolicy(res: ServerResponse, code: string, reason: string): void {
    log.warn("[" + (requestIdOf(res) ?? "-") + "] policy reject: " + code);
    anthropicError(res, 403, reason, "permission_error", code);
  }

  /** POST /v1/messages —— Anthropic 原生透传（含 SSE） */
  async function messages(req: IncomingMessage, res: ServerResponse, auth: AuthState, url: URL): Promise<void> {
    const tracker = getTracker(res);
    const raw = await readJson(req, cfg.maxBodyBytes);

    const verdict = inspectPayload(raw, cfg);
    if (verdict.action === "block") {
      if (tracker) {
        tracker.outcome = "blocked";
        tracker.blockReason = verdict.code ?? null;
        tracker.blockDetail = verdict.message ?? null;
      }
      blocked(res, verdict.code, verdict.message);
      return;
    }

    const body = verdict.payload as { stream?: boolean; model?: string };
    const wantsStream = !!body.stream;
    /* auto mode 的服务端分类：客户端在请求里挂 safeguards，等响应带回 safeguard_results */
    const classifierAsked = askedForClassifier(body);
    const model = typeof body.model === "string" ? body.model : null;
    if (tracker) {
      tracker.stream = wantsStream;
      tracker.model = model;
    }

    const policy = checkKeyPolicy(auth, "anthropic", model);
    if (!policy.ok) {
      if (tracker) {
        tracker.outcome = "blocked";
        tracker.blockReason = policy.code ?? "policy_rejected";
        tracker.blockDetail = policy.reason ?? null;
      }
      rejectPolicy(res, policy.code ?? "policy_rejected", policy.reason ?? "rejected");
      return;
    }

    /* 模型必须在 /v1/models 那份清单里 */
    const mcheck = checkModelAllowed(ctx, model);
    if (!mcheck.ok) {
      if (tracker) {
        tracker.outcome = "blocked";
        tracker.blockReason = "model_not_found";
        tracker.blockDetail = mcheck.reason;
      }
      log.warn("[" + (requestIdOf(res) ?? "-") + "] 模型不在清单里：" + String(model));
      anthropicError(res, 400, mcheck.reason, "invalid_request_error", "model_not_found");
      return;
    }

    /*
     * 请求体身份校验：确认对方真是 Claude Code，不是手搓的脚本。
     *
     * 只对走守卫的 Key 生效 —— passthrough 的 Key 是「我自己要发我的指纹」，
     * 那是管理员自己的用法，跟 applyGuard 的取舍保持一致。
     * 只做在 /v1/messages 上：/v1/chat/completions 面向的是 OpenAI 形状的
     * 第三方客户端，它们本来就不该带 Claude Code 的 system。
     */
    if (ctx.cfg.identityMode !== "off" && auth.useClaudeFingerprint !== false) {
      const icheck = checkIdentity(body);
      if (!icheck.ok) {
        log.warn("[" + (requestIdOf(res) ?? "-") + "] 身份校验失败：" + icheck.reason);
        if (ctx.cfg.identityMode === "block") {
          if (tracker) {
            tracker.outcome = "blocked";
            tracker.blockReason = "not_claude_code";
            tracker.blockDetail = icheck.reason;
          }
          anthropicError(
            res,
            403,
            "这个端点只对 Claude Code 客户端开放。" + icheck.reason,
            "permission_error",
            "not_claude_code"
          );
          return;
        }
      }
    }

    /*
     * 上下文超限检查。放在发上游之前 —— 拦在这里才不白烧一个号。
     * 只对配了 MODEL_LIMITS 的模型生效；没配就是不限制。
     */
    if (ctx.cfg.contextGuard !== "off") {
      const ccheck = checkContext(ctx.cfg, model, body);
      if (ccheck.compaction) {
        log.debug("[" + (requestIdOf(res) ?? "-") + "] 压缩请求，跳过上下文检查（约 " + ccheck.estimated + " tokens）");
      }
      if (!ccheck.ok) {
        log.warn(
          "[" + (requestIdOf(res) ?? "-") + "] 上下文超限：约 " + ccheck.estimated +
          " tokens，上限 " + ccheck.ceiling + "（窗口 " + (ccheck.limit?.context ?? 0) + "）"
        );
        if (ctx.cfg.contextGuard === "block") {
          if (tracker) {
            tracker.outcome = "blocked";
            tracker.blockReason = "context_too_long";
            tracker.blockDetail = ccheck.reason;
          }
          anthropicError(res, 400, ccheck.reason, "invalid_request_error", "context_too_long");
          return;
        }
      }
    }

    let up;
    try {
      /* 客户端带了 beta=true 就原样转发；没带就补上 —— 官方客户端一定会带 */
      up = await callUpstream(ctx, req, auth, withBeta(url.pathname, url.search), body, {
        stream: wantsStream,
        sessionKey: sessionKeyOf(req, auth)
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (tracker) {
        tracker.outcome = "error";
        tracker.errorMessage = msg;
      }
      anthropicError(res, 502, "upstream request failed: " + msg, "api_error");
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
      anthropicError(
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
      res.writeHead(up.status, passThroughHeaders(up));
      res.end(buf);
      return;
    }

    if (wantsStream) {
      const sniffer = createUsageSniffer();
      const cSniffer = createClassifierSniffer();
      const tap = (chunk: Buffer): void => {
        sniffer.tap(chunk);
        cSniffer.tap(chunk);
        if (!tracker) return;
        /* 每个分片同步抄一次：res 的 close 可能早于 await 之后，
           收尾时再赋值就来不及落库了 */
        const u = sniffer.usage();
        tracker.promptTokens = u.promptTokens;
        tracker.completionTokens = u.completionTokens;
        tracker.cacheCreationTokens = u.cacheCreationTokens;
        tracker.cacheReadTokens = u.cacheReadTokens;
      };

      if (tracker) tracker.outcome = "ok";
      const startedAt = Date.now();
      let result: PipeResult;
      try {
        result = await pipeUpstream(res, up, { tap });
      } catch (e) {
        /*
         * 只有一种情况会走到这里：上游在首字节之前就断了（StreamHeadError）。
         * 此时响应头一个字节都没发出去，客户端还以为请求在路上 ——
         * 换一次号重来它完全察觉不到。代理抽风唯一能被吃掉的地方就在这儿。
         */
        const msg = e instanceof Error ? e.message : String(e);
        const canRetry = e instanceof StreamHeadError && !res.headersSent;
        log.warn(
          "[" + (requestIdOf(res) ?? "-") + "] 流式响应在首字节前中断：" + msg + (canRetry ? "，换号重试一次" : "")
        );
        if (!canRetry) throw e;
        const retry = await callUpstream(ctx, req, auth, withBeta(url.pathname, url.search), body, {
          stream: wantsStream,
          sessionKey: sessionKeyOf(req, auth)
        });
        if (isUpstreamError(retry) || retry.status >= 400) throw e;
        up = retry;
        if (tracker) noteUpstream(ctx, tracker, up);
        try {
          result = await pipeUpstream(res, up, { tap });
        } catch (e2) {
          /* 重试还是首字节前就断 —— 代理/落地这一跳确实不通。
             给一个 5xx：Claude Code 把 5xx 当可重试，会按退避重来，
             而不会掉进「200 却一个事件都没有」那条更糟的路。 */
          const msg2 = e2 instanceof Error ? e2.message : String(e2);
          if (tracker) {
            tracker.outcome = "error";
            tracker.errorMessage = msg2;
          }
          log.warn("[" + (requestIdOf(res) ?? "-") + "] 重试后仍在首字节前中断：" + msg2);
          anthropicError(res, 502, "upstream stream failed before the first byte: " + msg2, "api_error", "stream_head_failed");
          return;
        }
      }

      logClassifier(log, requestIdOf(res) ?? "-", classifierAsked, cSniffer.saw());

      const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
      if (result.aborted) {
        /* 流被中途打断。运行日志里必须看得见 ——
           否则用户只知道「断了」，不知道断在哪个环节、断了多久之后 */
        if (tracker) tracker.errorMessage = "stream aborted: " + (result.error ?? "unknown");
        log.warn(
          "[" + (requestIdOf(res) ?? "-") + "] 流式响应中断：" +
            result.bytes + " 字节 / " + seconds + " 秒 · " + (result.error ?? "unknown")
        );
      } else {
        log.debug?.(
          "[" + (requestIdOf(res) ?? "-") + "] 流式响应完成：" + result.bytes + " 字节 / " + seconds + " 秒"
        );
      }
      return;
    }

    await pipeUpstream(res, up, {
      json: true,
      transform: (parsed) => {
        const p = parsed as AnthropicResponse;
        logClassifier(log, requestIdOf(res) ?? "-", classifierAsked, answeredByClassifier(parsed));
        if (tracker) {
          tracker.promptTokens = p.usage?.input_tokens ?? 0;
          tracker.completionTokens = p.usage?.output_tokens ?? 0;
          tracker.cacheCreationTokens = p.usage?.cache_creation_input_tokens ?? 0;
          tracker.cacheReadTokens = p.usage?.cache_read_input_tokens ?? 0;
          tracker.outcome = "ok";
        }
        return parsed;
      }
    });
  }

  /** POST /v1/messages/count_tokens */
  async function countTokens(req: IncomingMessage, res: ServerResponse, auth: AuthState): Promise<void> {
    const tracker = getTracker(res);
    const raw = await readJson(req, cfg.maxBodyBytes);

    const verdict = inspectPayload(raw, cfg);
    if (verdict.action === "block") {
      if (tracker) {
        tracker.outcome = "blocked";
        tracker.blockReason = verdict.code ?? null;
        tracker.blockDetail = verdict.message ?? null;
      }
      blocked(res, verdict.code, verdict.message);
      return;
    }

    const payload = verdict.payload as { model?: string };
    const model = typeof payload.model === "string" ? payload.model : null;
    if (tracker) tracker.model = model;

    const policy = checkKeyPolicy(auth, "anthropic", model);
    if (!policy.ok) {
      if (tracker) {
        tracker.outcome = "blocked";
        tracker.blockReason = policy.code ?? "policy_rejected";
        tracker.blockDetail = policy.reason ?? null;
      }
      rejectPolicy(res, policy.code ?? "policy_rejected", policy.reason ?? "rejected");
      return;
    }

    let up;
    try {
      up = await callUpstream(ctx, req, auth, withBeta("/v1/messages/count_tokens"), payload, {
        sessionKey: sessionKeyOf(req, auth)
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (tracker) {
        tracker.outcome = "error";
        tracker.errorMessage = msg;
      }
      anthropicError(res, 502, "upstream request failed: " + msg, "api_error");
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
      anthropicError(
        res,
        up.retryAfterSec ? 429 : 503,
        why,
        up.retryAfterSec ? "rate_limit_error" : "api_error",
        "no_credential"
      );
      return;
    }

    if (tracker) {
      noteUpstream(ctx, tracker, up);
      tracker.outcome = up.status >= 400 ? "error" : "ok";
    }
    await pipeUpstream(res, up, { json: true });
  }

  return { messages, countTokens };
}
