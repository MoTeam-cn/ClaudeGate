/** 号池 · 批量导入与各行动作 */
export const ACCOUNTS_ACTIONS_JS = String.raw`function openBatchImport(){
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

/* 刷新凭证：强制换一次 access_token。
   平时由后台巡检自动维护（每 60 秒扫一遍，剩余不足 10 分钟就提前刷），
   这个按钮是手动兜底 —— 怀疑令牌坏了、或巡检报错时用 */
function actRefreshToken(id){
  CG.toast("正在刷新凭证…","info",1500);
  CG.api("account.token",{ id:id }).then(function(r){
    if(r && r.ok){
      var left = r.expiresAt ? Math.max(0, Math.round((r.expiresAt - Date.now()/1000)/60)) : null;
      CG.toast(left === null ? "凭证已刷新" : ("凭证已刷新，剩余 " + left + " 分钟"), "success", 4000);
    }else{
      CG.toast("刷新失败：" + ((r && r.error) || "未知原因"), "error", 6000);
    }
    CG.refresh();
  }).catch(CG.showErr);
}
function actRefreshTokenAll(){
  CG.toast("正在刷新全部凭证…","info",2000);
  CG.api("account.token",{ all:true }).then(function(r){
    var okn = (r && r.refreshed) || 0;
    var bad = (r && r.failed) || 0;
    var skip = (r && r.skipped) || 0;
    var msg = "已刷新 " + okn + " 个";
    if(skip) msg += "，跳过 " + skip + " 个";
    if(bad) msg += "，失败 " + bad + " 个";
    CG.toast(msg, bad ? "warning" : "success", 5000);
    CG.refresh();
  }).catch(CG.showErr);
}

/* 重新授权：refresh_token 失效（上游回 invalid_grant）时唯一能救回来的办法。
   和「添加账号」的区别是把结果**写回这个号**，不是新建 ——
   deviceId 这类指纹绑定跟着保留，不会因为删号重建而换一张脸 */
function actRelogin(a){
  var started = null;
  var linkInput = h("input",{class:"el-input__inner",readonly:"readonly",placeholder:"生成中…"});
  var copyBtn = h("button",{class:"el-button",type:"button",text:"复制"});
  var openBtn = h("button",{class:"el-button el-button--primary",type:"button",text:"打开授权页"});
  copyBtn.disabled = true;
  openBtn.disabled = true;
  var codeInput = h("input",{class:"el-input__inner",placeholder:"形如 xxx#yyy，整段粘进来即可"});

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

  var body = h("div",{},[
    h("div",{class:"el-form-item"},[
      h("div",{class:"el-form-item__label",text:"账号"}),
      h("div",{},[
        h("div",{text:(a.label || a.id) + (a.email ? "（"+a.email+"）" : "")}),
        h("div",{class:"cg-step__hint",text:"新凭证会覆盖到这个号上，备注名与设备指纹都不变。"})
      ])
    ]),
    h("div",{class:"el-form-item"},[
      h("div",{class:"el-form-item__label",text:"授权链接"}),
      h("div",{class:"cg-linkrow"},[ linkInput, copyBtn, openBtn ])
    ]),
    h("div",{class:"el-form-item"},[
      h("div",{class:"el-form-item__label",text:"授权码"}),
      h("div",{},[ codeInput ]),
      h("div",{class:"cg-step__hint",text:"在新标签页登录完成后，页面会显示一段 code，整段复制粘进来即可。"})
    ])
  ]);

  CG.api("oauth.relogin.start",{ id:a.id }).then(function(r){
    started = r;
    linkInput.value = r.authorizeUrl;
    copyBtn.disabled = false;
    openBtn.disabled = false;
    codeInput.focus();
    CG.toast("授权链接已生成，去新标签页完成登录","success");
  }).catch(CG.showErr);

  CG.dialog({
    title:"重新授权", wide:true, body:body, okText:"用这个 code 换新令牌",
    onOk:function(){
      if(!started){ CG.toast("授权链接还没生成","warning"); return false; }
      var code = codeInput.value.trim();
      if(!code){ CG.toast("先把授权码粘进来","warning"); return false; }
      CG.toast("正在换令牌并查询额度…","info",8000);
      return CG.api("oauth.relogin.finish",{ state:started.state, code:code }).then(function(acc){
        if(acc && acc.switched){
          CG.toast("注意：授权到的是另一个号（" + (acc.email || "未知邮箱") + "），原凭证已被覆盖","warning",9000);
        }else{
          CG.toast("凭证已重建，号已恢复","success");
        }
        CG.refresh();
      });
    }
  });
}

function actDeleteAccount(a){
  CG.dialog({
    title:"删除账号", okText:"删除",
    body:h("div",{},[ h("div",{text:"确定删除「"+a.label+"」？此操作不可撤销。"}) ]),
    onOk:function(){ return CG.api("account.delete",{ id:a.id }).then(function(){ CG.toast("已删除","success"); CG.refresh(); }); }
  });
}
`;
