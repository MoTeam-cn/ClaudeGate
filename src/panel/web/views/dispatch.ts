/**
 * 面板视图 · 路由分发
 *
 * 从原来的面板单文件里拆出来的片段。它只是一段字符串：面板零依赖、零构建，
 * 服务端把片段按 index.ts 里的顺序拼成一个 bundle 再下发给浏览器。
 */
export const DISPATCH_JS = String.raw`
/* ============ 路由分发 ============ */
function render(){
  var box = $("#view");
  if(!box) return;
  CG.clear(box);
  CG.clearRefreshers();
  var map = { overview:renderOverview, accounts:renderAccounts, keys:renderKeys, reqlogs:renderReqLogs, rtlogs:renderRtLogs, settings:renderSettings };
  var name = (location.hash||"#/overview").replace("#/","");
  var fn = map[name] || renderOverview;
  fn(box);
  CG.refresh();
}
window.CG.render = render;
`;
