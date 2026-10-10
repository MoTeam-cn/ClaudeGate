/**
 * 面板运行时 · DOM 构建
 *
 * 从原来的面板单文件里拆出来的片段。它只是一段字符串：面板零依赖、零构建，
 * 服务端把片段按 index.ts 里的顺序拼成一个 bundle 再下发给浏览器。
 */
export const DOM_JS = String.raw`
/* ============ 基础工具 ============ */
function $(sel, root){ return (root||document).querySelector(sel); }
function $$(sel, root){ return Array.prototype.slice.call((root||document).querySelectorAll(sel)); }
function esc(s){
  if(s===null||s===undefined) return "";
  return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#39;");
}
/** DOM 构建：h("div",{class:"x"}, [子节点或字符串]) */
function h(tag, attrs, kids){
  var e = document.createElement(tag);
  if(attrs) for(var k in attrs){
    if(!Object.prototype.hasOwnProperty.call(attrs,k)) continue;
    var v = attrs[k];
    if(v===null||v===undefined||v===false) continue;
    if(k==="class") e.className = v;
    else if(k==="text") e.textContent = v;
    else if(k==="html") e.innerHTML = v;
    else if(k.slice(0,2)==="on" && typeof v==="function") e.addEventListener(k.slice(2), v);
    /* title 一律转成 data-tip：原生 title 要等一两秒、样式跟面板两个世界、
       触屏上根本没有。统一走自绘气泡，改样式只用改一处 CSS。
       想保留原生行为就显式用 setAttribute("title", ...) */
    else if(k==="title"){ e.setAttribute("data-tip", String(v)); }
    else if(k==="style" && typeof v==="object") for(var sk in v) e.style[sk]=v[sk];
    else e.setAttribute(k, v===true?"":String(v));
  }
  if(kids!==null&&kids!==undefined){
    if(!Array.isArray(kids)) kids=[kids];
    for(var i=0;i<kids.length;i++){
      var c = kids[i];
      if(c===null||c===undefined||c===false) continue;
      e.appendChild(typeof c==="object"&&c.nodeType ? c : document.createTextNode(String(c)));
    }
  }
  return e;
}
function clear(node){ while(node.firstChild) node.removeChild(node.firstChild); }

/**
 * 替换一块刷新出来的内容。做三件事：
 *
 *   1. **签名一样就一个字节都不动。** 自动刷新每 15 秒跑一次，数据没变还去
 *      重建 DOM，浏览器就得重排重绘整块 —— 用户看到的就是「抽搐」。
 *   2. **要换就整块换。** 新内容先建在离屏节点里，建完一次性搬进去；
 *      在原节点上 clear 再逐个子节点 append，中间会留下可被绘制的空档。
 *   3. **保住滚动位置。** 表格每 15 秒跳回顶部，比闪烁还烦人。
 *
 * build 收到的就是 host 本身（离屏那份），所以各视图的构造代码一个字不用改。
 */
function paint(host, sig, build){
  var key = (sig===null||sig===undefined) ? null
    : (typeof sig==="string" ? sig : JSON.stringify(sig));
  if(key!==null && host.getAttribute("data-paint")===key) return false;

  var scroll = host.scrollTop;
  var before = $$(".el-table-wrap", host).map(function(w){ return w.scrollTop; });

  var next = document.createElement("div");
  build(next);
  clear(host);
  while(next.firstChild) host.appendChild(next.firstChild);
  if(key!==null) host.setAttribute("data-paint", key);

  host.scrollTop = scroll;
  var after = $$(".el-table-wrap", host);
  for(var i=0;i<after.length && i<before.length;i++) after[i].scrollTop = before[i];
  return true;
}

/** 数据没变就别重画。返回 false 表示「和上次一样，跳过这次 DOM 重建」 */
function shouldPaint(host, sig){
  var key = (sig===null||sig===undefined) ? null : (typeof sig==="string" ? sig : JSON.stringify(sig));
  if(key===null) return true;
  if(host.getAttribute("data-paint")===key) return false;
  host.setAttribute("data-paint", key);
  return true;
}

/* 顶部加载条。刻意延迟 150ms 才显示 ——
   本机请求几毫秒就回来了，一闪而过的进度条本身就是一种「抽搐」 */
var busyOn = false, busyTimer = null;
function busy(on){
  var bar = $("#loadingbar");
  if(!bar){
    if(!on) return;
    bar = h("div",{id:"loadingbar",class:"cg-loadingbar"});
    document.body.appendChild(bar);
  }
  busyOn = on;
  if(busyTimer){ clearTimeout(busyTimer); busyTimer = null; }
  if(on){
    busyTimer = setTimeout(function(){
      busyTimer = null;
      if(busyOn) bar.className = "cg-loadingbar is-on";
    }, 150);
  } else {
    bar.className = "cg-loadingbar";
  }
}
`;
