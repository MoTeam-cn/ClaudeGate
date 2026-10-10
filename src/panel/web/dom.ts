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
`;
