/**
 * 面板视图 bundle 的拼装点：共享的 CG/h 在这里统一取出，各页片段直接用。
 */
import { ICONS_JS } from "./icons.ts";
import { BITS_JS } from "./bits.ts";
import { OVERVIEW_JS } from "./overview.ts";
import { ACCOUNTS_JS } from "./accounts.ts";
import { KEYS_JS } from "./keys.ts";
import { REQLOGS_JS } from "./reqlogs.ts";
import { RTLOGS_JS } from "./rtlogs.ts";
import { SETTINGS_JS } from "./settings.ts";
import { DISPATCH_JS } from "./dispatch.ts";

export const VIEWS_JS: string = [
  "(function(){",
  '"use strict";',
  "var CG = window.CG, h = CG.h, $ = CG.$, $$ = CG.$$, esc = CG.esc;",
  ICONS_JS,
  BITS_JS,
  OVERVIEW_JS,
  ACCOUNTS_JS,
  KEYS_JS,
  REQLOGS_JS,
  RTLOGS_JS,
  SETTINGS_JS,
  DISPATCH_JS,
].join("\n") + "\n})();\n";
