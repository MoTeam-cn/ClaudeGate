/** 设置 · 管理密钥卡片与重置/一次性显示弹窗 */
export const ADMIN_JS = String.raw`
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
`;
