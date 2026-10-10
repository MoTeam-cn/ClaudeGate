/**
 * 面板运行时 · 接口调用
 *
 * 从原来的面板单文件里拆出来的片段。它只是一段字符串：面板零依赖、零构建，
 * 服务端把片段按 index.ts 里的顺序拼成一个 bundle 再下发给浏览器。
 */
export const NET_JS = String.raw`
/* ============ 接口 ============ */
function api(action, params){
  /* action 可能带查询串（logs.requests?limit=50），它必须留在 URL 上，
     不能整个 encodeURIComponent 进 action 参数，否则后端认不出来 */
  var qi = action.indexOf("?");
  var name = qi === -1 ? action : action.slice(0, qi);
  var extra = qi === -1 ? "" : "&" + action.slice(qi + 1);
  var q = "action=" + encodeURIComponent(name) + extra;
  var body = params ? JSON.stringify(params) : null;
  var hdrs = authHeaders();
  if(body) hdrs["content-type"] = "application/json";
  return fetch("/panel/api?" + q, {
    method: body ? "POST" : "GET",
    headers: hdrs,
    body: body
  }).then(function(r){
    /* 令牌失效或缺失：清掉本地的，重新问，问到了再刷一遍当前页。
       这里不再往下走错误分支，免得同时弹窗又弹 toast */
    if(r.status === 401){
      clearToken();
      askToken("登录密钥无效或已过期，请重新输入").then(function(){ refresh(); });
    }
    return r.text().then(function(t){
      var d = null;
      try { d = JSON.parse(t); } catch(e){}
      if(!r.ok){
        /* 后端的错误是 {error:{message,code}}，直接拼对象会显示 [object Object] */
        var msg = null;
        if(d && d.error){
          msg = (typeof d.error === "string") ? d.error : (d.error.message || d.error.code);
        }
        throw new Error(msg || d && d.message || ("HTTP " + r.status));
      }
      /* 有的接口把结果放在 data 里（overview/accounts/settings…），
         有的直接摊在顶层（logs.requests 的 rows/total），统一在这里抹平 */
      return (d && d.data !== undefined) ? d.data : d;
    });
  });
}
`;
