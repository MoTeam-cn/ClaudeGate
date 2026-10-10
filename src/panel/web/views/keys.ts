/**
 * 面板视图 · API Key
 *
 * 从原来的面板单文件里拆出来的片段。它只是一段字符串：面板零依赖、零构建，
 * 服务端把片段按 index.ts 里的顺序拼成一个 bundle 再下发给浏览器。
 */
export const KEYS_JS = String.raw`
/* ============ API Key ============ */
function renderKeys(box){
  var host = h("div");
  box.appendChild(host);
  CG.onRefresh(function(){
    return CG.api("keys").then(function(list){
      if(!CG.shouldPaint(host, list)) return list;
      CG.clear(host);
      var cols = [
        { key:"name", label:"名称", sortable:true,
          filter:{type:"text",placeholder:"搜名称 / 前缀"},
          filterValue:function(k){ return k.name + " " + k.keyPrefix; },
          render:function(k){
            var cell = h("div",{class:"cg-cell"});
            cell.appendChild(h("div",{class:"cg-cell__main"},[
              CG.inlineEdit(k.name, function(next){ return actRenameKey(k.id, next); }, {title:"点击改名"})
            ]));
            cell.appendChild(h("div",{class:"cg-cell__sub mono",text:k.keyPrefix+"…"}));
            return cell;
          } },
        { key:"enabled", label:"状态", sortable:true,
          filter:{type:"select",placeholder:"全部",options:[{value:"启用",label:"启用"},{value:"停用",label:"停用"}]},
          filterValue:function(k){ return k.enabled?"启用":"停用"; },
          render:function(k){ return tag(k.enabled?"启用":"停用", k.enabled?"success":"info"); } },
        { key:"fingerprintMode", label:"指纹", sortable:true,
          filter:{type:"select",placeholder:"全部",options:[{value:"claude_code",label:"Claude Code"},{value:"passthrough",label:"透传"}]},
          render:function(k){ return tag(k.fingerprintMode==="claude_code"?"Claude Code":"透传", k.fingerprintMode==="claude_code"?"primary":"info"); } },
        { key:"quotaEnabled", label:"配额", align:"center", render:function(k){ return tag(k.quotaEnabled?"已启用":"未启用", k.quotaEnabled?"success":"info"); } },
        { key:"usageToday", label:"今日", sortable:true, align:"right", width:"158px", sortValue:function(k){ return k.usageToday.requests; },
          render:function(k){
            var cell = h("div",{class:"cg-cell cg-cell--right"});
            cell.appendChild(h("div",{class:"cg-cell__main cg-num",text:CG.fmtNum(k.usageToday.requests)+" 次"}));
            cell.appendChild(h("div",{class:"cg-cell__sub cg-num",text:CG.fmtNum(k.usageToday.tokens)+" token"}));
            return cell;
          } },
        { key:"createdAt", label:"创建", sortable:true, render:function(k){ return agoCell(k.createdAt*1000); } },
        /* 重置密钥原本只有函数没有入口 —— 密钥泄露了在面板上换不了，只能删了重建 */
        { key:"act", label:"操作", align:"right", width:"168px", render:function(k){
            var b = h("div",{class:"cg-actions"});
            b.appendChild(h("button",{class:"el-button el-button--small",title:k.enabled?"停用这把 Key":"启用这把 Key",text:k.enabled?"停用":"启用",onclick:function(){ actToggleKey(k); }}));
            b.appendChild(h("button",{class:"el-button el-button--small",title:"设置每日请求 / token / 每分钟上限",text:"配额",onclick:function(){ openKeyQuota(k); }}));
            b.appendChild(CG.moreMenu([
              { label:"重置密钥", title:"换一把新密钥，旧密钥立刻失效，其余配置保留", run:function(){ return actResetKey(k); } },
              { label:"删除 Key", danger:true, title:"删掉这把 Key，使用它的客户端会立刻失效", run:function(){ return actDeleteKey(k); } }
            ]));
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
`;
