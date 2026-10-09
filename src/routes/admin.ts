import { signGatewayToken } from "../tokens.ts";
import { sendJson, sendText } from "../http/respond.ts";
import { lowerHeaders, headerValue } from "../utils.ts";
import type { GatewayContext } from "../types.ts";
import type { IncomingMessage, ServerResponse } from "node:http";

export function createAdminRoutes(ctx: GatewayContext) {
  const { cfg, accounts, keys, logs } = ctx;
  const startedAt = Date.now();

  /**
   * 面板鉴权。密钥由 admin-key 模块管：首次启动自动派发，面板里可重置。
   * 显式设了 ADMIN_TOKEN 时它完全接管（逃生口）。
   */
  function requireAdmin(req: IncomingMessage, url: URL): boolean {
    const h = lowerHeaders(req.headers);
    const given = headerValue(h["x-admin-token"] as string | string[] | undefined) || url.searchParams.get("key") || "";
    return ctx.adminKey.verify(given);
  }

  /** 首页直接进面板。面板自己会问登录密钥 */
  function root(req: IncomingMessage, res: ServerResponse, url: URL): void {
    res.writeHead(302, { location: "/panel", "cache-control": "no-store" });
    res.end();
  }

  function token(req: IncomingMessage, res: ServerResponse, url: URL): void {
    if (!requireAdmin(req, url)) {
      sendText(res, 401, "unauthorized");
      return;
    }
    sendText(res, 200, signGatewayToken(cfg, "default") + "\n");
  }

  function health(req: IncomingMessage, res: ServerResponse): void {
    const all = accounts.list();
    const now = Date.now();
    sendJson(res, 200, {
      ok: true,
      accounts: all.length,
      activeAccounts: all.filter((a) => a.status === "active" && (!a.cooldownUntil || a.cooldownUntil * 1000 <= now)).length,
      apiKeys: keys.list().length,
      guardMode: cfg.guardMode,
      stegoMode: cfg.stegoMode,
      injectMissing: cfg.injectMissing,
      upstream: cfg.upstreamBase,
      uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
      stats: logs.stats(),
      time: new Date().toISOString()
    });
  }

  function logout(req: IncomingMessage, res: ServerResponse, url: URL): void {
    if (!requireAdmin(req, url)) {
      sendText(res, 401, "unauthorized");
      return;
    }
    /* 号池化之后不存在「单一登录态」，登出请在面板里停用或删除账号 */
    sendJson(res, 200, { ok: true, note: "号池模式下请到面板停用或删除账号" });
  }

  return { root, token, health, logout, requireAdmin };
}
