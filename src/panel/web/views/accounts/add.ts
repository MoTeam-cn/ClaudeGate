/** 号池 · 添加账号与 OAuth 授权流程 */
export const ACCOUNTS_ADD_JS = String.raw`function openAddAccount(){
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
`;
