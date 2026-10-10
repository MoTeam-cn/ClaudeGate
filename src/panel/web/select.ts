/**
 * 面板运行时 · 自绘下拉框
 *
 * 从原来的面板单文件里拆出来的片段。它只是一段字符串：面板零依赖、零构建，
 * 服务端把片段按 index.ts 里的顺序拼成一个 bundle 再下发给浏览器。
 */
export const SELECT_JS = String.raw`
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
`;
