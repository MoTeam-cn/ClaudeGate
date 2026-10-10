/**
 * 面板视图 · 设置
 *
 * 从原来的面板单文件里拆出来的片段。它只是一段字符串：面板零依赖、零构建，
 * 服务端把片段按 index.ts 里的顺序拼成一个 bundle 再下发给浏览器。
 */
export const SETTINGS_JS = String.raw`
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
    /* 先亮出「配置里到底解析出什么代理」。之前这里只说「没有配置出站代理」，
       但不说它读到了什么，排查时只能干瞪眼 */
    out.appendChild(line("出站代理", r.proxy || "（未配置）", r.proxyConfigured ? null : "warning"));
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
      CG.paint(host, ["guardMode","stegoMode","reqIdInResponse","injectMissing","logRetentionDays","runtimeLogMax"].map(function(k){ return s[k]; }).join("|"), function(host){
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
      host.appendChild(limitsCard());
      return s;
    });
    });
  });
}

/* 模型上下文限制卡片。每个模型一行：上下文窗口 + 最大输出。
   留空 = 用兜底；兜底也留空 = 不限制。 */
function limitsCard(){
  var out = h("div",{});
  var btn = h("button",{class:"el-button el-button--primary",type:"button",text:"保存"});
  var rows = [];
  var fbCtx = null, fbOut = null;

  function numInput(v){
    return h("input",{class:"el-input__inner",type:"number",min:"0",step:"1000",
      style:{width:"104px",flex:"0 0 104px"},
      value: v===null||v===undefined ? "" : String(v)});
  }
  function paint(r){
    CG.paint(out, r, function(out){
      rows = [];
      fbCtx = numInput(r.fallback ? r.fallback.context : null);
      fbOut = numInput(r.fallback ? r.fallback.maxOutput : null);
      out.appendChild(h("div",{class:"el-form-item"},[
        h("div",{class:"el-form-item__label",text:"兜底（没单独配的模型都用它）"}),
        h("div",{style:{display:"flex",gap:"8px"}},[ fbCtx, fbOut ])
      ]));
      var wrap = h("div",{style:{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(330px,1fr))",gap:"6px"}});
      for(var i=0;i<(r.models||[]).length;i++){
        (function(m){
          var c = numInput(m.context);
          var o = numInput(m.maxOutput);
          rows.push({ id:m.id, ctx:c, out:o });
          wrap.appendChild(h("div",{style:{display:"flex",alignItems:"center",gap:"6px"}},[
            h("span",{style:{flex:"1 1 auto",minWidth:"0",fontSize:"12px",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"},
              title:m.id + "  →  生效 " + (m.effContext===null||m.effContext===undefined ? "不限制" : m.effContext),
              text:m.label + " · " + m.id}),
            c, o
          ]));
        })(r.models[i]);
      }
      out.appendChild(h("div",{class:"el-form-item__label",style:{marginTop:"12px"},text:"每个模型单独配（留空 = 用兜底）"}));
      out.appendChild(wrap);
      out.appendChild(h("div",{style:{marginTop:"10px"}},[ btn ]));
    });
  }
  function load(){ return CG.api("models.limits",{}).then(paint); }

  btn.addEventListener("click", function(){
    var limits = {};
    function put(k, c, o){
      var cv = Number(c.value), ov = Number(o.value);
      if(!c.value || !(cv>0)) return;
      limits[k] = { context:cv, maxOutput: o.value && ov>0 ? ov : null };
    }
    put("*", fbCtx, fbOut);
    for(var i=0;i<rows.length;i++) put(rows[i].id, rows[i].ctx, rows[i].out);
    btn.disabled = true;
    CG.api("models.limits.save",{ limits:limits }).then(function(r){
      paint(r); CG.toast("模型限制已保存（"+Object.keys(limits).length+" 项）","success");
    }).catch(CG.showErr).then(function(){ btn.disabled = false; });
  });

  load().catch(function(){});
  return card("模型上下文", h("div",{},[
    h("div",{class:"tiny muted",style:{lineHeight:"1.7"},
      text:"每个模型的上下文窗口与最大输出。超过「窗口 × (1 + 容差)」的请求会被拒绝 —— 客户端没及时压缩时的兜底。最大输出目前只对外声明、不做限制。"}),
    out
  ]));
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
`;
