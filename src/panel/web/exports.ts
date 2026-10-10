/**
 * 面板运行时 · 导出到 window.CG
 *
 * 从原来的面板单文件里拆出来的片段。它只是一段字符串：面板零依赖、零构建，
 * 服务端把片段按 index.ts 里的顺序拼成一个 bundle 再下发给浏览器。
 */
export const EXPORTS_JS = String.raw`
/* ============ 导出给各视图用 ============ */
window.CG = {
  api:api, toast:toast, showErr:showErr, dialog:dialog, confirmDialog:confirmDialog, promptDialog:promptDialog,
  h:h, $:$, $$:$$, esc:esc, clear:clear, paint:paint, shouldPaint:shouldPaint, busy:busy, skeleton:skeleton, emptyState:emptyState, table:table, pager:pager,
  go:go, onRefresh:onRefresh, refresh:refresh, fmtTime:fmtTime, fmtTimeTz:fmtTimeTz, tzLabel:tzLabel, fmtAgo:fmtAgo, fmtNum:fmtNum, fmtDur:fmtDur,
  lastData:lastData, getToken:function(){ return TOKEN; },
  setToken:setToken, clearToken:clearToken, askToken:askToken
};
window.CG.switchBox = switchBox;
window.CG.selectBox = selectBox;
window.CG.inlineEdit = inlineEdit;
window.CG.moreMenu = moreMenu;
window.CG.tip = tip;
window.CG.tipBind = tipBind;
window.CG.switchBox = switchBox;
window.CG.clearRefreshers = clearRefreshers;
window.CG.toggleTheme = toggleTheme;
window.CG.toggleSide = toggleSide;
window.CG.setAuto = setAuto;
window.CG.isAuto = function(){ return AUTO; };
`;
