import { sendHtml, sendJson } from "../http/respond.ts";
import { createPanelApi } from "../panel/api.ts";
import { panelHtml } from "../panel/html.ts";
import type { GatewayContext } from "../types.ts";
import type { IncomingMessage, ServerResponse } from "node:http";

export function createPanelRoutes(ctx: GatewayContext, requireAdmin: (req: IncomingMessage, url: URL) => boolean) {
  const api = createPanelApi(ctx, requireAdmin);

  /**
   * 面板外壳不再要鉴权 —— 它就是一份静态 HTML，不含任何数据。
   * 令牌由前端弹窗问用户，存 localStorage，之后所有 /panel/api 调用带 x-admin-token 头。
   * 这样令牌不会出现在 URL、浏览器历史、Referer 和服务端访问日志里。
   */
  function page(req: IncomingMessage, res: ServerResponse, url: URL): void {
    sendHtml(res, 200, panelHtml(ctx));
  }

  async function apiHandler(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    await api.handle(req, res, url);
  }

  return { page, api: apiHandler };
}
