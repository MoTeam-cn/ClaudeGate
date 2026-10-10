/**
 * 面板外壳。只负责一份很薄的 HTML：结构 + 两个 script 标签 + 一个样式链接。
 *
 * 样式与脚本都在 /panel/assets/* 上单独下发并带内容指纹（见 assets.ts），
 * 所以这里不再内联任何代码 —— 以前这一份 HTML 有两千多行，改一行要滚半天，
 * 而且每次导航都得重下 130KB。
 *
 * 实现拆在 web/（运行时与视图）与 styles/（样式表）两个目录里，加页只动视图。
 */
import type { GatewayContext } from "../types.ts";
import { assetUrl } from "./assets.ts";

export function panelHtml(ctx: GatewayContext): string {
  /* 登录密钥由 admin-key 模块派发与校验，永远启用；前端弹窗索取并存 localStorage，不进 URL。
     adminKey 缺省时（比如只拿 cfg 造 ctx 的单测）退化成一句静态说明，不要抛错 */
  const ak = ctx.adminKey ? ctx.adminKey.info() : null;
  const authNote = !ak
    ? "已启用登录密钥"
    : ak.envOverride
      ? "由 ADMIN_TOKEN 接管"
      : ak.mode === "custom"
        ? "已启用登录密钥（面板里重置过）"
        : "已启用登录密钥";
  return [
    "<!doctype html>",
    '<html lang="zh-CN" data-theme="dark">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">',
    '<meta name="color-scheme" content="dark light">',
    "<title>Claude Gateway</title>",
    '<link rel="stylesheet" href="' + assetUrl("panel.css") + '">',
    "</head>",
    "<body>",
    '<div id="messages" class="cg-messages"></div>',
    '<div class="cg-app">',
    '  <aside class="cg-side" id="side">',
    '    <div class="cg-brand"><span class="dot"></span><div><b>Claude Gateway</b><small id="brandSub">号池网关</small></div></div>',
    '    <nav class="cg-menu" id="menu">',
    '      <div class="cg-menu-item" data-route="overview"><span class="ico">◈</span><span>概览</span></div>',
    '      <div class="cg-menu-item" data-route="accounts"><span class="ico">☰</span><span>号池</span></div>',
    '      <div class="cg-menu-item" data-route="keys"><span class="ico">⚿</span><span>API Key</span></div>',
    '      <div class="cg-menu-item" data-route="reqlogs"><span class="ico">≡</span><span>请求日志</span></div>',
    '      <div class="cg-menu-item" data-route="rtlogs"><span class="ico">▤</span><span>运行日志</span></div>',
    '      <div class="cg-menu-item" data-route="settings"><span class="ico">⚙</span><span>设置</span></div>',
    '    </nav>',
    '    <div class="cg-side-foot">' + authNote + "</div>",
    '  </aside>',
    '  <div class="cg-main">',
    '    <header class="cg-header">',
    '      <button class="el-button cg-burger" id="burger" data-tip="菜单">☰</button>',
    '      <h1 id="pageTitle">概览</h1>',
    '      <span class="sub" id="pageSub"></span>',
    '      <span class="sp" style="flex:1"></span>',
    '      <label class="el-switch" data-tip="每 15 秒自动刷新"><input type="checkbox" id="auto"><span class="el-switch__core"></span></label>',
    '      <button class="el-button" id="theme" data-tip="切换主题">◐</button>',
    '      <button class="el-button el-button--primary" id="reload">刷新</button>',
    '    </header>',
    '    <main class="cg-content" id="view"></main>',
    '  </div>',
    '</div>',
    '<script src="' + assetUrl("core.js") + '"></script>',
    '<script src="' + assetUrl("views.js") + '"></script>',
    "</body>",
    "</html>",
    ""
  ].join("\n");
}
