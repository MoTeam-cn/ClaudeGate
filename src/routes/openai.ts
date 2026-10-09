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
import { listModels } from "../models.ts";
import { bool, safeJson } from "../utils.ts";
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

    let up;
    try {
      up = await callUpstream(ctx, req, auth, "/v1/messages", payload, {
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
      if (tracker) {
        tracker.outcome = "error";
        tracker.errorMessage = "no_credential";
      }
      openaiError(res, 401, "号池里没有可用账号，请先在面板添加或启用账号。", "authentication_error", "no_credential");
      return;
    }

    if (tracker) noteUpstream(ctx, tracker, up);

    if (up.status >= 400) {
      const buf = await collect(decodeStream(up.raw, up.headers["content-encoding"]), 8 * 1024 * 1024).catch(() => Buffer.alloc(0));
      const text = buf.toString("utf8");
      const note = tracker ? noteUpstreamError(tracker, up, text) : null;
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
    sendJson(res, 200, { object: "list", data: listModels() });
  }

  return { chat, models };
}
