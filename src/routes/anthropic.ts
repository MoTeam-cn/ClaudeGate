import { createMessages } from "./anthropic/messages.ts";
import { createCountTokens } from "./anthropic/count.ts";
import { anthropicError } from "../http/respond.ts";
import { requestIdOf } from "../http/context.ts";
import type { AuthState, GatewayContext } from "../types.ts";
import type { IncomingMessage, ServerResponse } from "node:http";

/**
 * Anthropic 原生路由。
 *
 * 两个处理器按用途拆在 anthropic/ 下（messages / count），
 * 这里只留装配与两个错误应答小工具 —— 单文件曾达 372 行。
 */
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

  const messages = createMessages({ cfg, log, ctx, blocked, rejectPolicy });
  const countTokens = createCountTokens({ cfg, log, ctx, blocked, rejectPolicy });

  return { messages, countTokens };
}
