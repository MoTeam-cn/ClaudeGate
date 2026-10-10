/**
 * 面板样式表的拼装点。零依赖、零构建，服务端拼成一份 CSS 下发。
 *
 * **顺序有意义**：TOKENS_CSS 先落 :root 里的 --el-* 设计变量，
 * 后面的片段才能用 var(--el-*) 取到值。少这一份，全站 var() 解析为空 ——
 * 表现就是整个面板变成没有任何样式的裸 HTML（拆分时漏过一次）。
 */
import { TOKENS_CSS } from "../tokens.ts";
import { BASE_CSS } from "./base.ts";
import { DATA_CSS } from "./data.ts";
import { WIDGETS_CSS } from "./widgets.ts";
import { TOOLTIP_CSS } from "./tooltip.ts";
import { AUTH_CSS } from "./auth.ts";

export const PANEL_CSS: string = [
  TOKENS_CSS,
  BASE_CSS,
  DATA_CSS,
  WIDGETS_CSS,
  TOOLTIP_CSS,
  AUTH_CSS
].join("\n");
