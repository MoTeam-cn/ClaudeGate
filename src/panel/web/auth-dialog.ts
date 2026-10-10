/**
 * 面板运行时 · 索取登录密钥
 *
 * 从原来的面板单文件里拆出来的片段。它只是一段字符串：面板零依赖、零构建，
 * 服务端把片段按 index.ts 里的顺序拼成一个 bundle 再下发给浏览器。
 */
export const AUTH_DIALOG_JS = String.raw`
/* ============ 要令牌 ============ */
/* 不可关闭：没密钥什么都看不到。先用一次真实请求校验，错的密钥不写进 localStorage。
   密钥首次启动时在日志里打印过一次（cgk_ 开头），忘了就在面板「设置」里重置。 */
var askingToken = null;
function askToken(msg){
  if(askingToken) return askingToken;
  askingToken = new Promise(function(resolve){
    var input = h("input",{class:"el-input__inner",type:"password",placeholder:"cgk_...",autocomplete:"off"});
    var err = h("div",{class:"cg-form-err"});
    var box = h("div",{class:"el-form-item"},[
      h("div",{class:"el-form-item__label",text:msg || "请输入面板登录密钥（首次启动时打印在日志里，cgk_ 开头）"}),
      input, err
    ]);
    function submit(){
      var v = input.value.trim();
      if(!v){ err.textContent = "不能为空"; return Promise.resolve(false); }
      err.textContent = "校验中…";
      return fetch("/panel/api?action=overview", { headers:{ "x-admin-token": v } }).then(function(r){
        if(!r.ok){
          err.textContent = r.status === 401 ? "密钥不对" : ("校验失败 HTTP " + r.status);
          return false;
        }
        err.textContent = "";
        setToken(v);
        askingToken = null;
        resolve(v);
        return true;
      }).catch(function(e){
        err.textContent = String(e && e.message || e);
        return false;
      });
    }
    dialog({
      title:"需要登录密钥",
      body:box,
      maskClose:false,
      noClose:true,
      okText:"进入",
      /* 返回 false 让对话框保持打开 */
      onOk:submit
    });
    input.addEventListener("keydown", function(e){
      if(e.key === "Enter"){ e.preventDefault(); submit(); }
    });
  });
  return askingToken;
}

/** 开关：Element 的 el-switch。返回 {el, input}，input 用来读写选中态 */
function switchBox(checked){
  var input = h("input",{type:"checkbox"});
  input.checked = !!checked;
  var el = h("label",{class:"el-switch"},[ input, h("span",{class:"el-switch__core"}) ]);
  return { el:el, input:input };
}
`;
