/**
 * 面板运行时 · 提示气泡
 *
 * 从原来的面板单文件里拆出来的片段。它只是一段字符串：面板零依赖、零构建，
 * 服务端把片段按 index.ts 里的顺序拼成一个 bundle 再下发给浏览器。
 */
export const TOOLTIP_JS = String.raw`
/* ============ 提示气泡 ============ */
/**
 * 原生 title 的毛病：延迟一两秒才弹、样式完全不受控、触屏上压根没有。
 * 这里自己画一个 —— 全局只有一个节点，靠事件委托接管所有 [data-tip]。
 *
 * 用法：
 *   h("button",{title:"说明"})            自动变成气泡（h 会把 title 转成 data-tip）
 *   CG.tip(el, "说明", {side:"bottom"})   显式挂
 *   data-tip-side = top | bottom | left | right
 */
var tipEl = null;
var tipTimer = null;
var tipCurrent = null;

function tipEnsure(){
  if(tipEl) return tipEl;
  tipEl = h("div",{class:"cg-tip",role:"tooltip"});
  tipEl.style.display = "none";
  document.body.appendChild(tipEl);
  return tipEl;
}
function tipPlace(target){
  var el = tipEnsure();
  var side = target.getAttribute("data-tip-side") || "top";
  var r = target.getBoundingClientRect();
  /* 先摆上去量尺寸，量完再定位，免得闪一下 */
  el.style.visibility = "hidden";
  el.style.display = "";
  var w = el.offsetWidth, hh = el.offsetHeight;
  var gap = 8, top, left;
  if(side === "bottom"){ top = r.bottom + gap; left = r.left + r.width/2 - w/2; }
  else if(side === "left"){ top = r.top + r.height/2 - hh/2; left = r.left - w - gap; }
  else if(side === "right"){ top = r.top + r.height/2 - hh/2; left = r.right + gap; }
  else { top = r.top - hh - gap; left = r.left + r.width/2 - w/2; }
  /* 上面放不下就翻到下面，反之亦然 */
  if(side === "top" && top < 4 && r.bottom + gap + hh < window.innerHeight) top = r.bottom + gap;
  else if(side === "bottom" && top + hh > window.innerHeight - 4 && r.top - gap - hh > 0) top = r.top - hh - gap;
  left = Math.max(6, Math.min(left, window.innerWidth - w - 6));
  top = Math.max(4, Math.min(top, window.innerHeight - hh - 4));
  el.style.left = Math.round(left) + "px";
  el.style.top = Math.round(top) + "px";
  el.style.visibility = "";
}
function tipShow(target){
  var text = target.getAttribute("data-tip");
  if(!text) return;
  var el = tipEnsure();
  el.textContent = text;
  tipCurrent = target;
  tipPlace(target);
}
function tipHide(){
  if(tipTimer){ clearTimeout(tipTimer); tipTimer = null; }
  tipCurrent = null;
  if(tipEl) tipEl.style.display = "none";
}
function tipFrom(target, delay){
  if(tipTimer) clearTimeout(tipTimer);
  tipTimer = setTimeout(function(){ tipShow(target); }, delay === undefined ? 180 : delay);
}
function tipTargetOf(e){
  var t = e.target;
  if(!t || !t.closest) return null;
  return t.closest("[data-tip]");
}
/** 全局委托一次就够 —— 视图随时整页重画，逐个绑监听器必然漏 */
function tipBind(root){
  var host = root || document.body;
  host.addEventListener("mouseover", function(e){
    var t = tipTargetOf(e);
    if(!t || t === tipCurrent) return;
    tipFrom(t);
  });
  host.addEventListener("mouseout", function(e){
    if(tipTargetOf(e)) tipHide();
  });
  host.addEventListener("focusin", function(e){
    var t = tipTargetOf(e);
    if(t) tipFrom(t, 0);
  });
  host.addEventListener("focusout", function(){ tipHide(); });
  /* 点下去、滚起来、窗口一变都收掉，别让它挂半空 */
  host.addEventListener("mousedown", function(){ tipHide(); }, true);
  window.addEventListener("scroll", tipHide, true);
  window.addEventListener("resize", tipHide);
  document.addEventListener("keydown", function(e){ if(e.key === "Escape") tipHide(); });
}
/** 显式给一个元素挂气泡。返回原元素，方便链式 */
function tip(target, text, opts){
  opts = opts || {};
  target.setAttribute("data-tip", String(text));
  if(opts.side) target.setAttribute("data-tip-side", opts.side);
  /* 有原生 title 就撤掉：两个一起弹，一个丑一个晚，纯添乱 */
  if(target.getAttribute("title")) target.removeAttribute("title");
  return target;
}

/* ============ 表格 ============ */
/**
 * columns: [{key,label,sortable,render(row),filter,filterValue,wrap,clamp,width,align}]
 * filter:  {type:"text"} | {type:"select",options:[...]} | {type:"slot",el:元素}
 * opt:     {sortKey,sortDir,striped,emptyText,rowClass,rowId,selectable,batchActions}
 *
 * 筛选只在客户端做，所以只对不分页的表（号池 / API Key）是准的；
 * 分页的日志表用 filter:{type:"slot"} 把控件挂到对应列下面，由调用方转成服务端查询。
 */
`;
