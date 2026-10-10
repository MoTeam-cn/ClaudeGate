import { sendHtml, sendJson } from "../http/respond.ts";
import { createPanelApi } from "../panel/api.ts";
import { panelHtml } from "../panel/html.ts";
import { PANEL_ASSETS, findPanelAsset } from "../panel/assets.ts";
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

  /**
   * 面板静态资源。URL 上带 ?v=<内容指纹>，内容变了地址就变，
   * 所以可以放心长缓存；不带指纹（有人手敲地址）就退回 no-cache。
   * 同样不需要鉴权：它们只是样式与脚本，不含任何数据。
   */
  function asset(req: IncomingMessage, res: ServerResponse, url: URL): void {
    const found = findPanelAsset(url.pathname);
    if (!found) {
      sendJson(res, 404, { error: "not found" });
      return;
    }
    const body = Buffer.from(found.body, "utf8");
    res.writeHead(200, {
      "content-type": found.contentType,
      "content-length": String(body.length),
      "cache-control": url.searchParams.get("v") ? "public, max-age=31536000, immutable" : "no-cache",
      etag: '"' + found.tag + '"'
    });
    if ((req.method ?? "GET").toUpperCase() === "HEAD") {
      res.end();
      return;
    }
    res.end(body);
  }

  async function apiHandler(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    await api.handle(req, res, url);
  }

  /* 资源路由由 PANEL_ASSETS 派生，避免路径写两遍对不上 */
  const assetRoutes = PANEL_ASSETS.map((a) => ({ method: "GET", path: a.path, handler: asset }));

  return { page, api: apiHandler, asset, assetRoutes };
}
