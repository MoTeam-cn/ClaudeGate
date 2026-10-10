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
function isNarrow(){ return window.matchMedia("(max-width:900px)").matches; }
/**
 * 汉堡按钮。桌面端是「折叠/展开侧栏」，移动端是「抽屉」—— 两条完全不同的路。
 *
 * 以前只有抽屉那条，而 .cg-side.is-open 与 .cg-scrim 都只定义在 <=900px 的媒体查询里：
 * 桌面点下去，只是给 aside 加了个没有样式对应的类，再往 body 上挂一个没有定位、
 * 没有背景的 div（一个看不见的 scrim）。表现就是「按钮在那儿，点了没反应」。
 */
function toggleSide(){
  if(isNarrow()){
    if($("#scrim")) closeSide();
    else { openSide(); var sc=h("div",{id:"scrim",class:"cg-scrim",onclick:closeSide}); document.body.appendChild(sc); }
    return;
  }
  var app = $(".cg-app");
  if(!app) return;
  var next = !app.classList.contains("is-collapsed");
  if(next) app.classList.add("is-collapsed"); else app.classList.remove("is-collapsed");
  /* 记一下，刷新后还保持折叠 */
  try { localStorage.setItem("cg_side_collapsed", next ? "1" : "0"); } catch(e){}
}
/** 启动时恢复上次的折叠状态。窄屏不恢复 —— 那边侧栏本来就该藏着 */
function restoreSide(){
  try {
    var app = $(".cg-app");
    if(app && localStorage.getItem("cg_side_collapsed")==="1" && !isNarrow()) app.classList.add("is-collapsed");
  } catch(e){}
}
`;
