/**
 * 面板运行时 · 启动
 *
 * 从原来的面板单文件里拆出来的片段。它只是一段字符串：面板零依赖、零构建，
 * 服务端把片段按 index.ts 里的顺序拼成一个 bundle 再下发给浏览器。
 */
export const BOOT_JS = String.raw`
/* ============ 启动 ============ */
document.addEventListener("DOMContentLoaded", function(){
  applyTheme(localStorage.getItem("cg_theme") || "dark");
  var init = (location.hash||"").replace("#/","");
  current = ROUTES.indexOf(init)===-1 ? "overview" : init;
  $$("#menu .cg-menu-item").forEach(function(e){
    e.addEventListener("click", function(){ go(e.getAttribute("data-route")); });
  });
  syncChrome(current);
  /* 侧栏图标：外壳里先放占位字符，这里换成 SVG，避免外壳与图标表两处维护 */
  $$("#menu .cg-menu-item").forEach(function(e){
    var ico = e.querySelector(".ico");
    if(ico && window.CG.iconInner) ico.innerHTML = window.CG.iconInner(e.getAttribute("data-route"));
  });
  /* 没有这个的话，手改地址栏或点浏览器后退都不会切页 */
  window.addEventListener("hashchange", function(){
    var name = (location.hash||"").replace("#/","");
    if(ROUTES.indexOf(name)===-1) name = "overview";
    if(name === current) return;
    current = name;
    syncChrome(name);
    closeSide();
    doRender();
  });
  /* 提示气泡只绑一次，靠事件委托吃下整页的 [data-tip] */
  tipBind(document.body);
  var b = $("#burger"); if(b) b.addEventListener("click", toggleSide);
  var t = $("#theme"); if(t) t.addEventListener("click", toggleTheme);
  var r = $("#reload"); if(r) r.addEventListener("click", function(){ refresh(); });
  var a = $("#auto"); if(a){ a.checked = AUTO; a.addEventListener("change", function(){ setAuto(a.checked); }); }
  var started = false;
  function start(){
    if(started) return;
    started = true;
    doRender();
    setInterval(autoTick, 15000);
    setInterval(function(){ $$("[data-ago]").forEach(function(e){ e.textContent = fmtAgo(Number(e.getAttribute("data-ago"))); }); }, 10000);
  }
  /* 没令牌就先问，问到再渲染。没有阻塞式的 prompt，弹窗自己会校验 */
  if(TOKEN) start();
  else askToken().then(start);
});
`;
