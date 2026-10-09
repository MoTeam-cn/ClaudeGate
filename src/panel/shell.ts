import type { GatewayContext } from "../types.ts";
import { TOKENS_CSS } from "./tokens.ts";
import { COMPONENTS_CSS } from "./components.ts";
import { CLIENT_JS } from "./client.ts";
import { VIEWS_JS } from "./views.ts";

/**
 * 面板单页。样式与脚本都内联，零依赖、零构建、单进程。
 *
 * 拆成五份是有意的：token（调色板）、组件（类名与视觉）、运行时（DOM/消息/表格/路由）、
 * 视图（各页）、外壳（这里）。换皮只动 token，加组件只动组件，加页只动视图。
 */
export function panelHtml(ctx: GatewayContext): string {
  const hasAdmin = !!ctx.cfg.adminToken;
  const authNote = hasAdmin ? "已启用 ADMIN_TOKEN 鉴权" : "未设置 ADMIN_TOKEN，无鉴权";
  return [
    "<!doctype html>",
    '<html lang="zh-CN" data-theme="dark">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">',
    '<meta name="color-scheme" content="dark light">',
    "<title>Claude Gateway</title>",
    "<style>",
    TOKENS_CSS,
    COMPONENTS_CSS,
    "</style>",
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
    '      <button class="el-button cg-burger" id="burger" title="菜单">☰</button>',
    '      <h1 id="pageTitle">概览</h1>',
    '      <span class="sub" id="pageSub"></span>',
    '      <span class="sp" style="flex:1"></span>',
    '      <label class="el-switch" title="每 15 秒自动刷新"><input type="checkbox" id="auto"><span class="el-switch__core"></span></label>',
    '      <button class="el-button" id="theme" title="切换主题">◐</button>',
    '      <button class="el-button el-button--primary" id="reload">刷新</button>',
    '    </header>',
    '    <main class="cg-content" id="view"></main>',
    '  </div>',
    '</div>',
    '<script>',
    CLIENT_JS,
    VIEWS_JS,
    '</script>',
    '</body>',
    '</html>',
    ""
  ].join("\n");
}
