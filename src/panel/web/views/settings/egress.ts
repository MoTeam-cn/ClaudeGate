/** 设置 · 出口/代理卡片 */
export const EGRESS_CARD_JS = String.raw`function egressCard(){
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
`;
