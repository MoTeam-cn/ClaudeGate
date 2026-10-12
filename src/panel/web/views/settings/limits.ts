/** 设置 · 模型上下文限制卡片 */
export const LIMITS_CARD_JS = String.raw`function limitsCard(){
  var out = h("div",{});
  var btn = h("button",{class:"el-button el-button--primary",type:"button",text:"保存"});
  var rows = [];
  var fbCtx = null, fbOut = null;

  var CTX_TIP = "这个模型上游真实能吃的 token 数。请求的输入超过「窗口 × (1 + 容差)」会被网关拒绝（400 context_too_long）。留空 = 用兜底；兜底也留空 = 不限制。";
  var OUT_TIP = "最大输出 token 数。目前只写进 /v1/models 对外声明，不做限制。留空 = 不声明。";
  var W = "112px";

  function numInput(v, tip, ph){
    return h("input",{class:"el-input__inner",type:"number",min:"0",step:"1000",
      style:{width:W,flex:"0 0 " + W},
      title:tip, placeholder:ph,
      value: v===null||v===undefined ? "" : String(v)});
  }
  function colHead(){
    return h("div",{style:{display:"grid",gridTemplateColumns:"1fr " + W + " " + W,gap:"6px",
      fontSize:"12px",color:"var(--el-text-color-secondary)",
      paddingBottom:"4px",borderBottom:"1px solid var(--el-border-color-lighter)",marginBottom:"6px"}},[
      h("span",{text:"模型"}),
      h("span",{text:"上下文窗口",title:CTX_TIP}),
      h("span",{text:"最大输出",title:OUT_TIP})
    ]);
  }
  function legend(){
    function row(k, v){
      return h("div",{style:{display:"grid",gridTemplateColumns:"76px 1fr",gap:"8px",marginTop:"5px"}},[
        h("span",{style:{color:"var(--el-text-color-primary)",whiteSpace:"nowrap"},text:k}),
        h("span",{text:v})
      ]);
    }
    return h("div",{class:"tiny muted",style:{lineHeight:"1.6",marginTop:"14px",
      paddingTop:"9px",borderTop:"1px solid var(--el-border-color-lighter)"}},[
      row("上下文窗口", CTX_TIP),
      row("最大输出", OUT_TIP),
      row("兜底", "没给某个模型单独配时，就用兜底这一行。留空 = 完全不限制，别乱填。")
    ]);
  }
  function guardText(g, hr){
    var pct = Math.round((typeof hr === "number" ? hr : 0) * 100);
    var mult = (1 + (typeof hr === "number" ? hr : 0)).toFixed(2);
    var how = g === "log" ? "只记日志（不拦）" : (g === "off" ? "不检查" : "拒绝请求（400）");
    return "当前：容差 " + pct + "%（输入超过窗口 × " + mult + " 才动手）· 超限处理：" + how + "。容差和处理方式要用环境变量 CONTEXT_HEADROOM / CONTEXT_GUARD 改。";
  }
  function paint(r){
    CG.paint(out, r, function(out){
      rows = [];
      fbCtx = numInput(r.fallback ? r.fallback.context : null, CTX_TIP, "如 256000");
      fbOut = numInput(r.fallback ? r.fallback.maxOutput : null, OUT_TIP, "不限");

      /* 兜底行：内联标签，不依赖列头 */
      out.appendChild(h("div",{class:"el-form-item"},[
        h("div",{class:"el-form-item__label",text:"兜底（没单独配的模型都用它）"}),
        h("div",{style:{display:"flex",gap:"8px",alignItems:"center"}},[
          h("span",{class:"tiny muted",style:{whiteSpace:"nowrap"},text:"窗口"}),
          fbCtx,
          h("span",{class:"tiny muted",style:{whiteSpace:"nowrap",marginLeft:"6px"},text:"输出"}),
          fbOut
        ])
      ]));

      out.appendChild(h("div",{class:"el-form-item__label",style:{marginTop:"14px"},text:"每个模型单独配（留空 = 用兜底）"}));
      out.appendChild(colHead());

      var wrap = h("div",{style:{display:"grid",gridTemplateColumns:"1fr " + W + " " + W,
        gap:"6px",alignItems:"center",maxHeight:"420px",overflowY:"auto"}});
      for(var i=0;i<(r.models||[]).length;i++){
        (function(m){
          var c = numInput(m.context, CTX_TIP, "用兜底");
          var o = numInput(m.maxOutput, OUT_TIP, "不限");
          rows.push({ id:m.id, ctx:c, out:o });
          var eff = (m.effContext===null||m.effContext===undefined) ? "不限制" : (m.effContext + " tokens");
          wrap.appendChild(h("span",{style:{minWidth:"0",fontSize:"12px",overflow:"hidden",
            textOverflow:"ellipsis",whiteSpace:"nowrap"},
            title:m.id + "\n这个模型实际生效的窗口：" + eff + (m.context ? "（本行单独配的）" : "（来自兜底）"),
            text:m.label + " · " + m.id}));
          wrap.appendChild(c);
          wrap.appendChild(o);
        })(r.models[i]);
      }
      out.appendChild(wrap);
      out.appendChild(h("div",{style:{marginTop:"12px"}},[ btn ]));
      out.appendChild(h("div",{class:"tiny muted",style:{marginTop:"10px"},text:guardText(r.guard, r.headroom)}));
      out.appendChild(legend());
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
`;
