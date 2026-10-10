/**
 * 面板静态资源的装配与寻址。
 *
 * 面板以前把 CSS 与全部脚本内联进一个 HTML，一次导航就要重下 130KB 且不能缓存，
 * 单文件也长到没法读。现在拆成三份独立资源：
 *   /panel/assets/panel.css   样式（token + 组件）
 *   /panel/assets/core.js     运行时（DOM / 接口 / 表格 / 路由）
 *   /panel/assets/views.js    各页视图
 *
 * 每份带内容指纹 ?v=<sha256 前 12 位>：内容一变 URL 就变，所以可以放心 immutable。
 * 外壳 HTML 仍然 no-store，它只有几十行。
 *
 * 仍然零依赖、零构建：片段是源码里的字符串，这里按序拼装后直接下发。
 */
import crypto from "node:crypto";

import { PANEL_CSS } from "./styles/index.ts";
import { CORE_JS } from "./web/index.ts";
import { VIEWS_JS } from "./web/views/index.ts";

export interface PanelAsset {
  /** 路由用的绝对路径（不含查询串） */
  path: string;
  /** 资源名，给 assetUrl 用 */
  name: string;
  contentType: string;
  body: string;
  /** 内容指纹，同时当 ETag */
  tag: string;
}

function build(path: string, name: string, contentType: string, body: string): PanelAsset {
  return {
    path,
    name,
    contentType,
    body,
    tag: crypto.createHash("sha256").update(body).digest("hex").slice(0, 12)
  };
}

export const PANEL_ASSETS: readonly PanelAsset[] = [
  build("/panel/assets/panel.css", "panel.css", "text/css; charset=utf-8", PANEL_CSS),
  build("/panel/assets/core.js", "core.js", "text/javascript; charset=utf-8", CORE_JS),
  build("/panel/assets/views.js", "views.js", "text/javascript; charset=utf-8", VIEWS_JS)
];

/** 带内容指纹的地址。找不到就是装配期写错了，直接抛 */
export function assetUrl(name: string): string {
  for (const a of PANEL_ASSETS) if (a.name === name) return a.path + "?v=" + a.tag;
  throw new Error("未知面板资源：" + name);
}

export function findPanelAsset(pathname: string): PanelAsset | null {
  for (const a of PANEL_ASSETS) if (a.path === pathname) return a;
  return null;
}
