/**
 * 面板视图 · 运行日志
 *
 * 从原来的面板单文件里拆出来的片段。它只是一段字符串：面板零依赖、零构建，
 * 服务端把片段按 index.ts 里的顺序拼成一个 bundle 再下发给浏览器。
 */
export const RTLOGS_JS = String.raw`
/* ============ 运行日志 ============ */
var rtState = { page:1, size:100, level:"", search:"" };
function renderRtLogs(box){
  var host = h("div");
  box.appendChild(host);
  var level = CG.selectBox([
    { value:"", label:"全部级别" }, { value:"debug", label:"debug" },
    { value:"info", label:"info" }, { value:"warn", label:"warn" }, { value:"error", label:"error" }
  ], { value:rtState.level });
  level.el.classList.add("cg-filterbar__control");
  var search = h("input",{class:"el-input__inner cg-filterbar__control",placeholder:"搜索日志内容"});
  search.style.width = "280px"; search.style.minWidth = "280px";
  search.value = rtState.search;
  function apply(){ rtState.level=level.value; rtState.search=search.value; rtState.page=1; load(); }
  search.addEventListener("keydown", function(e){ if(e.key==="Enter") apply(); });
  level.addEventListener("change", apply);

  function prune(){
    CG.dialog({ title:"清空运行日志", okText:"清空",
      body:h("div",{text:"会按保留策略删除旧日志，确定继续？"}),
      onOk:function(){ return CG.api("logs.prune",{}).then(function(r){ CG.toast("已按保留 "+(r.days||"?")+" 天清理，运行日志上限 "+(r.maxRows||"?"),"success"); load(); }); } });
  }

  var listHost = h("div");
  var pageHost = h("div");
  host.appendChild(card("运行日志", h("div",{},[listHost, pageHost])));

  function load(){
    CG.clear(listHost);
    listHost.appendChild(CG.skeleton(8));
    var q = "limit="+rtState.size+"&offset="+((rtState.page-1)*rtState.size);
    if(rtState.level) q += "&level="+encodeURIComponent(rtState.level);
    if(rtState.search) q += "&search="+encodeURIComponent(rtState.search);
    return CG.api("logs.runtime?"+q).then(function(d){
      CG.clear(listHost);
      var cols = [
        { key:"ts", label:"时间", sortable:true, render:function(r){ return CG.fmtTime(r.ts); } },
        { key:"level", label:"级别", sortable:true, width:"88px", render:function(r){
            var t = r.level==="error"?"danger":(r.level==="warn"?"warning":(r.level==="debug"?"info":"success"));
            return tag(r.level,t);
          } },
        { key:"scope", label:"来源", render:function(r){ return h("span",{class:"mono tiny",text:r.scope||"-"}); } },
        { key:"message", label:"内容", clamp:true, render:function(r){ return h("span",{class:"tiny",text:r.message||""}); } }
      ];
      listHost.appendChild(CG.table(cols, d.rows||[], {
        sortKey:"ts", sortDir:"desc", dense:true, emptyText:"暂无日志",
        toolbar:[ { label:"搜索", el:search }, { label:"级别", el:level.el } ],
        toolbarActions:[
          h("button",{class:"el-button el-button--small el-button--primary",text:"查询",onclick:apply}),
          h("button",{class:"el-button el-button--small",text:"清空历史",onclick:prune})
        ]
      }));
      CG.clear(pageHost);
      pageHost.appendChild(CG.pager({ total:d.total||0, page:rtState.page, size:rtState.size, onChange:function(p){ rtState.page=p; load(); } }));
      return d;
    }).catch(function(e){ CG.clear(listHost); listHost.appendChild(CG.emptyState("加载失败："+e.message)); throw e; });
  }
  load();
  CG.onRefresh(load);
}
`;
