/**
 * 面板样式 · 授权卡与移动端
 */
export const AUTH_CSS = `
/* ============ OAuth 授权登录卡 ============ */
.cg-auth{
  border:1px solid var(--el-border-color-lighter);border-radius:var(--el-border-radius-base);
  background:var(--el-fill-color-blank);overflow:hidden;
}
.cg-step{display:flex;gap:10px;padding:12px 14px}
.cg-step + .cg-step{border-top:1px solid var(--el-border-color-lighter)}
.cg-step__no{
  flex:0 0 auto;width:20px;height:20px;border-radius:50%;margin-top:1px;
  background:var(--el-color-primary-light-9);color:var(--el-color-primary);
  border:1px solid var(--el-color-primary-light-7);
  font-size:12px;font-weight:600;line-height:18px;text-align:center;
}
.cg-step.is-done .cg-step__no{
  background:var(--el-color-success-light-9);color:var(--el-color-success);
  border-color:var(--el-color-success-light-7);
}
.cg-step__main{flex:1;min-width:0}
.cg-step__title{font-size:var(--el-font-size-base);font-weight:500;line-height:20px}
.cg-step__hint{font-size:var(--el-font-size-extra-small);color:var(--el-text-color-secondary);line-height:1.7;margin-top:8px}
.cg-actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:10px}
.cg-linkrow{display:flex;gap:8px;align-items:stretch;margin-top:10px}
.cg-linkrow .el-input__inner{
  flex:1;min-width:0;height:32px;
  font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
  font-size:12px;color:var(--el-text-color-regular);
}
.cg-linkrow .el-button{flex:0 0 auto;height:32px;padding:0 12px}
.cg-actions .el-button{height:32px;padding:0 14px}
.cg-step .el-input__inner{height:32px}

/* ============ 下拉框（自绘，替代原生 select）============ */
.cg-select{position:relative;display:block;outline:none}
.cg-select__inner{display:flex;align-items:center;justify-content:space-between;gap:8px;cursor:pointer;user-select:none}
.cg-select__label{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cg-select__label.is-placeholder{color:var(--el-text-color-placeholder)}
.cg-select__arrow{
  flex:0 0 auto;width:0;height:0;border-left:4px solid transparent;border-right:4px solid transparent;
  border-top:5px solid var(--el-text-color-placeholder);transition:transform var(--el-transition-duration);
}
.cg-select.is-open .cg-select__arrow{transform:rotate(180deg)}
.cg-select.is-open .cg-select__inner{border-color:var(--el-color-primary)}
.cg-select:focus-visible .cg-select__inner{border-color:var(--el-color-primary);box-shadow:0 0 0 2px var(--el-color-primary-light-8)}
.cg-select.is-disabled{opacity:.6}
.cg-select.is-disabled .cg-select__inner{cursor:not-allowed;background:var(--el-fill-color-light)}
.cg-select__drop{
  position:fixed;z-index:3000;background:var(--el-bg-color-overlay);
  border:1px solid var(--el-border-color-light);border-radius:var(--el-border-radius-base);
  box-shadow:var(--el-box-shadow-light);padding:6px 0;max-height:264px;overflow-y:auto;
}
.cg-select__empty{padding:8px 16px;font-size:var(--el-font-size-extra-small);color:var(--el-text-color-secondary)}
.el-select-dropdown__item{
  padding:0 16px;height:34px;line-height:34px;font-size:var(--el-font-size-base);
  color:var(--el-text-color-regular);cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
}
.el-select-dropdown__item:hover{background:var(--el-fill-color-light)}
.el-select-dropdown__item.is-selected{color:var(--el-color-primary);font-weight:600;background:var(--el-color-primary-light-9)}
/* 筛选栏里的下拉样式见上方 .cg-filterbar__control 一组 */

/* ============ 移动端 ============ */
@media (max-width:900px){
  /* 手机屏幕矮，表格内高收一收 */
  :root{--cg-table-max-h:52vh}
  .cg-filterbar{padding:10px 12px}
  .cg-inline-edit{min-width:90px}
  :root{--cg-content-pad:12px}
  .cg-side{
    position:fixed;
    z-index:2001;transform:translateX(-100%);
    transition:transform var(--el-transition-duration);box-shadow:var(--el-box-shadow-dark);
  }
  .cg-side.is-open{transform:none}
  .cg-header h1{font-size:var(--el-font-size-base)}
  .cg-header .sub{display:none}
  .cg-scrim{position:fixed;inset:0;background:var(--el-mask-color);z-index:2000}
  .el-table .cell{max-width:220px}
  .el-descriptions{grid-template-columns:1fr}
  .cg-stats{grid-template-columns:repeat(auto-fill,minmax(120px,1fr));gap:8px}
  .cg-stat{padding:10px}
  .cg-stat .v{font-size:18px}
  .el-card__body{padding:12px}
  .el-card__header{padding:12px}
}
/* 表单内的错误提示（要令牌的弹窗用）：跟着 Element 的 danger 色 */
.cg-form-err{min-height:18px;margin-top:6px;font-size:12px;line-height:18px;color:var(--el-color-danger)}
`;
