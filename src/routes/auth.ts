import { startOAuth, finishOAuth } from "../oauth-flow.ts";
import { signGatewayToken } from "../tokens.ts";
import { sendHtml, sendJson } from "../http/respond.ts";
import { page, envSnippet, htmlEsc } from "../http/pages.ts";
import { b64url, randHex } from "../utils.ts";
import { readForm } from "../http/body.ts";
import type { GatewayContext, TokenResponse } from "../types.ts";
import type { IncomingMessage, ServerResponse } from "node:http";

function isLoopbackHost(hostHeader: string | undefined): boolean {
  const h = String(hostHeader ?? "").toLowerCase();
  return h.startsWith("localhost") || h.startsWith("127.0.0.1") ||
    h.startsWith("[::1]") || h.startsWith("0.0.0.0");
}

export function createAuthRoutes(ctx: GatewayContext) {
  const { cfg, store, log, accounts } = ctx;

  function login(req: IncomingMessage, res: ServerResponse, url: URL): void {
    const loopback = isLoopbackHost(req.headers.host) || url.searchParams.get("mode") === "loopback";
    const redirectUri = loopback
      ? "http://localhost:" + String(req.socket.localPort ?? cfg.port) + "/callback"
      : cfg.oauthManualRedirect;

    const started = startOAuth(ctx, { redirectUri, mode: loopback ? "auto" : "manual" });
    const state = started.state;
    const authUrl = started.authorizeUrl;

    if (loopback) {
      res.writeHead(302, { location: authUrl, "cache-control": "no-store" });
      res.end();
      return;
    }

    let inner = "";
    inner += "<h1>授权登录</h1><div class=\"sub\">两步完成：授权页会显示一段 code，复制后粘贴回来。授权成功后账号会进入号池。</div>";
    inner += "<div class=\"card\"><h2>① 打开授权页</h2>" +
      "<a class=\"btn\" target=\"_blank\" rel=\"noopener\" href=\"" + htmlEsc(authUrl) + "\">打开 Anthropic 授权页</a>" +
      "<div class=\"sub\" style=\"margin:12px 0 0\">按钮无效时手动访问：<br>" +
      "<code style=\"word-break:break-all\">" + htmlEsc(authUrl) + "</code></div></div>";
    inner += "<div class=\"card\"><h2>② 粘贴授权码</h2>" +
      "<form method=\"POST\" action=\"/login/manual\">" +
      "<input type=\"hidden\" name=\"state\" value=\"" + state + "\">" +
      "<input type=\"text\" name=\"code\" placeholder=\"粘贴 code 或 code#state\" autocomplete=\"off\">" +
      "<button class=\"btn\" type=\"submit\">完成登录</button></form>" +
      "<div class=\"sub\" style=\"margin:10px 0 0\">想全程自动回调？把落地机端口转发到本机后访问 " +
      "<code>http://localhost:" + cfg.port + "/login</code>。</div></div>";
    sendHtml(res, 200, page("授权登录", inner));
  }

  async function complete(res: ServerResponse, state: string, rawCode: string): Promise<void> {
    try {
      /* 解析 code#state、换令牌、建号都在 oauth-flow 里，面板走的是同一份逻辑 */
      const done = await finishOAuth(ctx, state, rawCode);
      const account = done.account;

      const token = signGatewayToken(cfg, "default");
      log.info("login success, account=" + account.id + " scopes=" + String(done.scope ?? ""));

      let inner = "<h1 class=\"ok\">登录成功</h1><div class=\"sub\">账号 " + htmlEsc(account.label) + " 已进入号池。</div>";
      inner += "<div class=\"card\"><h2>Claude Code 接入（复制即用）</h2><pre>" +
        htmlEsc(envSnippet(cfg, token)) + "</pre></div>";
      inner += "<div class=\"card\"><h2>网关令牌</h2><pre>" + htmlEsc(token) + "</pre>" +
        "<div class=\"sub\" style=\"margin:10px 0 0\">面板里可以继续加号、发 API Key。删除 data/secret 重启可让全部令牌失效。</div></div>";
      inner += "<div class=\"card\"><a class=\"btn\" href=\"/panel\">进入面板</a> " +
        "<a class=\"btn\" href=\"/login\" style=\"background:#2a3140\">再登一个号</a></div>";
      sendHtml(res, 200, page("登录成功", inner));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log.error("login exchange failed: " + msg);
      sendHtml(res, 400, page("登录失败",
        "<h1 class=\"bad\">换取令牌失败</h1><pre>" + htmlEsc(msg) + "</pre><p class=\"sub\"><a href=\"/login\">重试</a></p>"));
    }
  }

  function callback(req: IncomingMessage, res: ServerResponse, url: URL): void {
    const err = url.searchParams.get("error");
    if (err) {
      sendHtml(res, 400, page("登录失败", "<h1 class=\"bad\">授权被拒绝</h1><pre>" + htmlEsc(err) + "</pre>"));
      return;
    }
    void complete(res, url.searchParams.get("state") ?? "", url.searchParams.get("code") ?? "");
  }

  async function manual(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const params = await readForm(req, cfg.maxBodyBytes);
    await complete(res, params.get("state") ?? "", params.get("code") ?? "");
  }

  /** Claude Code gateway 模式要求的刷新端点（form-urlencoded） */
  async function oauthToken(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const params = await readForm(req, cfg.maxBodyBytes);
    const grant = params.get("grant_type") ?? "";
    if (grant !== "refresh_token" && grant !== "client_credentials") {
      sendJson(res, 400, { error: "unsupported_grant_type" });
      return;
    }
    const list = accounts.list();
    if (!list.length) {
      sendJson(res, 401, { error: "invalid_grant" });
      return;
    }
    const t = signGatewayToken(cfg, "default");
    const scope = list.find((a) => a.scope)?.scope ?? "";
    sendJson(res, 200, {
      access_token: t,
      token_type: "Bearer",
      expires_in: Math.floor(cfg.tokenTtlDays * 86400),
      refresh_token: t,
      scope
    });
  }

  return { login, callback, manual, oauthToken };
}
