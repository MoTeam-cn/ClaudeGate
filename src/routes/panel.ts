import { sendHtml, sendJson } from "../http/respond.ts";
import { createPanelApi } from "../panel/api.ts";
import { panelHtml } from "../panel/html.ts";
import type { GatewayContext } from "../types.ts";
import type { IncomingMessage, ServerResponse } from "node:http";

export function createPanelRoutes(ctx: GatewayContext, requireAdmin: (req: IncomingMessage, url: URL) => boolean) {
  const api = createPanelApi(ctx, requireAdmin);

  function page(req: IncomingMessage, res: ServerResponse, url: URL): void {
    if (!requireAdmin(req, url)) {
      sendJson(res, 401, { error: { message: "管理员令牌无效或缺失。请用 /panel?key=ADMIN_TOKEN 访问。" } });
      return;
    }
    sendHtml(res, 200, panelHtml(ctx));
  }

  async function apiHandler(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    await api.handle(req, res, url);
  }

  return { page, api: apiHandler };
}
