/**
 * 面板运行时 · 消息提示
 *
 * 从原来的面板单文件里拆出来的片段。它只是一段字符串：面板零依赖、零构建，
 * 服务端把片段按 index.ts 里的顺序拼成一个 bundle 再下发给浏览器。
 */
export const TOAST_JS = String.raw`
/* ============ 消息提示 ============ */
function toast(msg, type, ms){
  var box = $("#messages");
  if(!box){ box = h("div",{id:"messages",class:"cg-messages"}); document.body.appendChild(box); }
  var icons = { success:"✓", warning:"!", error:"✕", info:"i" };
  var t = type || "info";
  var el = h("div",{class:"el-message el-message--"+t}, [ h("span",{text:icons[t]||"i"}), h("span",{text:String(msg)}) ]);
  box.appendChild(el);
  setTimeout(function(){
    el.className += " is-out";
    setTimeout(function(){ if(el.parentNode) el.parentNode.removeChild(el); }, 220);
  }, ms || (t==="error" ? 6000 : 3000));
}
function showErr(e){ toast(e && e.message ? e.message : String(e), "error"); }
`;
