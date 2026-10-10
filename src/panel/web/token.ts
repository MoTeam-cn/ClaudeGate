/**
 * 面板运行时 · 管理员令牌
 *
 * 从原来的面板单文件里拆出来的片段。它只是一段字符串：面板零依赖、零构建，
 * 服务端把片段按 index.ts 里的顺序拼成一个 bundle 再下发给浏览器。
 */
export const TOKEN_JS = String.raw`
/* ============ 管理员令牌 ============ */
/* 令牌只存 localStorage，只走 x-admin-token 头。
   不进 URL —— URL 会进浏览器历史、Referer、以及服务端访问日志。 */
var TOKEN = localStorage.getItem("cg_admin") || "";
function setToken(t){ TOKEN = t; localStorage.setItem("cg_admin", t); }
function clearToken(){ TOKEN = ""; localStorage.removeItem("cg_admin"); }
function authHeaders(){
  var hd = {};
  if(TOKEN) hd["x-admin-token"] = TOKEN;
  return hd;
}
`;
