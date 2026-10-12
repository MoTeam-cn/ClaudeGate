import { callUpstream } from "../../proxy.ts";
import {
  pipeUpstream,
  collect,
  decodeStream,
  createUsageSniffer,
  passThroughHeaders,
  StreamHeadError
} from "../../upstream.ts";
import type { PipeResult } from "../../upstream.ts";
import { anthropicError } from "../../http/respond.ts";
import { readJson } from "../../http/body.ts";
import { requestIdOf, getTracker } from "../../http/context.ts";
import { inspectPayload } from "../../security/inspect.ts";
import { askedForClassifier, answeredByClassifier, createClassifierSniffer, logClassifier } from "../../security/classifier.ts";
import { checkKeyPolicy, sessionKeyOf } from "../../middleware/auth.ts";
import { checkModelAllowed } from "../../models.ts";
import { checkContext } from "../../model-limits.ts";
import { checkIdentity, systemDigest, systemTexts } from "../../security/identity.ts";
import { withBeta } from "../../constants.ts";
import { noteUpstream, noteUpstreamError } from "../../pool/observe.ts";
import { isUpstreamError } from "../../types.ts";
import type { AnthropicResponse, AuthState, GatewayContext } from "../../types.ts";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AnthropicDeps } from "./deps.ts";
export function createCountTokens(deps: AnthropicDeps) {
  const { cfg, log, ctx, blocked, rejectPolicy } = deps;

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

  return countTokens;
}
