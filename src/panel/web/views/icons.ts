/**
 * 面板视图 · 图标
 *
 * 从原来的面板单文件里拆出来的片段。它只是一段字符串：面板零依赖、零构建，
 * 服务端把片段按 index.ts 里的顺序拼成一个 bundle 再下发给浏览器。
 */
export const ICONS_JS = String.raw`
/* 图标：内联 SVG，避免额外请求 */
function icon(name){
  var p = {
    overview:'<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
    pool:'<ellipse cx="12" cy="6" rx="8" ry="3"/><path d="M4 6v6c0 1.7 3.6 3 8 3s8-1.3 8-3V6"/><path d="M4 12v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6"/>',
    key:'<circle cx="8" cy="15" r="4"/><path d="M11 12l8-8 2 2-2 2 2 2-2 2-2-2-2 2"/>',
    req:'<path d="M4 4h16v16H4z"/><path d="M8 9h8M8 13h8M8 17h4"/>',
    rt:'<path d="M4 5h16v14H4z"/><path d="M7 9l2 2-2 2M11 13h5"/>',
    set:'<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M19.1 4.9L17 7M7 17l-2.1 2.1"/>',
    refresh:'<path d="M21 12a9 9 0 1 1-3-6.7"/><path d="M21 4v5h-5"/>',
    moon:'<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>',
    menu:'<path d="M4 7h16M4 12h16M4 17h16"/>'
  }[name] || "";
  return '<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">' + p + '</svg>';
}
window.CG.icon = icon;
/** 只给 path 内容，用来替换侧栏菜单里已有的 .ico 占位字符 */
window.CG.iconInner = function(name){ return icon(name).replace(/^<svg[^>]*>/, "").replace(/<\/svg>$/, ""); };
`;
