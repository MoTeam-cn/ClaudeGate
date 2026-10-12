/** 设置 · 模型目录卡片 */
export const MODEL_CARD_JS = String.raw`
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
      text: (SOURCE[r.source]||r.source) + " · 对外 " + r.count + " 个模型" + (r.refreshing ? "（正在刷新…）" : "")}));
    out.appendChild(line("来源", SOURCE[r.source]||r.source));
    out.appendChild(line("模型数", String(r.count)));
    out.appendChild(line("目录版本", r.version===null||r.version===undefined ? "（无）" : String(r.version)));
    out.appendChild(line("上次拉取", stamp(r.fetchedAt)));
    out.appendChild(line("缓存时效", Math.round((r.ttlMs||0)/3600000) + " 小时"));
    out.appendChild(line("模型校验", r.validation==="off" ? "off（不校验）" : "strict（清单外报错）"));
    if(r.error) out.appendChild(line("上次错误", r.error, "warning"));
    out.appendChild(h("div",{class:"tiny muted",style:{marginTop:"8px",lineHeight:"1.7"},
      text:"清单地址：" + r.url}));

    /* 勾选清单。取消勾选 = 从 /v1/models 里拿掉，并且消息接口也拒收 */
    CG.clear(listHost);
    var models = r.models || [];
    var envDisabled = r.envDisabled || [];
    var boxes = [];

    var wrap = h("div",{style:{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(230px,1fr))",gap:"6px",marginTop:"6px"}});
    for(var i=0;i<models.length;i++){
      (function(m){
        var cb = h("input",{type:"checkbox"});
        cb.checked = !m.hidden;
        /* env 里钉死的那些在面板上改不了，摆个禁用框比装作能点更诚实 */
        var locked = envDisabled.indexOf(m.id) >= 0;
        if(locked) cb.disabled = true;
        var lbl = h("label",{style:{display:"flex",alignItems:"center",gap:"6px",fontSize:"12px",
          cursor: locked ? "not-allowed" : "pointer", opacity: locked ? "0.6" : "1"},
          title: m.id + "  →  " + m.firstParty + (locked ? "（被 MODEL_DISABLED 钉死）" : "")},
          [ cb, h("span",{text:m.label + " · " + m.id}) ]);
        wrap.appendChild(lbl);
        boxes.push({ m:m, cb:cb, locked:locked });
      })(models[i]);
    }

    var save = h("button",{class:"el-button el-button--primary el-button--small",type:"button",text:"保存勾选"});
    var all = h("button",{class:"el-button el-button--small",type:"button",text:"全选"});
    var none = h("button",{class:"el-button el-button--small",type:"button",text:"全不选"});
    function setAll(v){ for(var i=0;i<boxes.length;i++){ if(!boxes[i].locked) boxes[i].cb.checked = v; } }
    all.addEventListener("click", function(){ setAll(true); });
    none.addEventListener("click", function(){ setAll(false); });
    save.addEventListener("click", function(){
      var hidden = [];
      for(var i=0;i<boxes.length;i++){ if(!boxes[i].cb.checked) hidden.push(boxes[i].m.id); }
      save.disabled = true;
      CG.api("models.disable",{ ids:hidden }).then(function(nr){
        paint(nr);
        CG.toast("已隐藏 " + hidden.length + " 个，对外 " + nr.count + " 个", "success");
      }).catch(CG.showErr).then(function(){ save.disabled = false; });
    });

    listHost.appendChild(h("div",{class:"el-form-item__label",style:{marginTop:"12px"},
      text:"对外返回哪些模型（取消勾选即隐藏，消息接口也会拒收）"}));
    listHost.appendChild(wrap);
    listHost.appendChild(h("div",{style:{marginTop:"10px",display:"flex",gap:"6px"}}, [ save, all, none ]));
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
`;
