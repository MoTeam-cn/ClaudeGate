/**
 * 客户端运行时：DOM 构建、消息提示、对话框、可排序表格、路由、自动刷新。
 *
 * 为什么手写不用框架：面板要维持「零依赖 + 单进程 + 无构建」，引入 Vue/Element Plus
 * 就得加一条前端构建链。这里只抄 Element 的类名与视觉规范，行为自己实现。
 *
 * 注意：这个字符串会被塞进 <script>，所以内部**不能用模板字符串**（反引号与美元花括号），
 * 一律用 + 拼接。
 */
export const CLIENT_JS = String.raw`
(function(){
"use strict";

  /* 注意：改这个文件时不要在 String.replace 的替换串里写两个美元符号，
     它会被折叠成一个 —— 上面那三处 $ 就是这么被弄坏过一次 */
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

function fmtTime(ms){
  if(!ms) return "-";
  var d = new Date(ms);
  function p(n){ return n<10?"0"+n:""+n; }
  return d.getFullYear()+"-"+p(d.getMonth()+1)+"-"+p(d.getDate())+" "+p(d.getHours())+":"+p(d.getMinutes())+":"+p(d.getSeconds());
}
function fmtAgo(ms){
  if(!ms) return "-";
  var s = Math.floor((Date.now()-ms)/1000);
  if(s<0) s=0;
  if(s<60) return s+" 秒前";
  if(s<3600) return Math.floor(s/60)+" 分钟前";
  if(s<86400) return Math.floor(s/3600)+" 小时前";
  return Math.floor(s/86400)+" 天前";
}
function fmtNum(n){
  if(n===null||n===undefined) return "0";
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}
function fmtDur(ms){
  if(ms===null||ms===undefined) return "-";
  if(ms<1000) return ms+" ms";
  if(ms<60000) return (Math.round(ms/100)/10)+" s";
  return Math.floor(ms/60000)+" 分 "+Math.floor((ms%60000)/1000)+" 秒";
}

/* ============ 管理员令牌 ============ */
/* 令牌只存 localStorage，只走 x-admin-token 头。
   不进 URL —— URL 会进浏览器历史、Referer、以及服务端访问日志。 */
var TOKEN = localStorage.getItem("cg_admin") || "";
function setToken(t){ TOKEN = t; localStorage.setItem("cg_admin", t); }
function clearToken(){ TOKEN = ""; localStorage.removeItem("cg_admin"); }
function authHeaders(){
  var hd = {};
  if(TOKEN) hd["x-admin-token"] = TOKEN;
  return hd;
}

/* ============ 接口 ============ */
function api(action, params){
  /* action 可能带查询串（logs.requests?limit=50），它必须留在 URL 上，
     不能整个 encodeURIComponent 进 action 参数，否则后端认不出来 */
  var qi = action.indexOf("?");
  var name = qi === -1 ? action : action.slice(0, qi);
  var extra = qi === -1 ? "" : "&" + action.slice(qi + 1);
  var q = "action=" + encodeURIComponent(name) + extra;
  var body = params ? JSON.stringify(params) : null;
  var hdrs = authHeaders();
  if(body) hdrs["content-type"] = "application/json";
  return fetch("/panel/api?" + q, {
    method: body ? "POST" : "GET",
    headers: hdrs,
    body: body
  }).then(function(r){
    /* 令牌失效或缺失：清掉本地的，重新问，问到了再刷一遍当前页。
       这里不再往下走错误分支，免得同时弹窗又弹 toast */
    if(r.status === 401){
      clearToken();
      askToken("登录密钥无效或已过期，请重新输入").then(function(){ refresh(); });
    }
    return r.text().then(function(t){
      var d = null;
      try { d = JSON.parse(t); } catch(e){}
      if(!r.ok){
        /* 后端的错误是 {error:{message,code}}，直接拼对象会显示 [object Object] */
        var msg = null;
        if(d && d.error){
          msg = (typeof d.error === "string") ? d.error : (d.error.message || d.error.code);
        }
        throw new Error(msg || d && d.message || ("HTTP " + r.status));
      }
      /* 有的接口把结果放在 data 里（overview/accounts/settings…），
         有的直接摊在顶层（logs.requests 的 rows/total），统一在这里抹平 */
      return (d && d.data !== undefined) ? d.data : d;
    });
  });
}

/* ============ 消息提示 ============ */
function toast(msg, type, ms){
  var box = $("#messages");
  if(!box){ box = h("div",{id:"messages",class:"cg-messages"}); document.body.appendChild(box); }
  var icons = { success:"✓", warning:"!", error:"✕", info:"i" };
  var t = type || "info";
  var el = h("div",{class:"el-message el-message--"+t}, [ h("span",{text:icons[t]||"i"}), h("span",{text:String(msg)}) ]);
  box.appendChild(el);
  setTimeout(function(){
    el.className += " is-out";
    setTimeout(function(){ if(el.parentNode) el.parentNode.removeChild(el); }, 220);
  }, ms || (t==="error" ? 6000 : 3000));
}
function showErr(e){ toast(e && e.message ? e.message : String(e), "error"); }

/* ============ 对话框 ============ */
var openDialogs = 0;
function dialog(opt){
  var overlay = h("div",{class:"el-overlay"});
  var dlg = h("div",{class:"el-dialog" + (opt.wide ? " el-dialog--wide" : "")});
  var body = h("div",{class:"el-dialog__body"});
  if(typeof opt.body==="string") body.appendChild(h("div",{html:opt.body}));
  else if(opt.body) body.appendChild(opt.body);

  var okBtn = null;
  function close(){ if(overlay.parentNode){ overlay.parentNode.removeChild(overlay); openDialogs--; } }
  function finish(){ var r = opt.onOk ? opt.onOk() : true; if(r && typeof r.then==="function"){ return r.then(function(v){ if(v!==false) close(); }).catch(function(e){ showErr(e); }); } if(r!==false) close(); }
  if(opt.onOk){
    okBtn = h("button",{class:"el-button el-button--primary",text:opt.okText||"确定",onclick:finish});
  }
  /* noClose：不可关（要令牌时用）。藏掉取消与 ✕，遮罩点击也不关 —— 
     没有令牌就什么都看不到，给个关闭按钮只会让人以为面板坏了 */
  var noClose = !!opt.noClose;
  var foot = h("div",{class:"el-dialog__footer"},[
    (opt.onOk && !noClose) ? h("button",{class:"el-button",text:opt.cancelText||"取消",onclick:close}) : null,
    okBtn,
    (opt.onOk || noClose) ? null : h("button",{class:"el-button el-button--primary",text:"知道了",onclick:close})
  ]);
  dlg.appendChild(h("div",{class:"el-dialog__header"},[
    h("div",{class:"el-dialog__title",text:opt.title||""}),
    noClose ? null : h("button",{class:"el-button el-button--text",text:"✕",onclick:close,style:{fontSize:"14px"}})
  ]));
  dlg.appendChild(body);
  dlg.appendChild(foot);
  overlay.appendChild(dlg);
  overlay.addEventListener("mousedown", function(ev){ if(ev.target===overlay && opt.maskClose!==false && !noClose) close(); });
  document.body.appendChild(overlay);
  openDialogs++;
  var first = $("input,textarea,select", dlg);
  if(first) setTimeout(function(){ first.focus(); }, 30);
  return { close:close, body:body, ok:okBtn };
}
function confirmDialog(msg, title){
  return new Promise(function(resolve){
    dialog({
      title: title || "确认",
      body: h("div",{text:msg}),
      okText:"确定",
      onOk:function(){ resolve(true); }
    });
    /* 取消/关闭都按 false 处理 */
    var t = setTimeout(function(){}, 0); clearTimeout(t);
    resolve.wrap = true;
  });
}
function promptDialog(title, label, value, placeholder){
  return new Promise(function(resolve){
    var input = h("input",{class:"el-input__inner",value:value||"",placeholder:placeholder||""});
    dialog({
      title:title,
      body:h("div",{class:"el-form-item"},[ label?h("div",{class:"el-form-item__label",text:label}):null, input ]),
      okText:"确定",
      onOk:function(){ resolve(input.value); }
    });
  });
}

/* ============ 要令牌 ============ */
/* 不可关闭：没密钥什么都看不到。先用一次真实请求校验，错的密钥不写进 localStorage。
   密钥首次启动时在日志里打印过一次（cgk_ 开头），忘了就在面板「设置」里重置。 */
var askingToken = null;
function askToken(msg){
  if(askingToken) return askingToken;
  askingToken = new Promise(function(resolve){
    var input = h("input",{class:"el-input__inner",type:"password",placeholder:"cgk_...",autocomplete:"off"});
    var err = h("div",{class:"cg-form-err"});
    var box = h("div",{class:"el-form-item"},[
      h("div",{class:"el-form-item__label",text:msg || "请输入面板登录密钥（首次启动时打印在日志里，cgk_ 开头）"}),
      input, err
    ]);
    function submit(){
      var v = input.value.trim();
      if(!v){ err.textContent = "不能为空"; return Promise.resolve(false); }
      err.textContent = "校验中…";
      return fetch("/panel/api?action=overview", { headers:{ "x-admin-token": v } }).then(function(r){
        if(!r.ok){
          err.textContent = r.status === 401 ? "密钥不对" : ("校验失败 HTTP " + r.status);
          return false;
        }
        err.textContent = "";
        setToken(v);
        askingToken = null;
        resolve(v);
        return true;
      }).catch(function(e){
        err.textContent = String(e && e.message || e);
        return false;
      });
    }
    dialog({
      title:"需要登录密钥",
      body:box,
      maskClose:false,
      noClose:true,
      okText:"进入",
      /* 返回 false 让对话框保持打开 */
      onOk:submit
    });
    input.addEventListener("keydown", function(e){
      if(e.key === "Enter"){ e.preventDefault(); submit(); }
    });
  });
  return askingToken;
}

/** 开关：Element 的 el-switch。返回 {el, input}，input 用来读写选中态 */
function switchBox(checked){
  var input = h("input",{type:"checkbox"});
  input.checked = !!checked;
  var el = h("label",{class:"el-switch"},[ input, h("span",{class:"el-switch__core"}) ]);
  return { el:el, input:input };
}

/* ============ 骨架 / 空状态 ============ */
function skeleton(rows){
  var box = h("div",{class:"el-skeleton"});
  box.appendChild(h("div",{class:"el-skeleton__item is-title"}));
  for(var i=0;i<(rows||5);i++) box.appendChild(h("div",{class:"el-skeleton__item"+(i%3===2?" is-short":"")}));
  return box;
}
function emptyState(text){
  return h("div",{class:"el-empty"},[
    h("div",{html:'<svg viewBox="0 0 64 64" fill="none" stroke="currentColor" stroke-width="2"><rect x="10" y="18" width="44" height="30" rx="3"/><path d="M10 28h44M22 18v-6h20v6"/></svg>'}),
    h("div",{class:"el-empty__text",text:text||"暂无数据"})
  ]);
}

/* ============ 就地编辑 ============ */
/** 点一下就变成输入框。Enter 或失焦保存，Esc 取消。 */
function inlineEdit(value, onSave, opt){
  opt = opt || {};
  var span = h("span",{class:"cg-inline",title:opt.title||"点击修改",text:String(value)});
  span.addEventListener("click", function(){
    if(span.__editing) return;
    span.__editing = true;
    var input = h("input",{class:"el-input__inner",value:String(value),placeholder:opt.placeholder||""});
    input.style.height = "24px";
    input.style.fontSize = "var(--el-font-size-extra-small)";
    var wrap = h("span",{class:"cg-inline-edit"},[input]);
    span.parentNode.replaceChild(wrap, span);
    input.focus();
    input.select();
    var done = false;
    function finish(save){
      if(done) return;
      done = true;
      var next = String(input.value).trim();
      if(!save || !next || next === String(value)){
        if(wrap.parentNode) wrap.parentNode.replaceChild(span, wrap);
        span.__editing = false;
        return;
      }
      input.disabled = true;
      Promise.resolve(onSave(next)).then(function(){
        span.textContent = next;
        value = next;
        if(wrap.parentNode) wrap.parentNode.replaceChild(span, wrap);
        span.__editing = false;
      }).catch(function(e){
        showErr(e);
        if(wrap.parentNode) wrap.parentNode.replaceChild(span, wrap);
        span.__editing = false;
      });
    }
    input.addEventListener("keydown", function(e){
      if(e.key === "Enter"){ e.preventDefault(); finish(true); }
      else if(e.key === "Escape"){ e.preventDefault(); finish(false); }
    });
    input.addEventListener("blur", function(){ finish(true); });
  });
  return span;
}

/* ============ 表格 ============ */
/**
 * columns: [{key,label,sortable,render(row),filter,filterValue,wrap,clamp,width}]
 * filter:  {type:"text"} | {type:"select",options:[...]} | {type:"slot",el:元素}
 * opt:     {sortKey,sortDir,striped,emptyText,rowClass,rowId,selectable,batchActions}
 *
 * 筛选只在客户端做，所以只对不分页的表（号池 / API Key）是准的；
 * 分页的日志表用 filter:{type:"slot"} 把控件挂到对应列下面，由调用方转成服务端查询。
 */
/* ============ Element 风格下拉框 ============ */
/**
 * 原生 <select> 的弹出层是操作系统画的，跟面板其它部分完全两个世界 ——
 * 这里自己画一个：触发器跟 el-input 长得一样，弹层是 el-select-dropdown。
 *
 * 弹层挂到 body 上用 fixed 定位，这样表格的 overflow 裁不到它。
 *
 * 用法：
 *   var s = selectBox([{value:"a",label:"A"}], { value:"a", placeholder:"请选择", onChange:fn });
 *   s.el           挂到 DOM 的元素
 *   s.value        读写当前值（赋值不会触发 onChange）
 *   s.disabled     读写禁用态
 */
function selectBox(options, opts){
  opts = opts || {};
  var list = (options || []).slice();
  var cur = opts.value !== undefined ? opts.value : (list.length ? list[0].value : "");
  var disabled = !!opts.disabled;
  var listeners = [];
  var isOpen = false;

  var label = h("span",{class:"cg-select__label"});
  var inner = h("div",{class:"el-input__inner cg-select__inner"},[
    label, h("span",{class:"cg-select__arrow"})
  ]);
  var el = h("div",{class:"el-select cg-select",tabindex:"0",role:"combobox"},[ inner ]);
  var drop = null;

  function optionOf(v){
    for(var i=0;i<list.length;i++){ if(String(list[i].value) === String(v)) return list[i]; }
    return null;
  }
  function renderLabel(){
    var o = optionOf(cur);
    label.textContent = o ? o.label : (opts.placeholder || "");
    label.className = "cg-select__label" + (o ? "" : " is-placeholder");
  }
  function buildDrop(){
    var d = h("div",{class:"el-select-dropdown cg-select__drop"});
    if(!list.length){ d.appendChild(h("div",{class:"cg-select__empty",text:"无选项"})); return d; }
    list.forEach(function(o){
      var item = h("div",{
        class:"el-select-dropdown__item" + (String(o.value) === String(cur) ? " is-selected" : ""),
        text:o.label
      });
      item.addEventListener("click", function(e){
        e.stopPropagation();
        setValue(o.value);
        closeDrop();
      });
      d.appendChild(item);
    });
    return d;
  }
  function onDocDown(e){ if(!el.contains(e.target) && drop && !drop.contains(e.target)) closeDrop(); }
  function openDrop(){
    if(disabled || isOpen) return;
    isOpen = true;
    drop = buildDrop();
    document.body.appendChild(drop);
    var r = el.getBoundingClientRect();
    drop.style.position = "fixed";
    drop.style.left = r.left + "px";
    drop.style.minWidth = r.width + "px";
    var hgt = Math.min(drop.scrollHeight, 264);
    /* 下方放不下且上方更宽裕就往上弹 */
    if(window.innerHeight - r.bottom < hgt + 12 && r.top > window.innerHeight - r.bottom){
      drop.style.top = Math.max(4, r.top - hgt - 4) + "px";
    } else {
      drop.style.top = (r.bottom + 4) + "px";
    }
    el.classList.add("is-open");
    document.addEventListener("mousedown", onDocDown, true);
    window.addEventListener("scroll", closeDrop, true);
    window.addEventListener("resize", closeDrop);
  }
  function closeDrop(){
    if(!isOpen) return;
    isOpen = false;
    el.classList.remove("is-open");
    document.removeEventListener("mousedown", onDocDown, true);
    window.removeEventListener("scroll", closeDrop, true);
    window.removeEventListener("resize", closeDrop);
    if(drop && drop.parentNode) drop.parentNode.removeChild(drop);
    drop = null;
  }
  function fire(){
    listeners.forEach(function(f){ try{ f({ target:api, value:cur }); }catch(e){ /* 回调出错不该影响组件 */ } });
  }
  function setValue(v, silent){
    if(String(v) === String(cur)){ renderLabel(); return; }
    cur = v;
    renderLabel();
    if(isOpen){ var old = drop; drop = buildDrop(); old.parentNode.replaceChild(drop, old); }
    if(!silent) fire();
  }

  inner.addEventListener("click", function(e){
    e.stopPropagation();
    if(isOpen) closeDrop(); else openDrop();
  });
  el.addEventListener("keydown", function(e){
    if(e.key === "Escape"){ closeDrop(); return; }
    if(e.key === "Enter" || e.key === " "){ e.preventDefault(); if(isOpen) closeDrop(); else openDrop(); return; }
    if(e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    if(!isOpen){ openDrop(); return; }
    var idx = -1;
    for(var i=0;i<list.length;i++){ if(String(list[i].value) === String(cur)){ idx = i; break; } }
    var next = e.key === "ArrowDown" ? Math.min(list.length-1, idx+1) : Math.max(0, idx-1);
    if(list[next]){ setValue(list[next].value); }
  });

  var api = {
    el: el,
    set value(v){ setValue(v, true); },
    get value(){ return cur; },
    set disabled(v){ disabled = !!v; el.classList.toggle("is-disabled", disabled); if(disabled) closeDrop(); },
    get disabled(){ return disabled; },
    /** 换一批选项（筛选里的值不变） */
    setOptions: function(next){ list = (next||[]).slice(); renderLabel(); if(isOpen){ var old = drop; drop = buildDrop(); old.parentNode.replaceChild(drop, old); } },
    addEventListener: function(type, fn){ if(type === "change") listeners.push(fn); },
    focus: function(){ el.focus(); }
  };
  renderLabel();
  return api;
}

function table(columns, rows, opt){
  opt = opt || {};
  var state = { key:opt.sortKey||null, dir:opt.sortDir||"desc" };
  var filters = {};
  var selected = {};
  var idOf = opt.rowId || function(r){ return r.id; };

  function colOf(key){
    for(var i=0;i<columns.length;i++) if(columns[i].key===key) return columns[i];
    return null;
  }
  function filterRows(list){
    var keys = Object.keys(filters);
    if(!keys.length) return list;
    return list.filter(function(r){
      for(var i=0;i<keys.length;i++){
        var want = filters[keys[i]];
        if(!want) continue;
        var col = colOf(keys[i]);
        var get = (col && col.filterValue) || function(x){ return x[keys[i]]; };
        var v = get(r);
        v = (v===null||v===undefined) ? "" : String(v);
        if(col && col.filter && col.filter.type === "select"){
          if(v !== want) return false;
        } else if(v.toLowerCase().indexOf(String(want).toLowerCase()) === -1){
          return false;
        }
      }
      return true;
    });
  }
  function sortRows(list){
    if(!state.key) return list;
    var col = colOf(state.key);
    if(!col) return list;
    var get = col.sortValue || function(r){ return r[col.key]; };
    var copy = list.slice();
    copy.sort(function(a,b){
      var x = get(a), y = get(b);
      if(x===null||x===undefined) x = "";
      if(y===null||y===undefined) y = "";
      var n = (typeof x==="number" && typeof y==="number") ? x-y : String(x).localeCompare(String(y));
      return state.dir === "asc" ? n : -n;
    });
    return copy;
  }
  function selectedIds(){ return Object.keys(selected).filter(function(k){ return selected[k]; }); }

  var wrap = h("div",{class:"el-table-wrap"});
  /* 想给某张表单独定高就传 opt.maxHeight，比如 opt.maxHeight = "40vh" */
  if(opt.maxHeight) wrap.style.maxHeight = opt.maxHeight;
  var bar = h("div",{class:"cg-batchbar hidden"});
  var tbl = h("table",{class:"el-table"+(opt.striped===false?"":" el-table--striped")});

  function paint(){
    clear(tbl);
    var thead = h("thead");
    var trh = h("tr");
    var trf = h("tr",{class:"cg-filterrow"});
    var hasFilter = false;

    if(opt.selectable){
      var th0 = h("th",{class:"cg-col-check"});
      var all = filterRows(rows);
      var allOn = all.length > 0 && all.every(function(r){ return selected[idOf(r)]; });
      var master = h("input",{type:"checkbox"});
      master.checked = allOn;
      master.addEventListener("change", function(){
        all.forEach(function(r){ if(master.checked) selected[idOf(r)] = true; else delete selected[idOf(r)]; });
        paint();
      });
      th0.appendChild(master);
      trh.appendChild(th0);
      trf.appendChild(h("td"));
      hasFilter = true;
    }

    columns.forEach(function(c){
      var th = h("th",{class:(c.sortable?"is-sortable":"") + (state.key===c.key?" is-sorted":"")});
      th.appendChild(h("span",{text:c.label}));
      if(c.sortable){
        th.appendChild(h("span",{class:"caret",text: state.key===c.key ? (state.dir==="asc"?"▲":"▼") : "⇅"}));
        th.addEventListener("click", function(){
          if(state.key === c.key) state.dir = state.dir === "asc" ? "desc" : "asc";
          else { state.key = c.key; state.dir = "desc"; }
          paint();
        });
      }
      if(c.width) th.style.width = c.width;
      trh.appendChild(th);

      /* 每一列都要补一个 td，哪怕没有筛选控件——否则筛选行会整体错位 */
      var td = h("td");
      if(c.filter){
        hasFilter = true;
        if(c.filter.type === "slot"){
          td.appendChild(c.filter.el);
        } else if(c.filter.type === "select"){
          var opts = [{ value:"", label:c.filter.placeholder||"全部" }].concat(c.filter.options||[]);
          var sel = selectBox(opts, { value:filters[c.key] || "" });
          sel.el.classList.add("cg-colfilter");
          sel.addEventListener("change", function(){ filters[c.key] = sel.value; paint(); });
          td.appendChild(sel.el);
        } else {
          var inp = h("input",{class:"el-input__inner cg-colfilter",placeholder:c.filter.placeholder||"筛选"});
          inp.value = filters[c.key] || "";
          inp.addEventListener("input", function(){ filters[c.key] = inp.value; repaintRows(); });
          td.appendChild(inp);
        }
      }
      trf.appendChild(td);
    });

    thead.appendChild(trh);
    if(hasFilter) thead.appendChild(trf);
    tbl.appendChild(thead);
    tbl.appendChild(body());
    paintBar();
  }

  /* 只重画 tbody，输入框不丢焦点 */
  function repaintRows(){
    var old = tbl.querySelector("tbody");
    if(old) tbl.replaceChild(body(), old);
    paintBar();
  }

  function body(){
    var tbody = h("tbody");
    var list = sortRows(filterRows(rows));
    if(list.length === 0){
      var td = h("td",{class:"el-table__empty",colspan:String(columns.length + (opt.selectable?1:0))});
      td.appendChild(emptyState(rows.length ? "没有符合筛选的行" : (opt.emptyText||"暂无数据")));
      var tre = h("tr"); tre.appendChild(td); tbody.appendChild(tre);
      return tbody;
    }
    list.forEach(function(row){
      var tr = h("tr");
      if(opt.rowClass){ var rc = opt.rowClass(row); if(rc) tr.className = rc; }
      var rid = idOf(row);
      if(opt.selectable){
        var tdc = h("td",{class:"cg-col-check"});
        var cb = h("input",{type:"checkbox"});
        cb.checked = !!selected[rid];
        cb.addEventListener("change", function(){
          if(cb.checked) selected[rid] = true; else delete selected[rid];
          tr.className = (opt.rowClass ? (opt.rowClass(row)||"") : "") + (cb.checked ? " is-selected" : "");
          paintBar();
          var head = tbl.querySelector("thead input[type=checkbox]");
          if(head){ var vis = filterRows(rows); head.checked = vis.length>0 && vis.every(function(r){ return selected[idOf(r)]; }); }
        });
        tdc.appendChild(cb);
        tr.appendChild(tdc);
      }
      columns.forEach(function(c){
        var td2 = h("td");
        var cell = h("div",{class:"cell" + (c.wrap?" wrap":"") + (c.clamp?" clamp":"")});
        var v = c.render ? c.render(row) : row[c.key];
        if(v && v.nodeType) cell.appendChild(v);
        else cell.textContent = (v===null||v===undefined||v==="") ? "-" : String(v);
        td2.appendChild(cell);
        if(c.title) td2.title = c.title(row);
        tr.appendChild(td2);
      });
      tbody.appendChild(tr);
    });
    return tbody;
  }

  function paintBar(){
    if(!opt.selectable || !opt.batchActions) return;
    var ids = selectedIds();
    clear(bar);
    if(!ids.length){ bar.className = "cg-batchbar hidden"; return; }
    bar.className = "cg-batchbar";
    bar.appendChild(h("span",{class:"cg-batchbar__n",text:"已选 " + ids.length + " 项"}));
    opt.batchActions.forEach(function(b){
      bar.appendChild(h("button",{
        class:"el-button el-button--small" + (b.type ? " el-button--" + b.type : ""),
        text:b.label,
        onclick:function(){
          Promise.resolve(b.run(ids)).then(function(){
            if(b.keep!==true) selected = {};
            paint();
          }).catch(showErr);
        }
      }));
    });
    bar.appendChild(h("button",{class:"el-button el-button--small el-button--text",text:"取消选择",onclick:function(){ selected = {}; paint(); }}));
  }

  paint();
  wrap.appendChild(tbl);
  var host = h("div");
  host.appendChild(bar);
  host.appendChild(wrap);
  host.repaint = paint;
  host.selectedIds = selectedIds;
  return host;
}

/* ============ 分页 ============ */
function pager(opt){
  var box = h("div",{class:"el-pagination"});
  var total = opt.total||0, page = opt.page||1, size = opt.size||50;
  var pages = Math.max(1, Math.ceil(total/size));
  box.appendChild(h("span",{class:"total",text:"共 "+fmtNum(total)+" 条 · 第 "+page+" / "+pages+" 页"}));
  function btn(label, target, disabled){
    return h("button",{class:"el-button"+ (disabled?" is-disabled":""),text:label,onclick:function(){ if(!disabled) opt.onChange(target); }});
  }
  box.appendChild(btn("上一页", page-1, page<=1));
  var from = Math.max(1, page-2), to = Math.min(pages, from+4);
  for(var i=from;i<=to;i++){
    (function(n){
      box.appendChild(h("span",{class:"pager-num"+(n===page?" active":""),text:String(n),onclick:function(){ opt.onChange(n); }}));
    })(i);
  }
  box.appendChild(btn("下一页", page+1, page>=pages));
  return box;
}

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

/* ============ 自动刷新 ============ */
var AUTO = localStorage.getItem("cg_auto")!=="0";
function setAuto(on){ AUTO = on; localStorage.setItem("cg_auto", on?"1":"0"); }
function autoTick(){
  if(!AUTO) return;
  if(openDialogs>0) return;
  if(document.hidden) return;
  refresh();
}

/* ============ 导出给各视图用 ============ */
window.CG = {
  api:api, toast:toast, showErr:showErr, dialog:dialog, confirmDialog:confirmDialog, promptDialog:promptDialog,
  h:h, $:$, $$:$$, esc:esc, clear:clear, skeleton:skeleton, emptyState:emptyState, table:table, pager:pager,
  go:go, onRefresh:onRefresh, refresh:refresh, fmtTime:fmtTime, fmtAgo:fmtAgo, fmtNum:fmtNum, fmtDur:fmtDur,
  lastData:lastData, getToken:function(){ return TOKEN; },
  setToken:setToken, clearToken:clearToken, askToken:askToken
};
window.CG.switchBox = switchBox;
window.CG.selectBox = selectBox;
window.CG.inlineEdit = inlineEdit;
window.CG.switchBox = switchBox;
window.CG.clearRefreshers = clearRefreshers;
window.CG.toggleTheme = toggleTheme;
window.CG.toggleSide = toggleSide;
window.CG.setAuto = setAuto;
window.CG.isAuto = function(){ return AUTO; };

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
})();
`;
