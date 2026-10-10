import { buildUpstreamHeaders, upstreamRequest } from "./upstream.ts";
import { rewriteUserId } from "./userid.ts";
import { injectAttributionHeader } from "./fingerprint/attribution.ts";
import { CC_VERSION } from "./constants.ts";
import crypto from "node:crypto";
import { collect, decodeStream } from "./upstream.ts";
import { classifyUpstreamError } from "./pool/observe.ts";
import { isUpstreamError } from "./types.ts";
import type { Account, AuthState, GatewayContext, UpstreamOk, UpstreamResult } from "./types.ts";

export interface CallOptions {
  stream?: boolean;
  /** 会话键：同一会话优先复用同一个号 */
  sessionKey?: string;
}

/**
 * 统一的上游调用：从号池挑号 + 注入该号凭据 + 透传 Claude Code 头。
 * 挑不到可用号时返回 no_credential，由路由转成 401 提示去面板加号。
 */
export async function callUpstream(
  ctx: GatewayContext,
  req: import("node:http").IncomingMessage,
  auth: AuthState,
  path: string,
  body: unknown,
  opts: CallOptions = {}
): Promise<UpstreamResult> {
  const cfg = ctx.cfg;
  const sessionKey = opts.sessionKey ?? "default";
  const preferred = auth.apiKey?.boundAccountId ?? null;
  const maxAttempts = Math.max(1, cfg.upstreamRetries);
  const tried = new Set<string>();
  let last: UpstreamOk | null = null;

  /*
   * 换号重试。
   *
   * 之前是一次定生死：挑到一个号、上游回 429，整个请求就失败，
   * 那个号还被冷却 60 秒 —— 池子里明明还有别的号，却让调用方吃了个错误。
   * 号池的意义就是这里。
   *
   * 只对「换个号可能就好了」的状态重试：429 / 401 / 403 / 5xx。
   * 400 之类的请求本身有问题，换号也一样，重试只是白烧额度。
   */
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    let account: Account | null = null;
    if (!auth.passthroughKey) {
      account = ctx.scheduler.pick({
        sessionKey,
        preferredAccountId: preferred,
        exclude: tried
      });
      if (!account) {
        /* 已经试过、手里有上游的真实响应，就把那个还回去 ——
           它带着上游原话，比一句 no_credential 有用得多 */
        return last ?? noCredential(ctx);
      }
      account = await ctx.credentials.ensure(account);
      tried.add(account.id);
    }

    const result = await sendOnce(ctx, req, auth, path, body, opts, account);
    if (!isUpstreamError(result)) last = result;

    /* 直通模式没有号可换，或者压根没挑到号，都没有重试的余地 */
    if (isUpstreamError(result)) return result;
    if (!account) return result;
    if (!RETRYABLE_STATUS.has(result.status)) return result;
    if (attempt + 1 >= maxAttempts) return result;

    /* 先看看还有没有别的号 —— 没有就别白建一次连接 */
    const next = ctx.scheduler.pick({ sessionKey, preferredAccountId: preferred, exclude: tried });
    if (!next) return result;

    /* 这个号确实不行，当场记下来，别等 finalize（那时候 tracker 已经指向下一个号了）。
       必须用跟路由同一套判定读一遍响应体，否则「额度耗尽」会被降级成普通冷却 ——
       号该封印到重置，结果 60 秒后又被挑出来，来回撞同一个墙。 */
    await penalize(ctx, account.id, result);
    ctx.log.warn(
      "上游 " + result.status + "，换号重试：" + (account.label || account.id) + " -> " + (next.label || next.id)
    );
  }

  /* 理论上到不了这儿（循环里每个分支都 return 了），兜一下 */
  return last ?? noCredential(ctx);
}

/**
 * 放弃某个号之前，把这次上游错误读出来判定一下：是额度耗尽就封印到重置，
 * 否则只做短暂冷却。响应体读完即丢，这次响应本身已经不要了。
 */
async function penalize(ctx: GatewayContext, accountId: string, up: UpstreamOk): Promise<void> {
  let note = null;
  try {
    const buf = await collect(decodeStream(up.raw, up.headers["content-encoding"]), 256 * 1024);
    note = classifyUpstreamError(up, buf.toString("utf8"));
  } catch {
    /* 读不出来就当普通失败，至少别把它漏掉 */
  } finally {
    try { up.raw.resume(); } catch { /* 已经结束了就算了 */ }
  }

  if (note?.rateLimit) ctx.scheduler.observeRateLimit(accountId, note.rateLimit);
  if (note?.exhausted && note.resetAt) {
    ctx.scheduler.reportExhausted(accountId, note.reason || "额度耗尽", note.resetAt);
    return;
  }
  ctx.scheduler.reportFailure(accountId, up.status, "上游 " + up.status + (note?.message ? " " + note.message.slice(0, 120) : ""));
}

/** 挑不到号时的统一返回。reason 与 retryAfterSec 都来自调度器对池子的实际观察 */
function noCredential(ctx: GatewayContext): UpstreamResult {
  const why = ctx.scheduler.unavailableReason();
  return { error: "no_credential", reason: why.message, retryAfterSec: why.retryAfterSec };
}

/** 换个号可能就好了的状态。400 不在里面：那是请求本身的问题，重试白烧额度 */
const RETRYABLE_STATUS: ReadonlySet<number> = new Set([401, 403, 429, 500, 502, 503, 504, 529]);

/** 发一次请求。抽出来是为了让重试循环看得清 */
async function sendOnce(
  ctx: GatewayContext,
  req: import("node:http").IncomingMessage,
  auth: AuthState,
  path: string,
  body: unknown,
  opts: CallOptions,
  account: Account | null
): Promise<UpstreamResult> {
  const cfg = ctx.cfg;
  const headers = buildUpstreamHeaders(req, auth, cfg, account);
  /* 只兜底不覆盖：真 Claude Code 发的是 accept: application/json，
     替它改成 text/event-stream 会多一个可被识别的差异 */
  if (opts.stream && !Object.keys(headers).some((k) => k.toLowerCase() === "accept")) {
    headers["accept"] = "text/event-stream";
  }

  /*
   * 归因头。官方客户端把它作为 system 的第一段 text 块发出去 ——
   * 不是 HTTP 头，是 body 里的一段文本，所以必须在这里改 body。
   * 缺了它上游看到的就不是一个 Claude Code 客户端。
   */
  if (cfg.attributionHeader && body && typeof body === "object" && !Array.isArray(body)) {
    const b = body as Record<string, unknown>;
    if (Array.isArray(b.messages) || b.system !== undefined) {
      injectAttributionHeader(b, CC_VERSION, { entrypoint: cfg.attributionEntrypoint });
    }
  }

  /* 一个号固定一个 device_id，别让上游看到同一个号在到处漂 */
  if (account && body && typeof body === "object" && !Array.isArray(body)) {
    const deviceId = ctx.accounts.ensureDeviceId(account.id);
    const hdrSession = req.headers["x-claude-code-session-id"];
    const sessionId = typeof hdrSession === "string" && hdrSession ? hdrSession : crypto.randomUUID();
    const r = rewriteUserId(body as Record<string, unknown>, {
      deviceId,
      accountUuid: account.accountUuid,
      mode: cfg.rewriteUserId,
      createIfMissing: cfg.rewriteUserId !== "off",
      sessionId
    });
    if (r.changed) ctx.log.debug?.("user_id: " + r.reason);
  }

  const payload = Buffer.from(JSON.stringify(body), "utf8");
  const res = await upstreamRequest(cfg, { method: "POST", path, headers, body: payload });
  return { ...res, account };
}
