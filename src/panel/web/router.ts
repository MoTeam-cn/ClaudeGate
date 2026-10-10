/**
 * 面板运行时 · 路由与刷新
 *
 * 从原来的面板单文件里拆出来的片段。它只是一段字符串：面板零依赖、零构建，
 * 服务端把片段按 index.ts 里的顺序拼成一个 bundle 再下发给浏览器。
 */
export const ROUTER_JS = String.raw`
/* ============ 路由 ============ */
var ROUTES = ["overview","accounts","keys","reqlogs","rtlogs","settings"];
var TITLES = { overview:["概览","号池与流量总览"], accounts:["号池","订阅与 Console 凭据"],
  keys:["API Key","对外发放的令牌"], reqlogs:["请求日志","每一次上游调用"],
  rtlogs:["运行日志","网关自身的日志"], settings:["设置","策略与保留期"] };
var current = "overview";
var refreshers = [];
var lastData = {};

function syncChrome(name){
  $$("#menu .cg-menu-item").forEach(function(e){
    e.className = "cg-menu-item" + (e.getAttribute("data-route")===name?" active":"");
  });
  var t = TITLES[name] || TITLES.overview;
  var pt = $("#pageTitle"); if(pt) pt.textContent = t[0];
  var ps = $("#pageSub"); if(ps) ps.textContent = t[1];
  document.title = t[0] + " · Claude Gateway";
}
function go(name){
  if(ROUTES.indexOf(name)===-1) name = "overview";
  if(current===name) return;
  current = name;
  /* 改 hash 而不是 replaceState —— 这样浏览器的前进后退也能用 */
  if(location.hash !== "#/"+name) location.hash = "#/"+name;
  syncChrome(name);
  closeSide();
  doRender();
}
function onRefresh(fn){ refreshers.push(fn); }
/** 每次切页要清掉上一页注册的刷新回调，否则会越积越多 */
function clearRefreshers(){ refreshers.length = 0; }
/** render 由 views.ts 晚绑定进来，这里不能直接引用函数名 */
function doRender(){ if(window.CG && window.CG.render) window.CG.render(); }

var refreshing = false;
function refresh(){
  if(refreshing) return;
  refreshing = true;
  var ps = refreshers.map(function(f){ return f(); });
  Promise.all(ps).catch(function(e){ showErr(e); }).then(function(){ refreshing = false; });
}
`;
