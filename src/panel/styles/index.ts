/**
 * 面板样式表的拼装点。零依赖、零构建，服务端拼成一份 CSS 下发。
 */
import { BASE_CSS } from "./base.ts";
import { DATA_CSS } from "./data.ts";
import { WIDGETS_CSS } from "./widgets.ts";
import { TOOLTIP_CSS } from "./tooltip.ts";
import { AUTH_CSS } from "./auth.ts";

export const PANEL_CSS: string = [
  BASE_CSS,
  DATA_CSS,
  WIDGETS_CSS,
  TOOLTIP_CSS,
  AUTH_CSS,
].join("\n") + "\n})();\n";
