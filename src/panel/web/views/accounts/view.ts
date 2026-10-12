/** 号池 · 列表渲染与状态文案 */
export const ACCOUNTS_VIEW_JS = String.raw`
/* ============ 号池 ============ */
function renderAccounts(box){
  var host = h("div");
  box.appendChild(host);
  var actions = [
    h("button",{class:"el-button el-button--primary",text:"添加账号",onclick:openAddAccount}),
    h("button",{class:"el-button",text:"批量导入",onclick:openBatchImport}),
    h("button",{class:"el-button",text:"全部查用量",onclick:actFetchUsageAll})
  ];
  /* 状态筛选用文本值，和状态标签一一对应 */
  function statusKey(a){
    if(a.status==="exhausted") return "额度耗尽";
    if(a.status==="error") return "出错";
    if(a.status==="disabled") return "已停用";
    if(a.cooldownUntil && a.cooldownUntil*1000>Date.now()) return "冷却中";
    return "可用";
  }
  CG.onRefresh(function(){
    return CG.api("accounts").then(function(list){
      /* 数据没变就整块跳过。自动刷新每 15 秒一次，重建一遍表格会丢滚动位置、
         关掉正在展开的下拉，看起来就是「抽搐」 */
      if(!CG.shouldPaint(host, list)) return list;
      CG.clear(host);
      /*
       * 列布局的原则：
       *   · 一行里的信息分主次（.cg-cell__main / __sub），不再用内联 style 拼小字
       *   · 数字列右对齐（align:"right"），位数对齐才好扫
       *   · 操作列只留两个常用按钮，其余进「⋯」菜单 —— 六个按钮并排必然折行
       */
      var cols = [
        { key:"label", label:"账号", sortable:true,
          filter:{type:"text",placeholder:"搜账号 / 邮箱"},
          filterValue:function(a){ return a.label + " " + (a.email||"") + " " + a.kind; },
          render:function(a){
            var cell = h("div",{class:"cg-cell"});
            /* 就地改名：点一下变输入框，Enter 或失焦保存 */
            cell.appendChild(h("div",{class:"cg-cell__main"},[
              CG.inlineEdit(a.label, function(next){ return actRenameAccount(a.id, next); }, {title:"点击改备注名"})
            ]));
            cell.appendChild(h("div",{class:"cg-cell__sub",text:(a.kind==="oauth"?"订阅 OAuth":"Console Key")+(a.email?" · "+a.email:"")}));
            if(a.lastError) cell.appendChild(h("div",{class:"cg-cell__bad",title:a.lastError,text:a.lastError.slice(0,60)}));
            return cell;
          } },
        { key:"status", label:"状态", sortable:true,
          filter:{type:"select",placeholder:"全部",options:["可用","冷却中","额度耗尽","已停用","出错"].map(function(s){ return {value:s,label:s}; })},
          filterValue:statusKey,
          render:function(a){
            var cell = h("div",{class:"cg-cell"});
            cell.appendChild(statusTag(a));
            var sub = [];
            if(a.exhaustedUntil) sub.push("恢复 "+CG.fmtTime(a.exhaustedUntil*1000));
            if(a.cooldownUntil && a.cooldownUntil*1000>Date.now()) sub.push("冷却至 "+CG.fmtTime(a.cooldownUntil*1000));
            if(sub.length) cell.appendChild(h("div",{class:"cg-cell__sub",text:sub.join(" · ")}));
            return cell;
          } },
        { key:"usage", label:"用量", width:"236px", render:function(a){ return usageCell(a); } },
        { key:"requestCount", label:"请求", sortable:true, align:"right", width:"76px",
          render:function(a){
            return h("span",{class:"cg-num",title:"这个号被用过多少次。每次向上游发请求都算，失败也算",
              text:CG.fmtNum(a.requestCount)});
          } },
        /* 错误数是**连续**的，不是累计：下一次成功就清零（scheduler 的 reportSuccess）。
           所以健康账号这里是 0 是正常的，不是没统计。标题里写明白，免得误读 */
        { key:"errorCount", label:"错误", sortable:true, align:"right", width:"68px",
          render:function(a){
            var n = a.errorCount || 0;
            return h("span",{class:"cg-num",title:"连续错误次数。下一次成功就清零，所以健康账号这里是 0",
              style:n?{color:"var(--el-color-danger)"}:null,text:CG.fmtNum(n)});
          } },
        { key:"deviceId", label:"设备指纹", filter:{type:"text",placeholder:"搜指纹"},
          filterValue:function(a){ return a.deviceId || ""; },
          render:function(a){
            if(!a.deviceId) return h("span",{class:"muted tiny",text:"待生成"});
            return h("span",{class:"cg-mono-chip",title:a.deviceId+"（点击复制）",text:a.deviceId.slice(0,10)+"…",
              onclick:function(){
                var ok = copyText(a.deviceId);
                CG.toast(ok ? "指纹已复制" : "复制失败，请手动选中复制", ok ? "success" : "warning");
              }});
          } },
        { key:"act", label:"操作", align:"right", width:"152px", render:function(a){
            var box2 = h("div",{class:"cg-actions"});
            box2.appendChild(h("button",{class:"el-button el-button--small",title:"立刻查询这个号的额度",text:"用量",onclick:function(){ actFetchUsage(a.id); }}));
            box2.appendChild(h("button",{class:"el-button el-button--small",title:"重新读取这个号的订阅信息（真名 / 邮箱 / 套餐）",text:"刷新",onclick:function(){ actRefreshAccount(a.id); }}));
            box2.appendChild(CG.moreMenu([
              { label:"恢复额度状态", title:"把这个号从耗尽 / 出错状态恢复", run:function(){ return actRevive(a.id); } },
              { label:a.status==="disabled"?"启用":"停用", title:a.status==="disabled"?"重新启用这个号":"暂时停用这个号", run:function(){ return actSetStatus(a); } },
              { divider:true },
              { label:"重置计数与冷却", title:"清掉错误计数与冷却，额度状态重新统计", run:function(){ return actReset(a.id); } },
              { label:"删除账号", danger:true, title:"从号池里删掉这个号", run:function(){ return actDeleteAccount(a); } }
            ], {title:"更多操作"}));
            return box2;
          } }
      ];
      host.appendChild(card("号池（"+list.length+" 个）", CG.table(cols, list, {
        emptyText:"号池是空的，先添加一个账号",
        selectable:true,
        rowId:function(a){ return a.id; },
        batchActions:[
          { label:"全部刷新信息", run:function(){ return actRefreshAll(); } },
          { label:"批量启用", run:function(ids){ return actBatchStatus(ids, "active"); } },
          { label:"批量停用", run:function(ids){ return actBatchStatus(ids, "disabled"); } },
          { label:"批量查用量", run:function(ids){ return actBatchUsage(ids); } },
          { label:"批量删除", type:"danger", run:function(ids){ return actBatchDeleteAccounts(ids); } }
        ]
      }), actions));
      return list;
    });
  });
}
function actRenameAccount(id, label){
  return CG.api("account.update",{ id:id, label:label });
}
/** 后端只有单条更新，批量在前端循环——号池规模是几十个，够用 */
function actBatchStatus(ids, status){
  var label = status==="disabled" ? "停用" : "启用";
  return ids.reduce(function(chain, id){
    return chain.then(function(){ return CG.api("account.update",{ id:id, status:status }); });
  }, Promise.resolve()).then(function(){
    CG.toast("已"+label+" "+ids.length+" 个账号","success");
    CG.refresh();
  });
}
function actBatchUsage(ids){
  CG.toast("正在查询 "+ids.length+" 个账号的用量…","info",2000);
  return ids.reduce(function(chain, id){
    return chain.then(function(){ return CG.api("account.usage",{ id:id }); });
  }, Promise.resolve()).then(function(){
    CG.toast("用量已更新","success");
    CG.refresh();
  });
}
function actBatchDeleteAccounts(ids){
  return new Promise(function(resolve, reject){
    CG.dialog({
      title:"批量删除", okText:"删除 "+ids.length+" 个",
      body:h("div",{text:"确定删除选中的 "+ids.length+" 个账号？此操作不可撤销。"}),
      onOk:function(){
        resolve(ids.reduce(function(chain, id){
          return chain.then(function(){ return CG.api("account.delete",{ id:id }); });
        }, Promise.resolve()).then(function(){
          CG.toast("已删除 "+ids.length+" 个账号","success");
          CG.refresh();
        }).catch(reject));
      }
    });
  });
}
/* 复制到剪贴板。execCommand 是同步的，在 http 页面也能用；
   clipboard API 要安全上下文（https 或 localhost），这里只当补充 */
function copyText(text){
  var ta = h("textarea",{style:{position:"fixed",top:"-1000px",left:"0",opacity:"0"}});
  ta.value = text;
  document.body.appendChild(ta);
  ta.select();
  var ok = false;
  try { ok = document.execCommand("copy"); } catch(e){ ok = false; }
  document.body.removeChild(ta);
  if(!ok && navigator.clipboard && navigator.clipboard.writeText){
    try { navigator.clipboard.writeText(text); ok = true; } catch(e2){ ok = false; }
  }
  return ok;
}
`;
