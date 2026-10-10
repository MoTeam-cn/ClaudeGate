/**
 * 面板运行时 · 主题与侧栏
 *
 * 从原来的面板单文件里拆出来的片段。它只是一段字符串：面板零依赖、零构建，
 * 服务端把片段按 index.ts 里的顺序拼成一个 bundle 再下发给浏览器。
 */
export const CHROME_JS = String.raw`
/* ============ 主题 / 侧栏 ============ */
function applyTheme(t){
  document.documentElement.setAttribute("data-theme", t);
  localStorage.setItem("cg_theme", t);
}
function toggleTheme(){
  applyTheme(document.documentElement.getAttribute("data-theme")==="dark" ? "light" : "dark");
}
function openSide(){ var s=$("#side"); if(s) s.className="cg-side is-open"; var sc=$("#scrim"); if(sc) sc.className="cg-scrim"; }
function closeSide(){ var s=$("#side"); if(s) s.className="cg-side"; var sc=$("#scrim"); if(sc&&sc.parentNode) sc.parentNode.removeChild(sc); }
function toggleSide(){ if($("#scrim")) closeSide(); else { openSide(); var sc=h("div",{id:"scrim",class:"cg-scrim",onclick:closeSide}); document.body.appendChild(sc); } }
`;
