/**
 * 面板运行时 · 「更多」下拉
 *
 * 从原来的面板单文件里拆出来的片段。它只是一段字符串：面板零依赖、零构建，
 * 服务端把片段按 index.ts 里的顺序拼成一个 bundle 再下发给浏览器。
 */
export const MENU_JS = String.raw`
/* ============ 「更多」下拉 ============ */
/**
 * 一排按钮塞不下时的收纳。
 *
 * 号池那一行原先并排六个按钮，列宽怎么调都会折成两行 —— 长标签、短标签都试过了。
 * 现在低频且危险的操作收进这里，主行只留两个常用的。
 *
 * items: [{label,title,danger,divider,run}]
 */
function moreMenu(items, opt){
  opt = opt || {};
  var root = h("div",{class:"cg-more"});
  var btn = h("button",{class:"el-button el-button--small cg-more__btn",type:"button",title:opt.title||"更多操作"});
  btn.appendChild(h("span",{class:"cg-more__dots",text:"\u22ef"}));
  root.appendChild(btn);
  var drop = null, open = false;

  function close(){
    if(!open) return;
    open = false;
    root.classList.remove("is-open");
    document.removeEventListener("mousedown", onDoc, true);
    window.removeEventListener("scroll", close, true);
    window.removeEventListener("resize", close);
    if(drop && drop.parentNode) drop.parentNode.removeChild(drop);
    drop = null;
  }
  function onDoc(e){ if(!root.contains(e.target) && drop && !drop.contains(e.target)) close(); }
  function openDrop(){
    if(open) return;
    open = true;
    drop = h("div",{class:"el-dropdown-menu cg-more__drop"});
    (items||[]).forEach(function(it){
      if(it.divider){ drop.appendChild(h("div",{class:"cg-more__sep"})); return; }
      var row = h("div",{class:"el-dropdown-menu__item"+(it.danger?" is-danger":""),text:it.label});
      if(it.title) row.title = it.title;
      row.addEventListener("click", function(e){
        e.stopPropagation();
        close();
        try { Promise.resolve(it.run()).catch(showErr); } catch(err){ showErr(err); }
      });
      drop.appendChild(row);
    });
    document.body.appendChild(drop);
    var r = btn.getBoundingClientRect();
    drop.style.position = "fixed";
    drop.style.minWidth = Math.max(140, r.width) + "px";
    var w = drop.offsetWidth, hh = drop.offsetHeight;
    drop.style.left = Math.max(8, Math.min(r.left, window.innerWidth - w - 8)) + "px";
    drop.style.top = (window.innerHeight - r.bottom < hh + 8 && r.top > hh + 8)
      ? Math.max(8, r.top - hh - 4) + "px"
      : (r.bottom + 4) + "px";
    root.classList.add("is-open");
    document.addEventListener("mousedown", onDoc, true);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
  }
  btn.addEventListener("click", function(e){ e.stopPropagation(); if(open) close(); else openDrop(); });
  return root;
}
`;
