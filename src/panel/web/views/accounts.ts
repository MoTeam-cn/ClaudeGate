/**
 * 面板视图 · 号池
 *
 * 从原来的面板单文件里拆出来的片段。它只是一段字符串：面板零依赖、零构建，
 * 服务端把片段按 index.ts 里的顺序拼成一个 bundle 再下发给浏览器。
 */
export const ACCOUNTS_JS = String.raw`
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
          render:function(a){ return h("span",{class:"cg-num",text:CG.fmtNum(a.requestCount)}); } },
        { key:"errorCount", label:"错误", sortable:true, align:"right", width:"68px",
          render:function(a){
            var n = a.errorCount || 0;
            return h("span",{class:"cg-num",style:n?{color:"var(--el-color-danger)"}:null,text:CG.fmtNum(n)});
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
/* 刷新账号信息：拉档案（真名/邮箱/套餐）+ 查一次额度。
   跟「查用量」不同 —— 它会强制拉档案，把建号时瞎填的默认备注名换成真名 */
function actRefreshAccount(id){
  CG.toast("正在刷新账号信息…","info",1800);
  CG.api("account.refresh",{ id:id }).then(function(r){
    var one = (r && r.results && r.results[0]) || null;
    if(one && one.profileError) CG.toast("档案没刷到：" + one.profileError, "warning", 4000);
    else if(one && one.before !== one.label) CG.toast("已更新为「" + one.label + "」", "success");
    else CG.toast("账号信息已刷新", "success");
    CG.refresh();
  }).catch(CG.showErr);
}
function actRefreshAll(){
  CG.toast("正在刷新全部账号信息…","info",2000);
  CG.api("account.refresh",{}).then(function(r){
    var n = (r && r.refreshed) || 0;
    var bad = ((r && r.results) || []).filter(function(x){ return x.profileError; }).length;
    CG.toast("已刷新 " + n + " 个" + (bad ? "，其中 " + bad + " 个没拿到档案" : ""), bad ? "warning" : "success", 4000);
    CG.refresh();
  }).catch(CG.showErr);
}

function actDeleteAccount(a){
  CG.dialog({
    title:"删除账号", okText:"删除",
    body:h("div",{},[ h("div",{text:"确定删除「"+a.label+"」？此操作不可撤销。"}) ]),
    onOk:function(){ return CG.api("account.delete",{ id:a.id }).then(function(){ CG.toast("已删除","success"); CG.refresh(); }); }
  });
}
`;
