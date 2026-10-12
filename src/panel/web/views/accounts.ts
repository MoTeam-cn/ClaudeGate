/**
 * 面板视图 · 号池
 *
 * 与设置视图一样，它只是一段字符串：服务端把片段按 index.ts 里的顺序拼成
 * 一个 bundle 再下发给浏览器。
 *
 * 三段拆在 accounts/ 下（列表渲染 / 添加授权 / 批量与行动作），这里只做拼装。
 * 拼接顺序与原文件一致；浏览器侧全是函数声明，提升规则保证调用顺序没问题。
 * 拆分原因：单文件曾达 365 行。
 */
import { ACCOUNTS_VIEW_JS } from "./accounts/view.ts";
import { ACCOUNTS_ADD_JS } from "./accounts/add.ts";
import { ACCOUNTS_ACTIONS_JS } from "./accounts/actions.ts";

export const ACCOUNTS_JS =
  ACCOUNTS_VIEW_JS +
  ACCOUNTS_ADD_JS +
  ACCOUNTS_ACTIONS_JS;
