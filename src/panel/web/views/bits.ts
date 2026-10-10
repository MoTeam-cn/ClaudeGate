/**
 * 面板视图 · 公共零件
 *
 * 从原来的面板单文件里拆出来的片段。它只是一段字符串：面板零依赖、零构建，
 * 服务端把片段按 index.ts 里的顺序拼成一个 bundle 再下发给浏览器。
 */
export const BITS_JS = String.raw`
function card(title, body, actions){
  return h("div",{class:"el-card"},[
    title ? h("div",{class:"el-card__header"},[ h("h2",{text:title}), h("div",{class:"sp"}) ].concat(actions||[])) : null,
    h("div",{class:"el-card__body"},[body])
  ]);
}
function stat(k, v, cls){
  return h("div",{class:"cg-stat"},[ h("div",{class:"k",text:k}), h("div",{class:"v "+(cls||""),text:v}) ]);
}
function tag(text, type){
  return h("span",{class:"el-tag el-tag--"+(type||"info")},[ h("span",{class:"dot"}), h("span",{text:String(text)}) ]);
}
/**
 * 一行计量条：名字 · 百分比 · 重置时间，下面一条细进度条。
 *
 * 原先名字和百分比分成两行、进度条再占一行，一个窗口就三行高；
 * 号池里两个窗口叠起来，整行被撑得很高、左右还不对齐。现在压成两行、列对齐。
 */
/** 计量条里的重置时间要短。CG.fmtTime 给的是完整年月日时分秒，列里太占地方 */
function shortTime(sec){
  var d = new Date(sec*1000);
  function p(n){ return (n<10?"0":"")+n; }
  return p(d.getMonth()+1)+"-"+p(d.getDate())+" "+p(d.getHours())+":"+p(d.getMinutes());
}
function usageRow(name, w, active){
  var pct = (w && w.utilization!==null && w.utilization!==undefined)
    ? Math.round(w.utilization*1000)/10
    : null;
  var row = h("div",{class:"cg-meter"});
  var head = h("div",{class:"cg-meter__head"});
  var nm = h("span",{class:"cg-meter__name",text:name});
  head.appendChild(nm);
  if(active) head.appendChild(h("span",{class:"cg-meter__now",text:"当前"}));
  head.appendChild(h("span",{class:"cg-meter__pct"+(pct===null?" is-empty":""),text:pct===null?"—":pct+"%"}));
  if(w && w.resetsAt) head.appendChild(h("span",{class:"cg-meter__reset",title:CG.fmtTime(w.resetsAt*1000),text:shortTime(w.resetsAt)}));
  row.appendChild(head);
  var bar = h("div",{class:"cg-meter__bar"});
  if(pct!==null){
    var cls = w.status==="rejected" ? "is-danger" : (pct>=90?"is-danger":(pct>=70?"is-warning":"is-success"));
    bar.appendChild(h("div",{class:"cg-meter__inner "+cls,style:{width:Math.max(0,Math.min(100,pct))+"%"}}));
  }
  row.appendChild(bar);
  return row;
}
/* 额度窗口的展示名与排序。usageCell 与「加号后自动查额度」的提示共用一份 */
var WINDOW_LABELS = {
  /* 老形状（rate_limits.<name>） */
  five_hour:"5 小时", seven_day:"7 天", seven_day_opus:"7 天 Opus",
  seven_day_sonnet:"7 天 Sonnet", seven_day_overage_included:"7 天含溢出",
  seven_day_oauth_apps:"7 天 OAuth 应用", overage:"溢出额度",
  /* 新形状（limits[].kind）。二进制里原文引用：
       "The server\u0027s meter kind, e.g. \u0027session\u0027, \u0027weekly_all\u0027 or \u0027weekly_scoped\u0027"
     之前漏了这三个，面板上直接显示英文原名。 */
  session:"5 小时", weekly_all:"每周总额", weekly_scoped:"每周（分模型）"
};
var WINDOW_ORDER = ["session","weekly_all","weekly_scoped","five_hour","seven_day","seven_day_opus","seven_day_sonnet",
  "seven_day_overage_included","seven_day_oauth_apps","overage"];
var DIM_LABELS = { requests:"请求数", tokens:"令牌数", "input-tokens":"输入令牌", "output-tokens":"输出令牌" };
function windowLabel(k){
  if(WINDOW_LABELS[k]) return WINDOW_LABELS[k];
  if(k.indexOf("dim:")===0){
    var d = k.slice(4);
    return DIM_LABELS[d] || d;
  }
  return k;
}
function sortWindows(keys){
  return keys.slice().sort(function(x,y){
    var ix=WINDOW_ORDER.indexOf(x), iy=WINDOW_ORDER.indexOf(y);
    if(ix===-1) ix=99; if(iy===-1) iy=99;
    return ix-iy || (x<y?-1:1);
  });
}
/** 把一次用量快照压成一行短提示，用于 toast */
function usageSummary(u){
  if(!u) return null;
  if(!u.ok) return { text:"额度查询失败："+(u.error||"未知原因"), type:"warning" };
  var w = u.windows || {};
  var keys = sortWindows(Object.keys(w));
  if(!keys.length) return { text:"已查到额度，但没有可用窗口", type:"info" };
  var parts = keys.slice(0,3).map(function(k){
    var o = w[k]||{};
    var pct = (o.utilization===null||o.utilization===undefined) ? "—" : (Math.round(o.utilization*1000)/10+"%");
    return windowLabel(k)+" "+pct;
  });
  return { text:"额度："+parts.join(" · "), type:"info" };
}
function usageCell(a){
  var u = a.usage || { windows:{} };
  var keys = Object.keys(u.windows||{});
  if(!keys.length){
    var msg = u.error ? "查询失败" : (u.source==="headers" ? "等待响应头" : "无数据");
    return h("span",{class:"muted tiny",text:msg});
  }
  var box = h("div",{class:"cg-usage"});
  /* 原始响应挂在单元格上：窗口认出来了却没数字时，只有原文能说清为什么 */
  if(u.raw) box.title = u.raw;
  sortWindows(keys).forEach(function(k){
    var w = u.windows[k]||{};
    var name = windowLabel(k) + (w.scopeLabel ? " · " + w.scopeLabel : "");
    box.appendChild(usageRow(name, w, !!w.isActive));
  });
  return box;
}
function statusTag(a){
  if(a.status==="exhausted") return tag("额度耗尽","danger");
  if(a.status==="error") return tag("出错","danger");
  if(a.status==="disabled") return tag("已停用","info");
  if(a.cooldownUntil && a.cooldownUntil*1000>Date.now()) return tag("冷却中","warning");
  return tag("可用","success");
}
function agoCell(ms){
  if(!ms) return h("span",{class:"muted",text:"-"});
  var s = h("span",{text:CG.fmtAgo(ms)});
  s.setAttribute("data-ago", String(ms));
  s.title = CG.fmtTime(ms);
  return s;
}
`;
