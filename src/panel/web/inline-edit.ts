/**
 * 面板运行时 · 就地编辑
 *
 * 从原来的面板单文件里拆出来的片段。它只是一段字符串：面板零依赖、零构建，
 * 服务端把片段按 index.ts 里的顺序拼成一个 bundle 再下发给浏览器。
 */
export const INLINE_EDIT_JS = String.raw`
/* ============ 就地编辑 ============ */
/** 点一下就变成输入框。Enter 或失焦保存，Esc 取消。 */
function inlineEdit(value, onSave, opt){
  opt = opt || {};
  var span = h("span",{class:"cg-inline",title:opt.title||"点击修改",text:String(value)});
  span.addEventListener("click", function(){
    if(span.__editing) return;
    span.__editing = true;
    var input = h("input",{class:"el-input__inner",value:String(value),placeholder:opt.placeholder||""});
    input.style.height = "24px";
    input.style.fontSize = "var(--el-font-size-extra-small)";
    var wrap = h("span",{class:"cg-inline-edit"},[input]);
    span.parentNode.replaceChild(wrap, span);
    input.focus();
    input.select();
    var done = false;
    function finish(save){
      if(done) return;
      done = true;
      var next = String(input.value).trim();
      if(!save || !next || next === String(value)){
        if(wrap.parentNode) wrap.parentNode.replaceChild(span, wrap);
        span.__editing = false;
        return;
      }
      input.disabled = true;
      Promise.resolve(onSave(next)).then(function(){
        span.textContent = next;
        value = next;
        if(wrap.parentNode) wrap.parentNode.replaceChild(span, wrap);
        span.__editing = false;
      }).catch(function(e){
        showErr(e);
        if(wrap.parentNode) wrap.parentNode.replaceChild(span, wrap);
        span.__editing = false;
      });
    }
    input.addEventListener("keydown", function(e){
      if(e.key === "Enter"){ e.preventDefault(); finish(true); }
      else if(e.key === "Escape"){ e.preventDefault(); finish(false); }
    });
    input.addEventListener("blur", function(){ finish(true); });
  });
  return span;
}
`;
