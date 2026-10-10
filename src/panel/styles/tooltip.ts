/**
 * 面板样式 · 提示气泡
 */
export const TOOLTIP_CSS = `
/* ============ 提示气泡 ============ */
/* 替代原生 title：延迟可控、样式受控、触屏也能用（focus 时同样弹） */
.cg-tip{
  position:fixed;z-index:4000;max-width:320px;
  padding:6px 10px;border-radius:var(--el-border-radius-base);
  background:var(--el-bg-color-overlay);color:var(--el-text-color-primary);
  border:1px solid var(--el-border-color);box-shadow:var(--el-box-shadow-light);
  font-size:var(--el-font-size-extra-small);line-height:1.55;
  pointer-events:none;word-break:break-word;
}
`;
