/**
 * 面板运行时 · 骨架与空状态
 *
 * 从原来的面板单文件里拆出来的片段。它只是一段字符串：面板零依赖、零构建，
 * 服务端把片段按 index.ts 里的顺序拼成一个 bundle 再下发给浏览器。
 */
export const SKELETON_JS = String.raw`
/* ============ 骨架 / 空状态 ============ */
function skeleton(rows){
  var box = h("div",{class:"el-skeleton"});
  box.appendChild(h("div",{class:"el-skeleton__item is-title"}));
  for(var i=0;i<(rows||5);i++) box.appendChild(h("div",{class:"el-skeleton__item"+(i%3===2?" is-short":"")}));
  return box;
}
function emptyState(text){
  return h("div",{class:"el-empty"},[
    h("div",{html:'<svg viewBox="0 0 64 64" fill="none" stroke="currentColor" stroke-width="2"><rect x="10" y="18" width="44" height="30" rx="3"/><path d="M10 28h44M22 18v-6h20v6"/></svg>'}),
    h("div",{class:"el-empty__text",text:text||"暂无数据"})
  ]);
}
`;
