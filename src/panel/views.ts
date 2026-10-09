/**
 * 各页视图。用 window.CG 提供的运行时构建 DOM，不用模板字符串（见 client.ts 的说明）。
 */
export const VIEWS_JS = String.raw`
(function(){
"use strict";
var CG = window.CG, h = CG.h, $ = CG.$, $$ = CG.$$, esc = CG.esc;

/* 图标：内联 SVG，避免额外请求 */
function icon(name){
  var p = {
    overview:'<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
    pool:'<ellipse cx="12" cy="6" rx="8" ry="3"/><path d="M4 6v6c0 1.7 3.6 3 8 3s8-1.3 8-3V6"/><path d="M4 12v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6"/>',
    key:'<circle cx="8" cy="15" r="4"/><path d="M11 12l8-8 2 2-2 2 2 2-2 2-2-2-2 2"/>',
    req:'<path d="M4 4h16v16H4z"/><path d="M8 9h8M8 13h8M8 17h4"/>',
    rt:'<path d="M4 5h16v14H4z"/><path d="M7 9l2 2-2 2M11 13h5"/>',
    set:'<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M19.1 4.9L17 7M7 17l-2.1 2.1"/>',
    refresh:'<path d="M21 12a9 9 0 1 1-3-6.7"/><path d="M21 4v5h-5"/>',
    moon:'<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>',
    menu:'<path d="M4 7h16M4 12h16M4 17h16"/>'
  }[name] || "";
  return '<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">' + p + '</svg>';
}
window.CG.icon = icon;
/** 只给 path 内容，用来替换侧栏菜单里已有的 .ico 占位字符 */
window.CG.iconInner = function(name){ return icon(name).replace(/^<svg[^>]*>/, "").replace(/<\/svg>$/, ""); };

function card(title, body, actions){
  return h("div",{class:"el-card"},[
    title ? h("div",{class:"el-card__header"},[ h("h2",{text:title}), h("div",{class:"sp"}) ].concat(actions||[])) : null,
    h("div",{class:"el-card__body"},[body])
  ]);
}
function stat(k, v, cls){
  return h("div",{class:"cg-stat"},[ h("div",{class:"k",text:k}), h("div",{class:"v "+(cls||""),text:v}) ]);
}
function tag(text, type){
  return h("span",{class:"el-tag el-tag--"+(type||"info")},[ h("span",{class:"dot"}), h("span",{text:String(text)}) ]);
}
function progress(w){
  var p = (w && w.utilization!==null && w.utilization!==undefined) ? Math.round(w.utilization*1000)/10 : null;
  if(p===null) return h("span",{class:"muted tiny",text:"无数据"});
  var cls = w.status==="rejected" ? "is-danger" : (p>=90?"is-danger":(p>=70?"is-warning":"is-success"));
  var bar = h("div",{class:"el-progress__bar"});
  bar.appendChild(h("div",{class:"el-progress__inner "+cls,style:{width:Math.max(0,Math.min(100,p))+"%"}}));
  var reset = w.resetsAt ? h("span",{text:" · "+CG.fmtTime(w.resetsAt*1000)}) : null;
  return h("div",{class:"el-progress"},[
    h("div",{class:"el-progress__head"},[ h("span",{text:p+"%"}), reset ]),
    bar
  ]);
}
/* 额度窗口的展示名与排序。usageCell 与「加号后自动查额度」的提示共用一份 */
var WINDOW_LABELS = {
  five_hour:"5 小时", seven_day:"7 天", seven_day_opus:"7 天 Opus",
  seven_day_sonnet:"7 天 Sonnet", seven_day_overage_included:"7 天含溢出",
  seven_day_oauth_apps:"7 天 OAuth 应用", overage:"溢出额度"
};
var WINDOW_ORDER = ["five_hour","seven_day","seven_day_opus","seven_day_sonnet",
  "seven_day_overage_included","seven_day_oauth_apps","overage"];
function windowLabel(k){ return WINDOW_LABELS[k] || (k.indexOf("dim:")===0 ? k.slice(4) : k); }
function sortWindows(keys){
  return keys.slice().sort(function(x,y){
    var ix=WINDOW_ORDER.indexOf(x), iy=WINDOW_ORDER.indexOf(y);
    if(ix===-1) ix=99; if(iy===-1) iy=99;
    return ix-iy || (x<y?-1:1);
  });
}
/** 把一次用量快照压成一行短提示，用于 toast */
function usageSummary(u){
  if(!u) return null;
  if(!u.ok) return { text:"额度查询失败："+(u.error||"未知原因"), type:"warning" };
  var w = u.windows || {};
  var keys = sortWindows(Object.keys(w));
  if(!keys.length) return { text:"已查到额度，但没有可用窗口", type:"info" };
  var parts = keys.slice(0,3).map(function(k){
    var o = w[k]||{};
    var pct = (o.utilization===null||o.utilization===undefined) ? "—" : (Math.round(o.utilization*1000)/10+"%");
    return windowLabel(k)+" "+pct;
  });
  return { text:"额度："+parts.join(" · "), type:"info" };
}
function usageCell(a){
  var u = a.usage || { windows:{} };
  var keys = Object.keys(u.windows||{});
  if(!keys.length){
    var msg = u.error ? "查询失败" : (u.source==="headers" ? "等待响应头" : "无数据");
    return h("span",{class:"muted tiny",text:msg});
  }
  var box = h("div",{class:"cg-stack",style:{gap:"6px"}});
  sortWindows(keys).forEach(function(k){
    box.appendChild(h("div",{},[ h("div",{class:"tiny muted",text:windowLabel(k)}), progress(u.windows[k]||{}) ]));
  });
  return box;
}
function statusTag(a){
  if(a.status==="exhausted") return tag("额度耗尽","danger");
  if(a.status==="error") return tag("出错","danger");
  if(a.status==="disabled") return tag("已停用","info");
  if(a.cooldownUntil && a.cooldownUntil*1000>Date.now()) return tag("冷却中","warning");
  return tag("可用","success");
}
function agoCell(ms){
  if(!ms) return h("span",{class:"muted",text:"-"});
  var s = h("span",{text:CG.fmtAgo(ms)});
  s.setAttribute("data-ago", String(ms));
  s.title = CG.fmtTime(ms);
  return s;
}

/* ============ 概览 ============ */
function renderOverview(box){
  box.appendChild(h("div",{class:"el-skeleton"}));
  var host = h("div");
  box.appendChild(host);
  CG.onRefresh(function(){
    return CG.api("overview").then(function(d){
      CG.clear(host);
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
}
function accountListTable(list, mode){
  var cols = [
    { key:"label", label:"账号", sortable:true },
    { key:"reason", label:"原因", wrap:true, render:function(r){ return h("span",{class:"tiny",text:r.reason||"-"}); } },
    { key:"until", label: mode==="exhausted"?"预计恢复":"恢复时间", sortable:true,
      render:function(r){ return r.until ? CG.fmtTime(r.until*1000) : h("span",{class:"muted",text:"待上游恢复"}); } },
    { key:"act", label:"操作", render:function(r){
        var box = h("div",{class:"cg-actions"});
        box.appendChild(h("button",{class:"el-button el-button--small",text:"立即恢复",onclick:function(){ actRevive(r.id); }}));
        if(mode==="exhausted") box.appendChild(h("button",{class:"el-button el-button--small",text:"查用量",onclick:function(){ actFetchUsage(r.id); }}));
        return box;
      } }
  ];
  return CG.table(cols, list, { emptyText:"没有" });
}

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
      CG.clear(host);
      var cols = [
        { key:"label", label:"账号", sortable:true,
          filter:{type:"text",placeholder:"搜账号"},
          filterValue:function(a){ return a.label + " " + (a.email||"") + " " + a.kind; },
          render:function(a){
            var box2 = h("div",{class:"cg-stack",style:{gap:"3px"}});
            /* 就地改名：点一下变输入框，Enter 或失焦保存 */
            box2.appendChild(h("div",{},[
              CG.inlineEdit(a.label, function(next){ return actRenameAccount(a.id, next); }, {title:"点击改备注名"})
            ]));
            box2.appendChild(h("div",{class:"tiny muted",text:(a.kind==="oauth"?"订阅 OAuth":"Console Key")+(a.email?" · "+a.email:"")}));
            if(a.lastError) box2.appendChild(h("div",{class:"tiny",style:{color:"var(--el-color-danger)"},text:a.lastError.slice(0,80)}));
            return box2;
          } },
        { key:"status", label:"状态", sortable:true,
          filter:{type:"select",placeholder:"全部",options:["可用","冷却中","额度耗尽","已停用","出错"].map(function(s){ return {value:s,label:s}; })},
          filterValue:statusKey,
          render:function(a){
            var box2 = h("div",{class:"cg-stack",style:{gap:"4px"}});
            box2.appendChild(statusTag(a));
            if(a.exhaustedUntil) box2.appendChild(h("div",{class:"tiny muted",text:"恢复 "+CG.fmtTime(a.exhaustedUntil*1000)}));
            if(a.cooldownUntil && a.cooldownUntil*1000>Date.now()) box2.appendChild(h("div",{class:"tiny muted",text:"冷却至 "+CG.fmtTime(a.cooldownUntil*1000)}));
            return box2;
          } },
        { key:"usage", label:"用量", render:function(a){ return usageCell(a); } },
        { key:"requestCount", label:"请求", sortable:true, render:function(a){ return CG.fmtNum(a.requestCount); } },
        { key:"errorCount", label:"错误", sortable:true, render:function(a){ return CG.fmtNum(a.errorCount); } },
        { key:"deviceId", label:"设备指纹", filter:{type:"text",placeholder:"搜指纹"},
          filterValue:function(a){ return a.deviceId || ""; },
          render:function(a){
            return a.deviceId
              ? h("span",{class:"mono tiny",title:a.deviceId,text:a.deviceId.slice(0,10)+"…"})
              : h("span",{class:"muted tiny",text:"待生成"});
          } },
        { key:"act", label:"操作", render:function(a){
            var box2 = h("div",{class:"cg-actions"});
            box2.appendChild(h("button",{class:"el-button el-button--small",text:"查用量",onclick:function(){ actFetchUsage(a.id); }}));
            if(a.status==="exhausted"||a.status==="error") box2.appendChild(h("button",{class:"el-button el-button--small",text:"恢复",onclick:function(){ actRevive(a.id); }}));
            box2.appendChild(h("button",{class:"el-button el-button--small",text:a.status==="disabled"?"启用":"停用",onclick:function(){ actSetStatus(a); }}));
            box2.appendChild(h("button",{class:"el-button el-button--small",text:"重置",onclick:function(){ actReset(a.id); }}));
            box2.appendChild(h("button",{class:"el-button el-button--small el-button--danger",text:"删除",onclick:function(){ actDeleteAccount(a); }}));
            return box2;
          } }
      ];
      host.appendChild(card("号池（"+list.length+" 个）", CG.table(cols, list, {
        emptyText:"号池是空的，先添加一个账号",
        selectable:true,
        rowId:function(a){ return a.id; },
        batchActions:[
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
function openAddAccount(){
  var kind = CG.selectBox([
    { value:"oauth-login", label:"订阅 OAuth（授权登录，能查额度）" },
    { value:"oauth", label:"订阅 OAuth（粘贴 refresh_token）" },
    { value:"apikey", label:"Console API Key（sk-ant-...）" }
  ], { value:"oauth-login" });
  var secret = h("textarea",{class:"el-textarea__inner",placeholder:"粘贴 refresh_token 或 sk-ant-..."});
  var label = h("input",{class:"el-input__inner",placeholder:"留空自动命名"});

  /* ---------- 授权登录：两步卡片 ---------- */
  var started = null;

  var linkInput = h("input",{class:"el-input__inner",readonly:"readonly",placeholder:"点左侧按钮生成"});
  var copyBtn = h("button",{class:"el-button",type:"button",text:"复制"});
  var openBtn = h("button",{class:"el-button el-button--primary",type:"button",text:"打开授权页"});
  copyBtn.disabled = true;
  openBtn.disabled = true;

  var genBtn = h("button",{class:"el-button el-button--primary",type:"button",text:"生成授权链接"});
  var linkRow = h("div",{class:"cg-linkrow"},[ linkInput, copyBtn, openBtn ]);
  var step1Hint = h("div",{class:"cg-step__hint",
    text:"生成后点「打开授权页」完成登录。按钮被浏览器拦了就先「复制」再手动打开。"});
  linkRow.style.display = "none";
  step1Hint.style.display = "none";

  var step1 = h("div",{class:"cg-step"},[
    h("div",{class:"cg-step__no",text:"1"}),
    h("div",{class:"cg-step__main"},[
      h("div",{class:"cg-step__title",text:"生成授权链接并完成登录"}),
      h("div",{class:"cg-actions"},[ genBtn ]),
      linkRow, step1Hint
    ])
  ]);

  var codeInput = h("input",{class:"el-input__inner",placeholder:"形如 xxx#yyy，整段粘进来即可"});
  var step2 = h("div",{class:"cg-step"},[
    h("div",{class:"cg-step__no",text:"2"}),
    h("div",{class:"cg-step__main"},[
      h("div",{class:"cg-step__title",text:"把授权码粘回来"}),
      h("div",{style:{marginTop:"10px"}},[ codeInput ]),
      h("div",{class:"cg-step__hint",text:"授权成功后页面会显示一段 code，整段复制过来即可。"})
    ])
  ]);

  var authItem = h("div",{class:"el-form-item"},[
    h("div",{class:"el-form-item__label",text:"授权登录"}),
    h("div",{class:"cg-auth"},[ step1, step2 ])
  ]);

  copyBtn.addEventListener("click", function(){
    if(!started) return;
    var ok = copyText(started.authorizeUrl);
    CG.toast(ok ? "链接已复制" : "复制失败，请手动选中复制", ok ? "success" : "warning");
  });
  openBtn.addEventListener("click", function(){
    if(!started) return;
    var w = window.open(started.authorizeUrl, "_blank", "noopener,noreferrer");
    if(!w) CG.toast("浏览器拦了新窗口，请用「复制」手动打开","warning");
  });

  /* 拿到链接后对话框**不关**：用户要切到新标签页登录，回来还得在这个框里粘 code */
  function startAuth(){
    genBtn.disabled = true;
    genBtn.textContent = "生成中…";
    return CG.api("oauth.start",{}).then(function(r){
      started = r;
      linkInput.value = r.authorizeUrl;
      linkRow.style.display = "";
      step1Hint.style.display = "";
      copyBtn.disabled = false;
      openBtn.disabled = false;
      step1.classList.add("is-done");
      genBtn.textContent = "重新生成";
      genBtn.disabled = false;
      codeInput.focus();
      CG.toast("链接已生成，去新标签页完成登录","success");
      return false;
    }).catch(function(e){
      genBtn.disabled = false;
      genBtn.textContent = "生成授权链接";
      throw e;
    });
  }
  genBtn.addEventListener("click", function(){ startAuth().catch(CG.showErr); });

  var secretItem = h("div",{class:"el-form-item"},[ h("div",{class:"el-form-item__label",text:"凭据"}), secret ]);
  var labelItem = h("div",{class:"el-form-item"},[ h("div",{class:"el-form-item__label",text:"备注名（可选）"}), label ]);
  function syncKind(){
    var isAuth = kind.value === "oauth-login";
    authItem.style.display = isAuth ? "" : "none";
    secretItem.style.display = isAuth ? "none" : "";
    labelItem.style.display = isAuth ? "none" : "";
  }
  kind.addEventListener("change", syncKind);

  var body = h("div",{},[
    h("div",{class:"el-form-item"},[ h("div",{class:"el-form-item__label",text:"类型"}), kind.el ]),
    authItem, secretItem, labelItem
  ]);
  syncKind();

  CG.dialog({
    title:"添加账号", wide:true, body:body,
    onOk:function(){
      var k = kind.value;
      if(k === "oauth-login"){
        /* 还没拿链接就点主按钮：当成「获取授权链接」，别让人白点一下 */
        if(!started) return startAuth();
        var code = codeInput.value.trim();
        if(!code){ CG.toast("先把授权码粘进来","warning"); return false; }
        /* 服务端建完号会顺手查一次额度，最长 8 秒，先给个提示免得像卡住了 */
        CG.toast("正在登录并查询额度…","info",8000);
        return CG.api("oauth.finish",{ state:started.state, code:code }).then(function(acc){
          CG.toast("已添加「"+((acc && acc.label)||"账号")+"」","success");
          var sum = usageSummary(acc && acc.usage);
          if(sum) CG.toast(sum.text, sum.type, 7000);
          CG.refresh();
        });
      }
      return CG.api("account.create",{ kind:k, secret:secret.value, label:label.value }).then(function(){
        CG.toast("已添加","success"); CG.refresh();
      });
    }
  });
}
function openBatchImport(){
  var kind = CG.selectBox([
    { value:"oauth", label:"订阅 OAuth（每行一个 refresh_token）" },
    { value:"apikey", label:"Console API Key（每行一个 sk-ant-...）" }
  ], { value:"oauth" });
  var lines = h("textarea",{class:"el-textarea__inner",style:{minHeight:"160px"},placeholder:"每行一个，可带备注：refresh_token  备注名"});
  CG.dialog({
    title:"批量导入", wide:true, okText:"导入",
    body:h("div",{},[
      h("div",{class:"el-form-item"},[ h("div",{class:"el-form-item__label",text:"类型"}), kind.el ]),
      h("div",{class:"el-form-item"},[ h("div",{class:"el-form-item__label",text:"凭据（每行一个）"}), lines ])
    ]),
    onOk:function(){
      return CG.api("account.batch",{ kind:kind.value, lines:lines.value }).then(function(r){
        CG.toast("导入完成：成功 "+(r.created||0)+" 个"+(r.failed?"，失败 "+r.failed:""), r.failed?"warning":"success");
        CG.refresh();
      });
    }
  });
}
function actSetStatus(a){
  var next = a.status==="disabled" ? "active" : "disabled";
  CG.api("account.update",{ id:a.id, status:next }).then(function(){
    CG.toast(next==="disabled"?"已停用":"已启用","success"); CG.refresh();
  }).catch(CG.showErr);
}
function actRevive(id){
  CG.api("account.revive",{ id:id }).then(function(){ CG.toast("已恢复","success"); CG.refresh(); }).catch(CG.showErr);
}
function actReset(id){
  CG.api("account.reset",{ id:id }).then(function(){ CG.toast("已重置","success"); CG.refresh(); }).catch(CG.showErr);
}
function actFetchUsage(id){
  CG.toast("正在查询用量…","info",1500);
  CG.api("account.usage",{ id:id }).then(function(){ CG.toast("用量已更新","success"); CG.refresh(); }).catch(CG.showErr);
}
function actFetchUsageAll(){
  CG.toast("正在查询全部账号用量…","info",2000);
  CG.api("account.usage",{all:true}).then(function(){ CG.toast("用量已更新","success"); CG.refresh(); }).catch(CG.showErr);
}
function actDeleteAccount(a){
  CG.dialog({
    title:"删除账号", okText:"删除",
    body:h("div",{},[ h("div",{text:"确定删除「"+a.label+"」？此操作不可撤销。"}) ]),
    onOk:function(){ return CG.api("account.delete",{ id:a.id }).then(function(){ CG.toast("已删除","success"); CG.refresh(); }); }
  });
}

/* ============ API Key ============ */
function renderKeys(box){
  var host = h("div");
  box.appendChild(host);
  CG.onRefresh(function(){
    return CG.api("keys").then(function(list){
      CG.clear(host);
      var cols = [
        { key:"name", label:"名称", sortable:true,
          filter:{type:"text",placeholder:"搜名称"},
          filterValue:function(k){ return k.name + " " + k.keyPrefix; },
          render:function(k){
            var b = h("div",{class:"cg-stack",style:{gap:"3px"}});
            b.appendChild(CG.inlineEdit(k.name, function(next){ return actRenameKey(k.id, next); }, {title:"点击改名"}));
            b.appendChild(h("div",{class:"mono tiny muted",text:k.keyPrefix+"…"}));
            return b;
          } },
        { key:"enabled", label:"状态", sortable:true,
          filter:{type:"select",placeholder:"全部",options:[{value:"启用",label:"启用"},{value:"停用",label:"停用"}]},
          filterValue:function(k){ return k.enabled?"启用":"停用"; },
          render:function(k){ return tag(k.enabled?"启用":"停用", k.enabled?"success":"info"); } },
        { key:"fingerprintMode", label:"指纹", sortable:true,
          filter:{type:"select",placeholder:"全部",options:[{value:"claude_code",label:"Claude Code"},{value:"passthrough",label:"透传"}]},
          render:function(k){ return tag(k.fingerprintMode==="claude_code"?"Claude Code":"透传", k.fingerprintMode==="claude_code"?"primary":"info"); } },
        { key:"quotaEnabled", label:"配额", render:function(k){ return tag(k.quotaEnabled?"已启用":"未启用", k.quotaEnabled?"success":"info"); } },
        { key:"usageToday", label:"今日", sortable:true, sortValue:function(k){ return k.usageToday.requests; },
          render:function(k){ return CG.fmtNum(k.usageToday.requests)+" 次 / "+CG.fmtNum(k.usageToday.tokens)+" token"; } },
        { key:"createdAt", label:"创建", sortable:true, render:function(k){ return agoCell(k.createdAt*1000); } },
        { key:"act", label:"操作", render:function(k){
            var b = h("div",{class:"cg-actions"});
            b.appendChild(h("button",{class:"el-button el-button--small",text:k.enabled?"停用":"启用",onclick:function(){ actToggleKey(k); }}));
            b.appendChild(h("button",{class:"el-button el-button--small",text:"改配额",onclick:function(){ openKeyQuota(k); }}));
            b.appendChild(h("button",{class:"el-button el-button--small el-button--danger",text:"删除",onclick:function(){ actDeleteKey(k); }}));
            return b;
          } }
      ];
      host.appendChild(card("API Key（"+list.length+" 把）", CG.table(cols, list, {
        emptyText:"还没有 Key，先创建一把",
        selectable:true,
        rowId:function(k){ return k.id; },
        batchActions:[
          { label:"批量启用", run:function(ids){ return actBatchKeys(ids, true); } },
          { label:"批量停用", run:function(ids){ return actBatchKeys(ids, false); } },
          { label:"批量删除", type:"danger", run:function(ids){ return actBatchDeleteKeys(ids); } }
        ]
      }), [
        h("button",{class:"el-button el-button--primary",text:"创建 Key",onclick:openCreateKey})
      ]));
      return list;
    });
  });
}
function actRenameKey(id, name){
  return CG.api("key.update",{ id:id, name:name });
}
function actBatchKeys(ids, enabled){
  return ids.reduce(function(chain, id){
    return chain.then(function(){ return CG.api("key.update",{ id:id, enabled:enabled }); });
  }, Promise.resolve()).then(function(){
    CG.toast("已"+(enabled?"启用":"停用")+" "+ids.length+" 把 Key","success");
    CG.refresh();
  });
}
function actBatchDeleteKeys(ids){
  return new Promise(function(resolve, reject){
    CG.dialog({
      title:"批量删除 Key", okText:"删除 "+ids.length+" 把",
      body:h("div",{text:"确定删除选中的 "+ids.length+" 把 Key？使用它们的客户端会立刻失效。"}),
      onOk:function(){
        resolve(ids.reduce(function(chain, id){
          return chain.then(function(){ return CG.api("key.delete",{ id:id }); });
        }, Promise.resolve()).then(function(){
          CG.toast("已删除 "+ids.length+" 把 Key","success");
          CG.refresh();
        }).catch(reject));
      }
    });
  });
}
/* 新密钥只显示一次，关掉就没了 —— 创建与重置共用 */
function showNewKey(plaintext, title){
  CG.dialog({
    title: title || "新密钥（只显示这一次）", wide:true,
    body:h("div",{},[
      h("div",{class:"el-alert el-alert--warning"},[
        h("span",{text:"这把 Key 只显示这一次，请立刻保存。关掉这个框之后就再也看不到明文了。"})
      ]),
      h("div",{class:"cg-code",text:plaintext}),
      h("div",{style:{marginTop:"10px"}},[
        h("button",{class:"el-button",text:"复制",onclick:function(){
          var ok = copyText(plaintext);
          CG.toast(ok ? "已复制" : "复制失败，请手动选中复制", ok ? "success" : "warning");
        }})
      ])
    ])
  });
}

/* 重置密钥：换一把新的，名字 / 配额 / 绑定 / 指纹策略都保留 */
function actResetKey(k){
  CG.confirmDialog(
    "确定给「" + k.name + "」换一把新密钥？\n" +
    "旧密钥立刻失效，其余配置（名字、配额、绑定、指纹策略）原样保留。",
    "重置密钥"
  ).then(function(yes){
    if(!yes) return;
    return CG.api("key.reset",{ id:k.id }).then(function(r){
      showNewKey(r.plaintext, "「" + k.name + "」的新密钥（只显示这一次）");
      CG.toast("密钥已重置","success");
      CG.refresh();
    });
  }).catch(CG.showErr);
}

function openCreateKey(){
  var name = h("input",{class:"el-input__inner",placeholder:"例如 claude-code-本机"});
  var mode = CG.selectBox([
    { value:"claude_code", label:"claude_code（严格校验并注入规范头）" },
    { value:"passthrough", label:"passthrough（不校验，仍注入规范头）" }
  ], { value:"claude_code" });
  var quotaBox = CG.switchBox(false);
  CG.dialog({
    title:"创建 API Key", okText:"创建",
    body:h("div",{},[
      h("div",{class:"el-form-item"},[ h("div",{class:"el-form-item__label",text:"名称"}), name ]),
      h("div",{class:"el-form-item"},[ h("div",{class:"el-form-item__label",text:"指纹策略"}), mode.el ]),
      h("div",{class:"el-form-item"},[ h("div",{class:"el-form-item__label",text:"启用每日配额"}), quotaBox.el ])
    ]),
    onOk:function(){
      return CG.api("key.create",{ name:name.value, fingerprintMode:mode.value, quotaEnabled:quotaBox.input.checked }).then(function(r){
        showNewKey(r.plaintext || "", "Key 已创建（只显示这一次）");
        CG.refresh();
      });
    }
  });
}
function openKeyQuota(k){
  var qBox = CG.switchBox(k.quotaEnabled);
  var req = h("input",{class:"el-input__inner",type:"number",value:k.dailyRequestLimit||0});
  var tok = h("input",{class:"el-input__inner",type:"number",value:k.dailyTokenLimit||0});
  var rpm = h("input",{class:"el-input__inner",type:"number",value:k.rateLimitPerMin||0});
  CG.dialog({
    title:"配额："+k.name, okText:"保存",
    body:h("div",{},[
      h("div",{class:"el-form-item"},[ h("div",{class:"el-form-item__label",text:"启用配额"}), qBox.el ]),
      h("div",{class:"el-form-item"},[ h("div",{class:"el-form-item__label",text:"每日请求上限（0 不限）"}), req ]),
      h("div",{class:"el-form-item"},[ h("div",{class:"el-form-item__label",text:"每日 token 上限（0 不限）"}), tok ]),
      h("div",{class:"el-form-item"},[ h("div",{class:"el-form-item__label",text:"每分钟请求上限（0 不限）"}), rpm ])
    ]),
    onOk:function(){
      return CG.api("key.update",{ id:k.id, quotaEnabled:qBox.input.checked, dailyRequestLimit:Number(req.value)||0,
        dailyTokenLimit:Number(tok.value)||0, rateLimitPerMin:Number(rpm.value)||0 }).then(function(){
        CG.toast("已保存","success"); CG.refresh();
      });
    }
  });
}
function actToggleKey(k){
  CG.api("key.update",{ id:k.id, enabled:!k.enabled }).then(function(){ CG.toast("已更新","success"); CG.refresh(); }).catch(CG.showErr);
}
function actDeleteKey(k){
  CG.dialog({
    title:"删除 Key", okText:"删除",
    body:h("div",{text:"确定删除「"+k.name+"」？使用它的客户端会立刻失效。"}),
    onOk:function(){ return CG.api("key.delete",{ id:k.id }).then(function(){ CG.toast("已删除","success"); CG.refresh(); }); }
  });
}

/* ============ 请求日志 ============ */
var reqState = { page:1, size:50, outcome:"", protocol:"", search:"", data:null };
function renderReqLogs(box){
  var host = h("div");
  box.appendChild(host);
  var outcome = CG.selectBox([
    { value:"", label:"全部结果" }, { value:"ok", label:"成功" },
    { value:"blocked", label:"被拦截" }, { value:"error", label:"错误" }
  ], { value:reqState.outcome });
  outcome.el.classList.add("cg-colfilter");
  var protocol = CG.selectBox([
    { value:"", label:"全部协议" }, { value:"anthropic", label:"anthropic" },
    { value:"openai", label:"openai" }
  ], { value:reqState.protocol });
  protocol.el.classList.add("cg-colfilter");
  var search = h("input",{class:"el-input__inner",placeholder:"req-id / 路径 / 模型 / 账号 / IP"});
  search.value = reqState.search;
  function apply(){ reqState.outcome=outcome.value; reqState.protocol=protocol.value; reqState.search=search.value; reqState.page=1; load(); }
  search.addEventListener("keydown", function(e){ if(e.key==="Enter") apply(); });
  outcome.addEventListener("change", apply);
  protocol.addEventListener("change", apply);

  /* 结果与协议挂到对应列的表头下面当列筛选，顶部只留跨列的搜索 */
  var filters = h("div",{class:"cg-filters"},[
    h("div",{class:"el-form-item cg-grow"},[ h("div",{class:"el-form-item__label",text:"搜索"}), search ]),
    h("button",{class:"el-button el-button--primary",text:"查询",onclick:apply}),
    h("button",{class:"el-button",text:"重置",onclick:function(){ outcome.value=""; protocol.value=""; search.value=""; apply(); }})
  ]);

  var listHost = h("div");
  var pageHost = h("div");
  var cardEl = card("请求日志", h("div",{},[filters, listHost, pageHost]));
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
      CG.clear(listHost);
      var rows = d.rows||[];
      var cols = [
        { key:"ts", label:"时间", sortable:true, render:function(r){
            var b = h("div",{class:"cg-stack",style:{gap:"2px"}});
            b.appendChild(h("div",{text:CG.fmtTime(r.ts)}));
            b.appendChild(h("div",{class:"tiny muted",text:CG.fmtAgo(r.ts)}));
            return b;
          } },
        { key:"reqId", label:"req-id", render:function(r){ return h("span",{class:"mono tiny",text:r.reqId||"-"}); } },
        { key:"ip", label:"来源", render:function(r){ return h("span",{class:"mono tiny",text:r.ip||"-"}); } },
        { key:"keyName", label:"Key", render:function(r){ return r.keyName||"-"; } },
        { key:"protocol", label:"协议", sortable:true, filter:{type:"slot", el:protocol.el} },
        { key:"model", label:"模型", render:function(r){ return h("span",{class:"mono tiny",text:r.model||"-"}); } },
        { key:"accountLabel", label:"账号", render:function(r){ return r.accountLabel||"-"; } },
        { key:"status", label:"状态", sortable:true, filter:{type:"slot", el:outcome.el}, render:function(r){
            if(r.blocked) return tag("拦截","danger");
            if(r.status>=400) return tag(String(r.status),"warning");
            return tag(String(r.status||200),"success");
          } },
        { key:"durationMs", label:"耗时", sortable:true, render:function(r){ return CG.fmtDur(r.durationMs); } },
        { key:"tokens", label:"token", render:function(r){
            return h("span",{class:"tiny",text:CG.fmtNum(r.tokensIn)+" / "+CG.fmtNum(r.tokensOut)+" / "+CG.fmtNum(r.cacheReadTokens)});
          } },
        { key:"note", label:"说明", clamp:true, render:function(r){ return h("span",{class:"tiny",text:r.note||"-"}); } }
      ];
      listHost.appendChild(CG.table(cols, rows, {
        sortKey:"ts", sortDir:"desc", emptyText:"没有符合条件的请求",
        rowClass:function(r){ return r.blocked ? "row-danger" : (r.status>=400 ? "row-warn" : ""); }
      }));
      CG.clear(pageHost);
      pageHost.appendChild(CG.pager({ total:d.total||0, page:reqState.page, size:reqState.size, onChange:function(p){ reqState.page=p; load(); } }));
      return d;
    }).catch(function(e){ CG.clear(listHost); listHost.appendChild(CG.emptyState("加载失败："+e.message)); throw e; });
  }
  load();
  CG.onRefresh(load);
}

/* ============ 运行日志 ============ */
var rtState = { page:1, size:100, level:"", search:"" };
function renderRtLogs(box){
  var host = h("div");
  box.appendChild(host);
  var level = CG.selectBox([
    { value:"", label:"全部级别" }, { value:"debug", label:"debug" },
    { value:"info", label:"info" }, { value:"warn", label:"warn" }, { value:"error", label:"error" }
  ], { value:rtState.level });
  level.el.classList.add("cg-colfilter");
  var search = h("input",{class:"el-input__inner",placeholder:"搜索日志内容"});
  search.value = rtState.search;
  function apply(){ rtState.level=level.value; rtState.search=search.value; rtState.page=1; load(); }
  search.addEventListener("keydown", function(e){ if(e.key==="Enter") apply(); });
  level.addEventListener("change", apply);

  var listHost = h("div");
  var pageHost = h("div");
  host.appendChild(card("运行日志", h("div",{},[
    h("div",{class:"cg-filters"},[
      h("div",{class:"el-form-item cg-grow"},[ h("div",{class:"el-form-item__label",text:"搜索"}), search ]),
      h("button",{class:"el-button el-button--primary",text:"查询",onclick:apply}),
      h("button",{class:"el-button",text:"清空历史",onclick:function(){
        CG.dialog({ title:"清空运行日志", okText:"清空",
          body:h("div",{text:"会按保留策略删除旧日志，确定继续？"}),
          onOk:function(){ return CG.api("logs.prune",{}).then(function(r){ CG.toast("已按保留 "+(r.days||"?")+" 天清理，运行日志上限 "+(r.maxRows||"?"),"success"); load(); }); } });
      }})
    ]),
    listHost, pageHost
  ])));

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
        { key:"level", label:"级别", sortable:true, filter:{type:"slot", el:level.el}, render:function(r){
            var t = r.level==="error"?"danger":(r.level==="warn"?"warning":(r.level==="debug"?"info":"success"));
            return tag(r.level,t);
          } },
        { key:"scope", label:"来源", render:function(r){ return h("span",{class:"mono tiny",text:r.scope||"-"}); } },
        { key:"message", label:"内容", wrap:true, render:function(r){ return h("span",{class:"tiny",text:r.message||""}); } }
      ];
      listHost.appendChild(CG.table(cols, d.rows||[], { sortKey:"ts", sortDir:"desc", emptyText:"暂无日志" }));
      CG.clear(pageHost);
      pageHost.appendChild(CG.pager({ total:d.total||0, page:rtState.page, size:rtState.size, onChange:function(p){ rtState.page=p; load(); } }));
      return d;
    }).catch(function(e){ CG.clear(listHost); listHost.appendChild(CG.emptyState("加载失败："+e.message)); throw e; });
  }
  load();
  CG.onRefresh(load);
}

/* ============ 设置 ============ */
/* 模型目录卡片。清单来自 Claude Code 的远端目录，进程内只留一份 */
function modelCard(){
  var out = h("div",{});
  var listHost = h("div",{style:{marginTop:"10px"}});
  var btn = h("button",{class:"el-button",type:"button",text:"重新拉取"});

  var SOURCE = { remote:"远端目录", cache:"磁盘缓存", builtin:"内置兜底" };

  function line(k, val, tone){
    return h("div",{style:{display:"flex",gap:"10px",marginTop:"6px"}},
      [ h("span",{class:"tiny muted",style:{flex:"0 0 84px"},text:k}),
        h("span",{class:"mono tiny",style:{color: tone ? "var(--el-color-"+tone+")" : "inherit"},text:val}) ]);
  }
  function stamp(ms){
    if(!ms) return "从未成功拉取";
    var d = new Date(ms);
    var p = function(n){ return (n<10?"0":"")+n; };
    return d.getFullYear()+"-"+p(d.getMonth()+1)+"-"+p(d.getDate())+" "+p(d.getHours())+":"+p(d.getMinutes())+":"+p(d.getSeconds());
  }
  function paint(r){
    CG.clear(out);
    var tone = r.error ? "warning" : "success";
    out.appendChild(h("div",{style:{color:"var(--el-color-"+tone+")",fontWeight:"500"},
      text: (SOURCE[r.source]||r.source) + " · " + r.count + " 个模型" + (r.refreshing ? "（正在刷新…）" : "")}));
    out.appendChild(line("来源", SOURCE[r.source]||r.source));
    out.appendChild(line("模型数", String(r.count)));
    out.appendChild(line("目录版本", r.version===null||r.version===undefined ? "（无）" : String(r.version)));
    out.appendChild(line("上次拉取", stamp(r.fetchedAt)));
    out.appendChild(line("缓存时效", Math.round((r.ttlMs||0)/3600000) + " 小时"));
    out.appendChild(line("模型校验", r.validation==="off" ? "off（不校验）" : "strict（清单外报错）"));
    if(r.error) out.appendChild(line("上次错误", r.error, "warning"));
    out.appendChild(h("div",{class:"tiny muted",style:{marginTop:"8px",lineHeight:"1.7"},
      text:"清单地址：" + r.url}));

    CG.clear(listHost);
    if(r.models && r.models.length){
      var wrap = h("div",{style:{display:"flex",flexWrap:"wrap",gap:"6px",marginTop:"4px"}});
      for(var i=0;i<r.models.length;i++){
        var m = r.models[i];
        wrap.appendChild(h("span",{class:"el-tag el-tag--info el-tag--small",
          title: m.firstParty, text: m.id}));
      }
      listHost.appendChild(h("div",{class:"el-form-item__label",style:{marginTop:"10px"},text:"当前清单"}));
      listHost.appendChild(wrap);
    }
  }
  function load(){ return CG.api("models.status",{}).then(paint); }

  btn.addEventListener("click", function(){
    btn.disabled = true; btn.textContent = "拉取中…";
    CG.api("models.refresh",{}).then(function(r){ paint(r); CG.toast("已拉取 "+r.count+" 个模型","success"); })
      .catch(CG.showErr).then(function(){ btn.disabled = false; btn.textContent = "重新拉取"; });
  });

  load().catch(function(){});
  return card("模型目录", h("div",{},[
    h("div",{class:"tiny muted",style:{lineHeight:"1.7"},
      text:"/v1/models 返回的清单。网关从 Claude Code 用的那份远端目录拉取，进程内只留一份，" +
           "请求打过来时只读内存，不会每次都去拉。过期会自动在后台刷一次；拉不到就退回内置清单。"}),
    h("div",{style:{marginTop:"10px"}},[ btn ]),
    out, listHost
  ]));
}

/* 出口自检卡片。启动时会自动跑一次，这里是手动重跑 —— 换了代理不用重启 */
function egressCard(){
  var out = h("div",{});
  var btn = h("button",{class:"el-button",type:"button",text:"立即检查"});

  function line(k, val, tone){
    return h("div",{style:{display:"flex",gap:"10px",marginTop:"6px"}},
      [ h("span",{class:"tiny muted",style:{flex:"0 0 84px"},text:k}),
        h("span",{class:"mono tiny",style:{color: tone ? "var(--el-color-"+tone+")" : "inherit"},text:val}) ]);
  }
  function paint(r){
    CG.clear(out);
    var tone = r.conclusive ? (r.proxyIgnored ? "danger" : "success") : "warning";
    out.appendChild(h("div",{style:{color:"var(--el-color-"+tone+")",fontWeight:"500"},
      text: r.conclusive ? (r.proxyIgnored ? "代理没生效" : "出口正常") : "无法判定"}));
    out.appendChild(line("直连出口", r.direct && r.direct.ip ? r.direct.ip : ("取不到（"+((r.direct&&r.direct.error)||"未知")+"）")));
    out.appendChild(line("经代理出口", r.proxied && r.proxied.ip ? r.proxied.ip : ("取不到（"+((r.proxied&&r.proxied.error)||"未知")+"）")));
    out.appendChild(line("回显服务", r.url));
    out.appendChild(h("div",{class:"tiny muted",style:{marginTop:"8px",lineHeight:"1.7"},text:r.summary}));
  }

  btn.addEventListener("click", function(){
    btn.disabled = true; btn.textContent = "检查中…";
    CG.clear(out);
    out.appendChild(h("div",{class:"tiny muted",text:"正在分别经代理与直连查询出口 IP…"}));
    CG.api("net.ipcheck",{}).then(paint).catch(CG.showErr).then(function(){
      btn.disabled = false; btn.textContent = "立即检查";
    });
  });

  return card("出口自检", h("div",{},[
    h("div",{class:"tiny muted",style:{lineHeight:"1.7"},
      text:"分别用带代理和不带代理各查一次出口 IP。两次结果相同就说明请求根本没走代理 —— " +
           "这时候流量会从本机直出，对上游来说是完全不同的来源。启动时也会自动跑一次。"}),
    h("div",{style:{marginTop:"10px"}},[ btn ]),
    out
  ]));
}
function renderSettings(box){
  var host = h("div");
  box.appendChild(host);
  CG.onRefresh(function(){
    return CG.api("settings").then(function(s){
      CG.clear(host);
      var guard = CG.selectBox([
        { value:"strict", label:"strict（缺规范头直接 403）" },
        { value:"lenient", label:"lenient（缺头放行并告警）" },
        { value:"off", label:"off（不校验）" }
      ], { value:s.guardMode });
      var stego = CG.selectBox([
        { value:"block", label:"block（拦截并说明）" },
        { value:"strip", label:"strip（清洗后转发）" },
        { value:"log", label:"log（只记日志）" },
        { value:"off", label:"off（不检测）" }
      ], { value:s.stegoMode });
      var reqid = CG.selectBox([
        { value:"error", label:"error（只在错误响应里带）" },
        { value:"always", label:"always（成功也带）" },
        { value:"off", label:"off" }
      ], { value:s.reqIdInResponse });
      var injectBox = CG.switchBox(s.injectMissing);
      var inject = injectBox.input;
      var keep = h("input",{class:"el-input__inner",type:"number",value:s.logRetentionDays});
      var maxrt = h("input",{class:"el-input__inner",type:"number",value:s.runtimeLogMax});

      host.appendChild(card("策略设置", h("div",{},[
        h("div",{class:"cg-row"},[
          h("div",{class:"el-form-item cg-col"},[ h("div",{class:"el-form-item__label",text:"请求头守卫"}), guard.el ]),
          h("div",{class:"el-form-item cg-col"},[ h("div",{class:"el-form-item__label",text:"隐写拦截"}), stego.el ]),
          h("div",{class:"el-form-item cg-col"},[ h("div",{class:"el-form-item__label",text:"请求 ID 回传"}), reqid.el ])
        ]),
        h("div",{class:"el-form-item"},[ h("div",{class:"el-form-item__label",text:"缺失规范头时自动注入"}), injectBox.el ]),
        h("div",{class:"cg-row"},[
          h("div",{class:"el-form-item cg-col"},[ h("div",{class:"el-form-item__label",text:"请求日志保留天数"}), keep ]),
          h("div",{class:"el-form-item cg-col"},[ h("div",{class:"el-form-item__label",text:"运行日志上限条数"}), maxrt ])
        ]),
        h("button",{class:"el-button el-button--primary",text:"保存设置",onclick:function(){
          CG.api("settings.save",{
            guardMode:guard.value, stegoMode:stego.value, reqIdInResponse:reqid.value,
            injectMissing:inject.checked, logRetentionDays:Number(keep.value)||14, runtimeLogMax:Number(maxrt.value)||20000
          }).then(function(){ CG.toast("设置已保存","success"); }).catch(CG.showErr);
        }})
      ])));

      host.appendChild(egressCard());
      host.appendChild(modelCard());
      host.appendChild(adminKeyCard());
      return s;
    });
  });
}

/* ---- 面板登录密钥：状态 + 重置 ---- */
function adminKeyCard(){
  var host = h("div");
  function load(){
    CG.clear(host);
    CG.api("admin.keyinfo").then(function(k){
      var source = k.envOverride
        ? "由 ADMIN_TOKEN 接管（环境变量）"
        : (k.mode === "custom" ? "面板里重置过" : "从主密钥单向派生");
      var where = k.keyFile + (k.envMirrored && k.envFile ? "（并已镜像到 " + k.envFile + " 的 ADMIN_SECRET）" : "");
      host.appendChild(card("面板登录密钥", h("div",{},[
        h("div",{class:"tiny muted",text:"首次启动会自动派发一个登录密钥，在日志里打印一次，之后不再打印。忘了就在这里重置。"}),
        h("div",{class:"cg-row",style:{marginTop:"12px"}},[
          h("div",{class:"el-form-item cg-col"},[ h("div",{class:"el-form-item__label",text:"当前来源"}), h("div",{class:"tiny",text:source}) ]),
          h("div",{class:"el-form-item cg-col"},[ h("div",{class:"el-form-item__label",text:"主密钥指纹"}), h("div",{class:"tiny",text:k.masterFingerprint || "-"}) ]),
          h("div",{class:"el-form-item cg-col"},[ h("div",{class:"el-form-item__label",text:"上次重置"}), h("div",{class:"tiny",text:k.rotatedAt ? CG.fmtTime(k.rotatedAt*1000) : "从未"}) ])
        ]),
        h("div",{class:"el-form-item"},[ h("div",{class:"el-form-item__label",text:"主密钥位置"}), h("div",{class:"tiny",text:where}) ]),
        k.envOverride
          ? h("div",{class:"tiny muted",text:"当前由 ADMIN_TOKEN 接管，要换请改环境变量并重启。"})
          : h("button",{class:"el-button el-button--primary",text:"重置登录密钥",onclick:function(){ resetKeyDialog(load); }})
      ])));
    }).catch(CG.showErr);
  }
  load();
  return host;
}

function resetKeyDialog(reload){
  var input = h("input",{class:"el-input__inner",placeholder:"留空则随机生成（至少 12 位）",autocomplete:"off"});
  CG.dialog({
    title:"重置登录密钥", okText:"重置",
    body:h("div",{},[
      h("div",{class:"tiny muted",text:"重置后当前会话立刻改用新密钥，旧密钥马上失效。"}),
      h("div",{class:"el-form-item",style:{marginTop:"10px"}},[
        h("div",{class:"el-form-item__label",text:"自定义密钥（可留空）"}), input
      ])
    ]),
    onOk:function(){
      return CG.api("admin.keyreset",{ key:input.value.trim() }).then(function(r){
        /* 先把自己换过去，否则下一次刷新就 401 了 */
        CG.setToken(r.key);
        reload();
        showKeyOnce(r.key);
      });
    }
  });
}

/* 新密钥只在这里显示一次。关掉就没有明文了 —— 盘上只留 scrypt 哈希 */
function showKeyOnce(key){
  var input = h("input",{class:"el-input__inner",value:key,readonly:"readonly"});
  input.addEventListener("focus", function(){ input.select(); });
  CG.dialog({
    title:"新登录密钥（只显示这一次）",
    body:h("div",{},[
      h("div",{class:"tiny muted",text:"复制保存好。关掉这个框之后再也看不到明文，盘上只有哈希。"}),
      h("div",{class:"el-form-item",style:{marginTop:"10px"}},[ input ]),
      h("button",{class:"el-button",text:"复制",onclick:function(){
        input.select();
        var ok = false;
        try { ok = document.execCommand("copy"); } catch(e){ ok = false; }
        CG.toast(ok ? "已复制" : "复制失败，请手动选中复制", ok ? "success" : "warning");
      }})
    ])
  });
}

/* ============ 路由分发 ============ */
function render(){
  var box = $("#view");
  if(!box) return;
  CG.clear(box);
  CG.clearRefreshers();
  var map = { overview:renderOverview, accounts:renderAccounts, keys:renderKeys, reqlogs:renderReqLogs, rtlogs:renderRtLogs, settings:renderSettings };
  var name = (location.hash||"#/overview").replace("#/","");
  var fn = map[name] || renderOverview;
  fn(box);
  CG.refresh();
}
window.CG.render = render;
})();
`;
