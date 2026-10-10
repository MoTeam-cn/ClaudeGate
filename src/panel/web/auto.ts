/**
 * 面板运行时 · 自动刷新
 *
 * 从原来的面板单文件里拆出来的片段。它只是一段字符串：面板零依赖、零构建，
 * 服务端把片段按 index.ts 里的顺序拼成一个 bundle 再下发给浏览器。
 */
export const AUTO_JS = String.raw`
/* ============ 自动刷新 ============ */
var AUTO = localStorage.getItem("cg_auto")!=="0";
function setAuto(on){ AUTO = on; localStorage.setItem("cg_auto", on?"1":"0"); }
function autoTick(){
  if(!AUTO) return;
  if(openDialogs>0) return;
  if(document.hidden) return;
  refresh();
}
`;
