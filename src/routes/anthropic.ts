import { callUpstream } from "../proxy.ts";
import { pipeUpstream, collect, decodeStream, createUsageSniffer, passThroughHeaders } from "../upstream.ts";
import { anthropicError } from "../http/respond.ts";
import { readJson } from "../http/body.ts";
import { requestIdOf, getTracker } from "../http/context.ts";
import { inspectPayload } from "../security/inspect.ts";
import { checkKeyPolicy, sessionKeyOf } from "../middleware/auth.ts";
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

    let up;
    try {
      up = await callUpstream(ctx, req, auth, url.pathname + url.search, body, {
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
      if (tracker) {
        tracker.outcome = "error";
        tracker.errorMessage = "no_credential";
      }
      anthropicError(res, 401, "号池里没有可用账号，请先在面板添加或启用账号。", "authentication_error", "no_credential");
      return;
    }

    if (tracker) noteUpstream(ctx, tracker, up);

    if (up.status >= 400) {
      const buf = await collect(decodeStream(up.raw, up.headers["content-encoding"]), 8 * 1024 * 1024).catch(() => Buffer.alloc(0));
      const text = buf.toString("utf8");
      if (tracker) noteUpstreamError(tracker, up, text);
      res.writeHead(up.status, passThroughHeaders(up));
      res.end(buf);
      return;
    }

    if (wantsStream) {
      const sniffer = createUsageSniffer();
      if (tracker) tracker.outcome = "ok";
      /* 每个分片同步抄一次：res 的 close 可能早于 await 之后，
         收尾时再赋值就来不及落库了 */
      await pipeUpstream(res, up, {
        tap: (chunk) => {
          sniffer.tap(chunk);
          if (!tracker) return;
          const u = sniffer.usage();
          tracker.promptTokens = u.promptTokens;
          tracker.completionTokens = u.completionTokens;
          tracker.cacheCreationTokens = u.cacheCreationTokens;
          tracker.cacheReadTokens = u.cacheReadTokens;
        }
      });
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
      up = await callUpstream(ctx, req, auth, "/v1/messages/count_tokens", payload, {
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
      if (tracker) {
        tracker.outcome = "error";
        tracker.errorMessage = "no_credential";
      }
      anthropicError(res, 401, "号池里没有可用账号，请先在面板添加或启用账号。", "authentication_error", "no_credential");
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
