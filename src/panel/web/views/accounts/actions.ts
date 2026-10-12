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

function actDeleteAccount(a){
  CG.dialog({
    title:"删除账号", okText:"删除",
    body:h("div",{},[ h("div",{text:"确定删除「"+a.label+"」？此操作不可撤销。"}) ]),
    onOk:function(){ return CG.api("account.delete",{ id:a.id }).then(function(){ CG.toast("已删除","success"); CG.refresh(); }); }
  });
}
`;
