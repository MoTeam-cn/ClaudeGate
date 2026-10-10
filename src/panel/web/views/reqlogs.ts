/**
 * 面板视图 · 请求日志
 *
 * 从原来的面板单文件里拆出来的片段。它只是一段字符串：面板零依赖、零构建，
 * 服务端把片段按 index.ts 里的顺序拼成一个 bundle 再下发给浏览器。
 */
export const REQLOGS_JS = String.raw`
/* ============ 请求日志 ============ */
var reqState = { page:1, size:50, outcome:"", protocol:"", search:"", data:null };
function renderReqLogs(box){
  var host = h("div");
  box.appendChild(host);
  var outcome = CG.selectBox([
    { value:"", label:"全部结果" }, { value:"ok", label:"成功" },
    { value:"blocked", label:"被拦截" }, { value:"error", label:"错误" }
  ], { value:reqState.outcome });
  outcome.el.classList.add("cg-filterbar__control");
  var protocol = CG.selectBox([
    { value:"", label:"全部协议" }, { value:"anthropic", label:"anthropic" },
    { value:"openai", label:"openai" }
  ], { value:reqState.protocol });
  protocol.el.classList.add("cg-filterbar__control");
  /* 搜索框比列筛选宽 —— 它是跨列的服务端查询，不是某一列的筛选 */
  var search = h("input",{class:"el-input__inner cg-filterbar__control",placeholder:"req-id / 路径 / 模型 / 账号 / IP"});
  search.style.width = "280px"; search.style.minWidth = "280px";
  search.value = reqState.search;
  function apply(){ reqState.outcome=outcome.value; reqState.protocol=protocol.value; reqState.search=search.value; reqState.page=1; load(); }
  search.addEventListener("keydown", function(e){ if(e.key==="Enter") apply(); });
  outcome.addEventListener("change", apply);
  protocol.addEventListener("change", apply);

  /* 搜索、结果、协议全是服务端筛选，统一交给表格的筛选栏渲染。
     以前这三个控件在表格外面另起一块 .cg-filters，列筛选又是表头下面另一排，
     同一页两套长得不一样的筛选控件。 */
  var listHost = h("div");
  var pageHost = h("div");
  var cardEl = card("请求日志", h("div",{},[listHost, pageHost]));
  host.appendChild(cardEl);

  function load(){
    CG.clear(listHost);
    listHost.appendChild(CG.skeleton(6));
    var q = "limit="+reqState.size+"&offset="+((reqState.page-1)*reqState.size);
    if(reqState.outcome) q += "&outcome="+encodeURIComponent(reqState.outcome);
    if(reqState.protocol) q += "&protocol="+encodeURIComponent(reqState.protocol);
    if(reqState.search) q += "&search="+encodeURIComponent(reqState.search);
    return CG.api("logs.requests?"+q).then(function(d){
      reqState.data = d;
      if(!CG.shouldPaint(listHost, d)) return d;
      CG.clear(listHost);
      var rows = d.rows||[];
      var cols = [
        { key:"ts", label:"时间", sortable:true, render:function(r){
            var b = h("div",{class:"cg-stack",style:{gap:"2px"}});
            b.appendChild(h("div",{text:CG.fmtTime(r.ts)}));
            b.appendChild(h("div",{class:"tiny muted",text:CG.fmtAgo(r.ts)}));
            return b;
          } },
        /* 字段名必须跟 store/logs.ts 的 queryRequests 返回一致：
           id / clientIp / apiKeyName / promptTokens / completionTokens / outcome ——
           之前这里写的是 reqId / ip / keyName / tokensIn / tokensOut / blocked，
           全都对不上，所以整片列都显示 "-" */
        { key:"id", label:"req-id", render:function(r){ return h("span",{class:"mono tiny",text:r.id||"-"}); } },
        { key:"clientIp", label:"来源", render:function(r){ return h("span",{class:"mono tiny",text:r.clientIp||"-"}); } },
        { key:"apiKeyName", label:"Key", render:function(r){ return r.apiKeyName||"-"; } },
        { key:"protocol", label:"协议", sortable:true, width:"88px" },
        { key:"path", label:"路径", render:function(r){
            return h("span",{class:"mono tiny",text:((r.method||"")+" "+(r.path||"")).trim()||"-"});
          } },
        { key:"model", label:"模型", render:function(r){ return h("span",{class:"mono tiny",text:r.model||"-"}); } },
        { key:"accountLabel", label:"账号", render:function(r){ return r.accountLabel||"-"; } },
        { key:"status", label:"状态", sortable:true, width:"96px", render:function(r){
            if(r.outcome==="blocked") return tag(r.blockReason||"拦截","danger");
            /* status 为 null 说明这个请求没到上游（比如 /v1/models 是本地出的） */
            if(r.status===null||r.status===undefined){
              return r.outcome==="ok" ? tag("本地","info") : tag(r.outcome||"未知","warning");
            }
            return tag(String(r.status), r.status>=400?"warning":"success");
          } },
        { key:"durationMs", label:"耗时", sortable:true, align:"right", width:"88px",
          render:function(r){ return h("span",{class:"cg-num",text:CG.fmtDur(r.durationMs)}); } },
        { key:"tokens", label:"token", align:"right", width:"150px", render:function(r){
            return h("span",{class:"tiny cg-num",title:"输入 / 输出 / 缓存读",
              text:CG.fmtNum(r.promptTokens)+" / "+CG.fmtNum(r.completionTokens)+" / "+CG.fmtNum(r.cacheReadTokens)});
          } },
        { key:"note", label:"说明", clamp:true, render:function(r){
            var t = r.errorMessage || r.blockDetail || r.blockReason || "";
            return h("span",{class:"tiny",text:t||"-"});
          } }
      ];
      listHost.appendChild(CG.table(cols, rows, {
        sortKey:"ts", sortDir:"desc", dense:true, emptyText:"没有符合条件的请求",
        toolbar:[
          { label:"搜索", el:search },
          { label:"结果", el:outcome.el },
          { label:"协议", el:protocol.el }
        ],
        toolbarActions:[
          h("button",{class:"el-button el-button--small el-button--primary",text:"查询",onclick:apply}),
          h("button",{class:"el-button el-button--small",text:"重置",onclick:function(){ outcome.value=""; protocol.value=""; search.value=""; apply(); }})
        ],
        rowClass:function(r){ return r.outcome==="blocked" ? "row-danger" : (r.status>=400 ? "row-warn" : ""); }
      }));
      CG.clear(pageHost);
      pageHost.appendChild(CG.pager({ total:d.total||0, page:reqState.page, size:reqState.size, onChange:function(p){ reqState.page=p; load(); } }));
      return d;
    }).catch(function(e){ CG.clear(listHost); listHost.appendChild(CG.emptyState("加载失败："+e.message)); throw e; });
  }
  load();
  CG.onRefresh(load);
}
`;
