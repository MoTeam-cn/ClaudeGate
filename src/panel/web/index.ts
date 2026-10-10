/**
 * 面板运行时 bundle 的拼装点：片段只是字符串，这里按依赖顺序拼成一个 IIFE。
 */
import { PRELUDE_JS } from "./prelude.ts";
import { DOM_JS } from "./dom.ts";
import { FORMAT_JS } from "./format.ts";
import { TOKEN_JS } from "./token.ts";
import { NET_JS } from "./net.ts";
import { TOAST_JS } from "./toast.ts";
import { DIALOG_JS } from "./dialog.ts";
import { AUTH_DIALOG_JS } from "./auth-dialog.ts";
import { SKELETON_JS } from "./skeleton.ts";
import { INLINE_EDIT_JS } from "./inline-edit.ts";
import { MENU_JS } from "./menu.ts";
import { TOOLTIP_JS } from "./tooltip.ts";
import { SELECT_JS } from "./select.ts";
import { TABLE_JS } from "./table.ts";
import { PAGER_JS } from "./pager.ts";
import { ROUTER_JS } from "./router.ts";
import { CHROME_JS } from "./chrome.ts";
import { AUTO_JS } from "./auto.ts";
import { EXPORTS_JS } from "./exports.ts";
import { BOOT_JS } from "./boot.ts";

export const CORE_JS: string = [
  "(function(){",
  '"use strict";',
  PRELUDE_JS,
  DOM_JS,
  FORMAT_JS,
  TOKEN_JS,
  NET_JS,
  TOAST_JS,
  DIALOG_JS,
  AUTH_DIALOG_JS,
  SKELETON_JS,
  INLINE_EDIT_JS,
  MENU_JS,
  TOOLTIP_JS,
  SELECT_JS,
  TABLE_JS,
  PAGER_JS,
  ROUTER_JS,
  CHROME_JS,
  AUTO_JS,
  EXPORTS_JS,
  BOOT_JS,
].join("\n") + "\n})();\n";
