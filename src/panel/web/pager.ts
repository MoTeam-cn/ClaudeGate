/**
 * 面板运行时 · 分页
 *
 * 从原来的面板单文件里拆出来的片段。它只是一段字符串：面板零依赖、零构建，
 * 服务端把片段按 index.ts 里的顺序拼成一个 bundle 再下发给浏览器。
 */
export const PAGER_JS = String.raw`
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
`;
