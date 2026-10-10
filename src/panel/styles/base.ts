/**
 * 面板样式 · 基础与布局
 */
export const BASE_CSS = `
/* ============ 基础 ============ */
*,*::before,*::after{box-sizing:border-box}
html,body{height:100%}
body{
  margin:0;background:var(--el-bg-color-page);color:var(--el-text-color-primary);
  font:var(--el-font-size-base)/1.5 var(--el-font-family);
  -webkit-font-smoothing:antialiased;
}
a{color:var(--el-color-primary);text-decoration:none}
a:hover{color:var(--el-color-primary-light-3)}
::-webkit-scrollbar{width:6px;height:6px}
::-webkit-scrollbar-thumb{background:var(--el-border-color-darker);border-radius:3px}
::-webkit-scrollbar-track{background:transparent}
.mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
.muted{color:var(--el-text-color-secondary)}
.tiny{font-size:var(--el-font-size-extra-small)}
.nowrap{white-space:nowrap}
.ellipsis{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.hidden{display:none!important}

/* ============ 布局 ============ */
.cg-app{display:flex;min-height:100vh}
.cg-side{
  width:var(--cg-sidebar-w);flex:0 0 var(--cg-sidebar-w);
  background:var(--el-bg-color-overlay);border-right:1px solid var(--el-border-color-lighter);
  display:flex;flex-direction:column;position:sticky;top:0;height:100vh;
}
.cg-brand{display:flex;align-items:center;gap:10px;height:var(--cg-header-h);padding:0 16px;border-bottom:1px solid var(--el-border-color-lighter);flex:0 0 auto}
.cg-brand .dot{width:8px;height:8px;border-radius:50%;background:var(--el-color-success);flex:0 0 auto}
.cg-brand b{font-size:var(--el-font-size-medium);font-weight:600;letter-spacing:.2px}
.cg-brand small{display:block;font-size:11px;color:var(--el-text-color-secondary);line-height:1.2}
.cg-menu{flex:1;overflow-y:auto;padding:8px 0}
.cg-menu-item{
  display:flex;align-items:center;gap:10px;height:44px;margin:2px 8px;padding:0 12px;
  border-radius:var(--el-border-radius-base);color:var(--el-text-color-regular);
  cursor:pointer;user-select:none;transition:background var(--el-transition-duration-fast),color var(--el-transition-duration-fast);
}
.cg-menu-item:hover{background:var(--el-fill-color-light);color:var(--el-text-color-primary)}
.cg-menu-item.active{background:var(--el-color-primary-light-9);color:var(--el-color-primary);font-weight:500}
.cg-menu-item .ico{width:16px;height:16px;flex:0 0 16px}
.cg-menu-item .badge{margin-left:auto}
.cg-side-foot{padding:10px 16px;border-top:1px solid var(--el-border-color-lighter);font-size:11px;color:var(--el-text-color-secondary)}

.cg-main{flex:1;min-width:0;display:flex;flex-direction:column}
.cg-header{
  height:var(--cg-header-h);display:flex;align-items:center;gap:12px;padding:0 var(--cg-content-pad);
  background:var(--el-bg-color-overlay);border-bottom:1px solid var(--el-border-color-lighter);
  position:sticky;top:0;z-index:20;
}
.cg-header h1{margin:0;font-size:var(--el-font-size-medium);font-weight:600}
.cg-header .sub{font-size:var(--el-font-size-extra-small);color:var(--el-text-color-secondary)}
.cg-header .sp{flex:1}
.cg-content{padding:var(--cg-content-pad);flex:1;min-width:0}
.cg-burger{display:none}

/* ============ 卡片 ============ */
.el-card{
  background:var(--el-bg-color-overlay);border:1px solid var(--el-border-color-lighter);
  border-radius:var(--el-border-radius-base);box-shadow:var(--el-box-shadow-lighter);
  margin-bottom:16px;overflow:hidden;
}
.el-card__header{
  padding:14px 18px;border-bottom:1px solid var(--el-border-color-lighter);
  display:flex;align-items:center;gap:10px;flex-wrap:wrap;
}
.el-card__header h2{margin:0;font-size:var(--el-font-size-base);font-weight:600;flex:0 0 auto}
.el-card__header .sp{flex:1}
.el-card__body{padding:18px}
.el-card__body.flush{padding:0}

/* ============ 按钮 ============ */
.el-button{
  display:inline-flex;align-items:center;justify-content:center;gap:6px;
  height:var(--el-component-size);padding:0 15px;font-size:var(--el-font-size-base);
  font-family:inherit;line-height:1;white-space:nowrap;cursor:pointer;user-select:none;
  border:1px solid var(--el-border-color);border-radius:var(--el-border-radius-base);
  background:var(--el-fill-color-blank);color:var(--el-text-color-regular);
  transition:color var(--el-transition-duration-fast),background var(--el-transition-duration-fast),border-color var(--el-transition-duration-fast);
  outline:none;
}
.el-button:hover{color:var(--el-color-primary);border-color:var(--el-color-primary-light-7);background:var(--el-color-primary-light-9)}
.el-button:active{border-color:var(--el-color-primary-dark-2);color:var(--el-color-primary-dark-2)}
.el-button:focus-visible{outline:2px solid var(--el-color-primary-light-5);outline-offset:1px}
.el-button.is-disabled,.el-button:disabled{cursor:not-allowed;opacity:.5;color:var(--el-text-color-disabled);border-color:var(--el-border-color-light);background:var(--el-fill-color-blank)}
.el-button.is-disabled:hover,.el-button:disabled:hover{color:var(--el-text-color-disabled);border-color:var(--el-border-color-light);background:var(--el-fill-color-blank)}
.el-button--primary{background:var(--el-color-primary);border-color:var(--el-color-primary);color:#fff}
.el-button--primary:hover{background:var(--el-color-primary-light-3);border-color:var(--el-color-primary-light-3);color:#fff}
.el-button--primary:active{background:var(--el-color-primary-dark-2);border-color:var(--el-color-primary-dark-2)}
.el-button--success{background:var(--el-color-success);border-color:var(--el-color-success);color:#fff}
.el-button--success:hover{background:var(--el-color-success-light-3);border-color:var(--el-color-success-light-3);color:#fff}
.el-button--warning{background:var(--el-color-warning);border-color:var(--el-color-warning);color:#fff}
.el-button--warning:hover{background:var(--el-color-warning-light-3);border-color:var(--el-color-warning-light-3);color:#fff}
.el-button--danger{background:var(--el-color-danger);border-color:var(--el-color-danger);color:#fff}
.el-button--danger:hover{background:var(--el-color-danger-light-3);border-color:var(--el-color-danger-light-3);color:#fff}
.el-button--info{background:var(--el-color-info);border-color:var(--el-color-info);color:#fff}
.el-button--info:hover{background:var(--el-color-info-light-3);border-color:var(--el-color-info-light-3);color:#fff}
.el-button.is-plain{background:var(--el-color-primary-light-9);border-color:var(--el-color-primary-light-5);color:var(--el-color-primary)}
.el-button--text{border-color:transparent;background:transparent;color:var(--el-color-primary);padding:0 4px;height:auto}
.el-button--text:hover{background:transparent;color:var(--el-color-primary-light-3)}
.el-button--small{height:var(--el-component-size-small);padding:0 9px;font-size:var(--el-font-size-extra-small);border-radius:var(--el-border-radius-small)}
.el-button--large{height:var(--el-component-size-large);padding:0 19px;font-size:var(--el-font-size-medium)}
.el-button.is-round{border-radius:var(--el-border-radius-round)}
.el-button.is-circle{border-radius:var(--el-border-radius-circle);width:var(--el-component-size);padding:0}
.el-button__loading{width:12px;height:12px;border:2px solid currentColor;border-top-color:transparent;border-radius:50%;animation:cg-spin .7s linear infinite}
@keyframes cg-spin{to{transform:rotate(360deg)}}
.el-button-group{display:inline-flex}
.el-button-group .el-button:not(:first-child){margin-left:-1px;border-top-left-radius:0;border-bottom-left-radius:0}
.el-button-group .el-button:not(:last-child){border-top-right-radius:0;border-bottom-right-radius:0}

/* ============ 输入 ============ */
.el-input,.el-select{position:relative;display:inline-flex;align-items:center;width:100%}
.el-input__inner,.el-select__inner{
  width:100%;height:var(--el-component-size);padding:0 11px;font-size:var(--el-font-size-base);
  font-family:inherit;color:var(--el-text-color-regular);
  background:var(--el-fill-color-blank);border:1px solid var(--el-border-color);
  border-radius:var(--el-border-radius-base);outline:none;
  transition:border-color var(--el-transition-duration-fast),box-shadow var(--el-transition-duration-fast);
}
.el-input__inner::placeholder{color:var(--el-text-color-placeholder)}
.el-input__inner:hover,.el-select__inner:hover{border-color:var(--el-border-color-hover,var(--el-text-color-placeholder))}
.el-input__inner:focus,.el-select__inner:focus{border-color:var(--el-color-primary);box-shadow:0 0 0 1px var(--el-color-primary-light-7) inset}
.el-input__inner:disabled{background:var(--el-fill-color-light);color:var(--el-text-color-disabled);cursor:not-allowed}
.el-input--small .el-input__inner{height:var(--el-component-size-small);font-size:var(--el-font-size-extra-small)}
.el-textarea__inner{
  width:100%;min-height:80px;padding:8px 11px;font:var(--el-font-size-base)/1.5 var(--el-font-family);
  color:var(--el-text-color-regular);background:var(--el-fill-color-blank);
  border:1px solid var(--el-border-color);border-radius:var(--el-border-radius-base);outline:none;resize:vertical;
}
.el-textarea__inner:focus{border-color:var(--el-color-primary);box-shadow:0 0 0 1px var(--el-color-primary-light-7) inset}
select.el-input__inner{appearance:none;background-image:linear-gradient(45deg,transparent 50%,var(--el-text-color-placeholder) 50%),linear-gradient(135deg,var(--el-text-color-placeholder) 50%,transparent 50%);background-position:calc(100% - 15px) 14px,calc(100% - 10px) 14px;background-size:5px 5px;background-repeat:no-repeat;padding-right:28px}

/* ============ 表单 ============ */
.el-form-item{display:flex;flex-direction:column;gap:6px;margin-bottom:14px}
.el-form-item__label{font-size:var(--el-font-size-base);color:var(--el-text-color-regular);line-height:1.4}
.el-form-item__label.is-required::before{content:"*";color:var(--el-color-danger);margin-right:4px}
.el-form-item__tip{font-size:var(--el-font-size-extra-small);color:var(--el-text-color-secondary)}
.el-form--inline{display:flex;flex-wrap:wrap;gap:12px;align-items:flex-end}
.el-form--inline .el-form-item{margin-bottom:0;flex-direction:column}
.cg-filters{display:flex;flex-wrap:wrap;gap:12px;align-items:flex-end}
.cg-filters .el-form-item{margin-bottom:0}
.cg-filters .el-form-item__label{font-size:var(--el-font-size-extra-small);color:var(--el-text-color-secondary)}
.cg-filters .el-input,.cg-filters .el-select{width:auto;min-width:120px}
.cg-filters .cg-grow{flex:1;min-width:200px}
.cg-filters .cg-grow .el-input{width:100%}
`;
