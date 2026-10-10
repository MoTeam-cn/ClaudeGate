/**
 * 面板视图 · 概览
 *
 * 从原来的面板单文件里拆出来的片段。它只是一段字符串：面板零依赖、零构建，
 * 服务端把片段按 index.ts 里的顺序拼成一个 bundle 再下发给浏览器。
 */
export const OVERVIEW_JS = String.raw`
/* ============ 概览 ============ */
function renderOverview(box){
  box.appendChild(h("div",{class:"el-skeleton"}));
  var host = h("div");
  box.appendChild(host);
  CG.onRefresh(function(){
    return CG.api("overview").then(function(d){
      CG.paint(host, d, function(host){
      var p = d.pool;
      var grid = h("div",{class:"cg-stats"});
      grid.appendChild(stat("号池总数", CG.fmtNum(p.total)));
      grid.appendChild(stat("可用账号", CG.fmtNum(p.active), p.active>0?"ok":"bad"));
      grid.appendChild(stat("冷却中", CG.fmtNum(p.cooling), p.cooling>0?"warn":""));
      grid.appendChild(stat("额度耗尽", CG.fmtNum(p.exhausted), p.exhausted>0?"bad":""));
      grid.appendChild(stat("已停用", CG.fmtNum(p.disabled), p.disabled>0?"warn":""));
      grid.appendChild(stat("出错账号", CG.fmtNum(p.errored), p.errored>0?"bad":""));
      grid.appendChild(stat("会话粘性", CG.fmtNum(p.sticky)));
      grid.appendChild(stat("API Key", CG.fmtNum(d.keys)));
      grid.appendChild(stat("今日请求", CG.fmtNum(d.today.requests)));
      grid.appendChild(stat("今日 token", CG.fmtNum(d.today.tokens)));
      host.appendChild(card("运行状态", grid));

      var g2 = h("div",{class:"cg-stats"});
      g2.appendChild(stat("总请求", CG.fmtNum(d.stats.totalRequests)));
      g2.appendChild(stat("被拦截", CG.fmtNum(d.stats.blocked), d.stats.blocked>0?"warn":""));
      g2.appendChild(stat("错误", CG.fmtNum(d.stats.errors), d.stats.errors>0?"bad":""));
      g2.appendChild(stat("近 24 小时", CG.fmtNum(d.stats.last24h)));
      g2.appendChild(stat("运行日志", CG.fmtNum(d.stats.runtimeEntries)));
      host.appendChild(card("累计统计", g2));

      var desc = h("div",{class:"el-descriptions"});
      function row(k,v,mono){
        desc.appendChild(h("div",{class:"el-descriptions__cell"},[
          h("div",{class:"el-descriptions__label",text:k}),
          h("div",{class:"el-descriptions__value"+(mono?" mono":""),text:v})
        ]));
      }
      row("出口地址", d.publicUrl||"(未设置 PUBLIC_URL)", true);
      row("上游", d.upstreamBase, true);
      row("请求头守卫", d.guardMode + (d.injectMissing?"（注入缺失头）":""));
      row("隐写拦截", d.stegoMode);
      row("请求 ID 回传", d.reqIdInResponse);
      row("凭据构成", "OAuth "+p.oauth+" / Console Key "+p.apikey);
      host.appendChild(card("策略", desc));

      if(p.exhaustedList && p.exhaustedList.length){
        host.appendChild(card("额度耗尽的账号", accountListTable(p.exhaustedList, "exhausted")));
      }
      if(p.coolingList && p.coolingList.length){
        host.appendChild(card("冷却中的账号", accountListTable(p.coolingList, "cooling")));
      }
      return d;
    });
    });
  });
}
function accountListTable(list, mode){
  var cols = [
    { key:"label", label:"账号", sortable:true },
    { key:"reason", label:"原因", wrap:true, render:function(r){ return h("span",{class:"tiny",text:r.reason||"-"}); } },
    { key:"until", label: mode==="exhausted"?"预计恢复":"恢复时间", sortable:true,
      render:function(r){ return r.until ? h("span",{title:CG.fmtTimeTz(r.until*1000),text:CG.fmtTime(r.until*1000)}) : h("span",{class:"muted",text:"待上游恢复"}); } },
    { key:"act", label:"操作", render:function(r){
        var box = h("div",{class:"cg-actions"});
        box.appendChild(h("button",{class:"el-button el-button--small",text:"立即恢复",onclick:function(){ actRevive(r.id); }}));
        if(mode==="exhausted") box.appendChild(h("button",{class:"el-button el-button--small",text:"查用量",onclick:function(){ actFetchUsage(r.id); }}));
        return box;
      } }
  ];
  return CG.table(cols, list, { emptyText:"没有" });
}
`;
