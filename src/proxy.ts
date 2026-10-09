import { buildUpstreamHeaders, upstreamRequest } from "./upstream.ts";
import { rewriteUserId } from "./userid.ts";
import crypto from "node:crypto";
import type { Account, AuthState, GatewayContext, UpstreamResult } from "./types.ts";

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

  let account: Account | null = null;
  if (!auth.passthroughKey) {
    account = ctx.scheduler.pick({
      sessionKey: opts.sessionKey ?? "default",
      preferredAccountId: auth.apiKey?.boundAccountId ?? null
    });
    if (!account) return { error: "no_credential" };
    account = await ctx.credentials.ensure(account);
  }

  const headers = buildUpstreamHeaders(req, auth, cfg, account);
  /* 只兜底不覆盖：真 Claude Code 发的是 accept: application/json，
     替它改成 text/event-stream 会多一个可被识别的差异 */
  if (opts.stream && !Object.keys(headers).some((k) => k.toLowerCase() === "accept")) {
    headers["accept"] = "text/event-stream";
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
