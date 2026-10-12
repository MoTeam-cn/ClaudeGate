import { sendJson } from "../http/respond.ts";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { GatewayContext } from "../types.ts";
import { createRefreshUsage } from "./api/usage.ts";
import { handleGet } from "./api/get.ts";
import { handlePost } from "./api/post.ts";
import type { PanelDeps } from "./api/types.ts";

/**
 * 面板 API 的入口。
 *
 * 实现按域拆在 api/ 下（views / usage / get / post-account / post-key / post-misc），
 * 这里只做鉴权、分派与兜底 —— 单文件曾达 695 行。
 *
 * 处理器从闭包里搬出去之后不能再直接捕获 cfg / accounts / ...，
 * 这些全在 ctx 上，所以只传一个 PanelDeps（ctx + 带状态的 refreshUsage）。
 */

export interface PanelApi {
  handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void>;
}

export function createPanelApi(ctx: GatewayContext, requireAdmin: (req: IncomingMessage, url: URL) => boolean): PanelApi {
  const deps: PanelDeps = { ctx, refreshUsage: createRefreshUsage(ctx) };

  function guard(req: IncomingMessage, res: ServerResponse, url: URL): boolean {
    if (requireAdmin(req, url)) return true;
    sendJson(res, 401, { error: { message: "管理员令牌无效或缺失", code: "unauthorized" } });
    return false;
  }

  async function handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    if (!guard(req, res, url)) return;
    const action = url.searchParams.get("action") ?? "overview";
    try {
      if ((req.method ?? "GET").toUpperCase() === "POST") await handlePost(deps, req, res, url, action);
      else await handleGet(deps, req, res, url, action);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      ctx.log.error("panel api error: " + msg);
      if (!res.headersSent) {
        sendJson(res, 500, { error: { message: msg, code: "internal_error" } });
      }
    }
  }

  return { handle };
}
