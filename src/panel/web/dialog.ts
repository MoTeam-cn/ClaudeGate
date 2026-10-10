/**
 * 面板运行时 · 对话框
 *
 * 从原来的面板单文件里拆出来的片段。它只是一段字符串：面板零依赖、零构建，
 * 服务端把片段按 index.ts 里的顺序拼成一个 bundle 再下发给浏览器。
 */
export const DIALOG_JS = String.raw`
/* ============ 对话框 ============ */
var openDialogs = 0;
function dialog(opt){
  var overlay = h("div",{class:"el-overlay"});
  var dlg = h("div",{class:"el-dialog" + (opt.wide ? " el-dialog--wide" : "")});
  var body = h("div",{class:"el-dialog__body"});
  if(typeof opt.body==="string") body.appendChild(h("div",{html:opt.body}));
  else if(opt.body) body.appendChild(opt.body);

  var okBtn = null;
  function close(){ if(overlay.parentNode){ overlay.parentNode.removeChild(overlay); openDialogs--; } }
  function finish(){ var r = opt.onOk ? opt.onOk() : true; if(r && typeof r.then==="function"){ return r.then(function(v){ if(v!==false) close(); }).catch(function(e){ showErr(e); }); } if(r!==false) close(); }
  if(opt.onOk){
    okBtn = h("button",{class:"el-button el-button--primary",text:opt.okText||"确定",onclick:finish});
  }
  /* noClose：不可关（要令牌时用）。藏掉取消与 ✕，遮罩点击也不关 —— 
     没有令牌就什么都看不到，给个关闭按钮只会让人以为面板坏了 */
  var noClose = !!opt.noClose;
  var foot = h("div",{class:"el-dialog__footer"},[
    (opt.onOk && !noClose) ? h("button",{class:"el-button",text:opt.cancelText||"取消",onclick:close}) : null,
    okBtn,
    (opt.onOk || noClose) ? null : h("button",{class:"el-button el-button--primary",text:"知道了",onclick:close})
  ]);
  dlg.appendChild(h("div",{class:"el-dialog__header"},[
    h("div",{class:"el-dialog__title",text:opt.title||""}),
    noClose ? null : h("button",{class:"el-button el-button--text",text:"✕",onclick:close,style:{fontSize:"14px"}})
  ]));
  dlg.appendChild(body);
  dlg.appendChild(foot);
  overlay.appendChild(dlg);
  overlay.addEventListener("mousedown", function(ev){ if(ev.target===overlay && opt.maskClose!==false && !noClose) close(); });
  document.body.appendChild(overlay);
  openDialogs++;
  var first = $("input,textarea,select", dlg);
  if(first) setTimeout(function(){ first.focus(); }, 30);
  return { close:close, body:body, ok:okBtn };
}
function confirmDialog(msg, title){
  return new Promise(function(resolve){
    dialog({
      title: title || "确认",
      body: h("div",{text:msg}),
      okText:"确定",
      onOk:function(){ resolve(true); }
    });
    /* 取消/关闭都按 false 处理 */
    var t = setTimeout(function(){}, 0); clearTimeout(t);
    resolve.wrap = true;
  });
}
function promptDialog(title, label, value, placeholder){
  return new Promise(function(resolve){
    var input = h("input",{class:"el-input__inner",value:value||"",placeholder:placeholder||""});
    dialog({
      title:title,
      body:h("div",{class:"el-form-item"},[ label?h("div",{class:"el-form-item__label",text:label}):null, input ]),
      okText:"确定",
      onOk:function(){ resolve(input.value); }
    });
  });
}
`;
