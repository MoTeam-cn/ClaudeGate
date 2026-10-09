/**
 * 组件样式：按 Element Plus 的类名与视觉规范手写。
 *
 * 只用类名约定（el-button / el-input / el-table ...），不依赖任何前端框架 ——
 * 面板仍然是零依赖、单进程、无构建。
 */
export const COMPONENTS_CSS = `
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

/* ============ 表格 ============ */
.el-table-wrap{width:100%;overflow-x:auto;-webkit-overflow-scrolling:touch}
.el-table{width:100%;border-collapse:separate;border-spacing:0;font-size:var(--el-font-size-small)}
.el-table th{
  position:sticky;top:0;z-index:2;background:var(--el-fill-color-light);
  color:var(--el-text-color-secondary);font-weight:500;text-align:left;
  padding:10px 12px;border-bottom:1px solid var(--el-border-color-lighter);white-space:nowrap;
}
.el-table th.is-sortable{cursor:pointer;user-select:none}
.el-table th.is-sortable:hover{color:var(--el-color-primary)}
.el-table th .caret{display:inline-block;margin-left:4px;opacity:.45;font-size:9px;line-height:1}
.el-table th.is-sorted .caret{opacity:1;color:var(--el-color-primary)}
.el-table td{padding:10px 12px;border-bottom:1px solid var(--el-border-color-lighter);color:var(--el-text-color-regular);vertical-align:top}
.el-table tbody tr:hover td{background:var(--el-fill-color-light)}
.el-table--striped tbody tr:nth-child(even) td{background:var(--el-fill-color-lighter)}
.el-table--striped tbody tr:nth-child(even):hover td{background:var(--el-fill-color-light)}
.el-table .cell{max-width:420px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.el-table .cell.wrap{white-space:normal;word-break:break-word}
.el-table .cell.clamp{display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;white-space:normal;overflow:hidden}
.el-table .row-danger td{background:var(--el-color-danger-light-9)!important}
.el-table .row-warn td{background:var(--el-color-warning-light-9)!important}
.el-table__empty{text-align:center;padding:40px 0;color:var(--el-text-color-secondary)}

/* ============ 标签 / 徽标 ============ */
.el-tag{
  display:inline-flex;align-items:center;gap:4px;height:22px;padding:0 8px;
  font-size:var(--el-font-size-extra-small);line-height:1;border-radius:var(--el-border-radius-base);
  border:1px solid transparent;white-space:nowrap;
}
.el-tag--primary{background:var(--el-color-primary-light-9);border-color:var(--el-color-primary-light-8);color:var(--el-color-primary)}
.el-tag--success{background:var(--el-color-success-light-9);border-color:var(--el-color-success-light-5);color:var(--el-color-success)}
.el-tag--warning{background:var(--el-color-warning-light-9);border-color:var(--el-color-warning-light-5);color:var(--el-color-warning)}
.el-tag--danger{background:var(--el-color-danger-light-9);border-color:var(--el-color-danger-light-5);color:var(--el-color-danger)}
.el-tag--info{background:var(--el-color-info-light-9);border-color:var(--el-color-info-light-5);color:var(--el-color-info)}
.el-tag.is-round{border-radius:var(--el-border-radius-round)}
.el-tag .dot{width:6px;height:6px;border-radius:50%;background:currentColor}
.el-badge{position:relative;display:inline-flex}
.el-badge__content{
  min-width:16px;height:16px;padding:0 5px;border-radius:8px;background:var(--el-color-danger);
  color:#fff;font-size:11px;line-height:16px;text-align:center;
}

/* ============ 分页 ============ */
.el-pagination{display:flex;align-items:center;gap:6px;flex-wrap:wrap;padding:12px 16px;font-size:var(--el-font-size-small)}
.el-pagination .el-button{height:28px;padding:0 10px;font-size:var(--el-font-size-extra-small)}
.el-pagination .pager-num{min-width:28px;height:28px;padding:0 6px;display:inline-flex;align-items:center;justify-content:center;border-radius:var(--el-border-radius-base);cursor:pointer;color:var(--el-text-color-regular);background:var(--el-fill-color-light)}
.el-pagination .pager-num:hover{color:var(--el-color-primary)}
.el-pagination .pager-num.active{background:var(--el-color-primary);color:#fff}
.el-pagination .total{color:var(--el-text-color-secondary);margin-right:auto}

/* ============ 对话框 / 抽屉 ============ */
.el-overlay{position:fixed;inset:0;background:var(--el-mask-color);backdrop-filter:blur(1px);z-index:2000;display:flex;align-items:flex-start;justify-content:center;overflow-y:auto;padding:60px 16px 40px;animation:cg-fade var(--el-transition-duration-fast)}
@keyframes cg-fade{from{opacity:0}to{opacity:1}}
.el-dialog{
  width:min(560px,100%);background:var(--el-bg-color-overlay);border-radius:var(--el-border-radius-base);
  box-shadow:var(--el-box-shadow-dark);border:1px solid var(--el-border-color-lighter);
  animation:cg-pop var(--el-transition-duration-fast) var(--el-transition-function-fast-bezier);
}
@keyframes cg-pop{from{transform:translateY(-12px);opacity:0}to{transform:none;opacity:1}}
.el-dialog__header{display:flex;align-items:center;gap:8px;padding:16px 20px 8px}
.el-dialog__title{font-size:var(--el-font-size-medium);font-weight:600;flex:1}
.el-dialog__body{padding:8px 20px 16px;color:var(--el-text-color-regular);max-height:62vh;overflow:auto}
.el-dialog__footer{padding:0 20px 18px;display:flex;justify-content:flex-end;gap:8px}
.el-dialog--wide{width:min(860px,100%)}
.el-drawer{position:fixed;top:0;bottom:0;left:0;width:min(240px,80vw);background:var(--el-bg-color-overlay);z-index:2001;box-shadow:var(--el-box-shadow-dark);display:flex;flex-direction:column;animation:cg-slide var(--el-transition-duration-fast)}
@keyframes cg-slide{from{transform:translateX(-100%)}to{transform:none}}

/* ============ 消息提示 ============ */
.cg-messages{position:fixed;top:16px;left:50%;transform:translateX(-50%);z-index:3000;display:flex;flex-direction:column;gap:8px;align-items:center;pointer-events:none}
.el-message{
  display:flex;align-items:center;gap:8px;min-width:200px;max-width:min(560px,92vw);
  padding:10px 14px;border-radius:var(--el-border-radius-base);border:1px solid var(--el-border-color-lighter);
  background:var(--el-bg-color-overlay);box-shadow:var(--el-box-shadow-light);
  font-size:var(--el-font-size-base);pointer-events:auto;
  animation:cg-drop var(--el-transition-duration-fast) var(--el-transition-function-fast-bezier);
}
@keyframes cg-drop{from{transform:translateY(-16px);opacity:0}to{transform:none;opacity:1}}
.el-message.is-out{animation:cg-up var(--el-transition-duration-fast) forwards}
@keyframes cg-up{to{transform:translateY(-16px);opacity:0}}
.el-message--success{border-color:var(--el-color-success-light-5);background:var(--el-color-success-light-9);color:var(--el-color-success)}
.el-message--warning{border-color:var(--el-color-warning-light-5);background:var(--el-color-warning-light-9);color:var(--el-color-warning)}
.el-message--error{border-color:var(--el-color-danger-light-5);background:var(--el-color-danger-light-9);color:var(--el-color-danger)}
.el-message--info{border-color:var(--el-color-info-light-5);background:var(--el-color-info-light-9);color:var(--el-color-info)}

/* ============ 骨架 / 空状态 ============ */
.el-skeleton{display:flex;flex-direction:column;gap:10px}
.el-skeleton__item{height:14px;border-radius:var(--el-border-radius-base);background:linear-gradient(90deg,var(--el-fill-color) 25%,var(--el-fill-color-light) 37%,var(--el-fill-color) 63%);background-size:400% 100%;animation:cg-shimmer 1.4s ease infinite}
@keyframes cg-shimmer{0%{background-position:100% 50%}100%{background-position:0 50%}}
.el-skeleton__item.is-title{height:20px;width:36%}
.el-skeleton__item.is-short{width:60%}
.el-empty{display:flex;flex-direction:column;align-items:center;gap:10px;padding:44px 16px;color:var(--el-text-color-secondary)}
.el-empty svg{width:64px;height:64px;opacity:.45}
.el-empty__text{font-size:var(--el-font-size-base)}

/* ============ 进度条 ============ */
.el-progress{display:flex;flex-direction:column;gap:3px;min-width:110px}
.el-progress__head{display:flex;justify-content:space-between;gap:8px;font-size:var(--el-font-size-extra-small);color:var(--el-text-color-secondary)}
.el-progress__bar{height:6px;border-radius:3px;background:var(--el-fill-color-dark);overflow:hidden}
.el-progress__inner{height:100%;border-radius:3px;background:var(--el-color-primary);transition:width var(--el-transition-duration)}
.el-progress__inner.is-success{background:var(--el-color-success)}
.el-progress__inner.is-warning{background:var(--el-color-warning)}
.el-progress__inner.is-danger{background:var(--el-color-danger)}

/* ============ 描述列表 ============ */
.el-descriptions{display:grid;grid-template-columns:repeat(auto-fit,minmax(340px,1fr));gap:0}
.el-descriptions__cell{display:flex;gap:12px;padding:11px 4px;border-bottom:1px solid var(--el-border-color-lighter);min-width:0}
.el-descriptions__label{flex:0 0 96px;color:var(--el-text-color-secondary);font-size:var(--el-font-size-small)}
.el-descriptions__value{flex:1;min-width:0;word-break:break-all}

/* ============ 统计格 ============ */
.cg-stats{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:12px}
.cg-stat{background:var(--el-fill-color-lighter);border:1px solid var(--el-border-color-lighter);border-radius:var(--el-border-radius-base);padding:12px 14px;min-width:0}
.cg-stat .k{font-size:var(--el-font-size-extra-small);color:var(--el-text-color-secondary);margin-bottom:6px}
.cg-stat .v{font-size:22px;font-weight:600;line-height:1.1;font-variant-numeric:tabular-nums}
.cg-stat .v.ok{color:var(--el-color-success)}
.cg-stat .v.warn{color:var(--el-color-warning)}
.cg-stat .v.bad{color:var(--el-color-danger)}

/* ============ 开关 ============ */
.el-switch{position:relative;display:inline-flex;align-items:center;cursor:pointer;user-select:none;flex:0 0 auto}
.el-switch input{position:absolute;opacity:0;width:0;height:0}
.el-switch__core{width:40px;height:20px;border-radius:10px;background:var(--el-border-color);transition:background var(--el-transition-duration-fast);position:relative}
.el-switch__core::after{content:"";position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:#fff;transition:left var(--el-transition-duration-fast)}
.el-switch input:checked+.el-switch__core{background:var(--el-color-primary)}
.el-switch input:checked+.el-switch__core::after{left:22px}
.el-switch input:disabled+.el-switch__core{opacity:.5;cursor:not-allowed}

/* ============ 标签页 ============ */
.el-tabs__header{display:flex;gap:4px;border-bottom:1px solid var(--el-border-color-lighter);margin-bottom:16px;overflow-x:auto}
.el-tabs__item{padding:0 16px;height:38px;display:inline-flex;align-items:center;font-size:var(--el-font-size-base);color:var(--el-text-color-regular);cursor:pointer;white-space:nowrap;border-bottom:2px solid transparent;margin-bottom:-1px}
.el-tabs__item:hover{color:var(--el-color-primary)}
.el-tabs__item.is-active{color:var(--el-color-primary);border-bottom-color:var(--el-color-primary)}

/* ============ 提示 / 分隔 ============ */
.el-alert{display:flex;gap:10px;padding:10px 14px;border-radius:var(--el-border-radius-base);font-size:var(--el-font-size-small);line-height:1.5;margin-bottom:12px}
.el-alert--info{background:var(--el-color-info-light-9);color:var(--el-text-color-regular);border:1px solid var(--el-border-color-lighter)}
.el-alert--warning{background:var(--el-color-warning-light-9);color:var(--el-color-warning);border:1px solid var(--el-color-warning-light-5)}
.el-alert--danger{background:var(--el-color-danger-light-9);color:var(--el-color-danger);border:1px solid var(--el-color-danger-light-5)}
.el-divider{height:1px;background:var(--el-border-color-lighter);margin:16px 0;border:0}
.cg-kv{display:flex;gap:10px;flex-wrap:wrap;align-items:center}
.cg-actions{display:flex;gap:6px;flex-wrap:wrap}

/* ============ 工具类 ============ */
.cg-mt{margin-top:12px}
.cg-mb{margin-bottom:12px}
.cg-row{display:flex;gap:12px;flex-wrap:wrap;align-items:flex-end}
.cg-col{flex:1;min-width:0}
.cg-stack{display:flex;flex-direction:column;gap:8px}
.cg-code{background:var(--el-fill-color-light);border:1px solid var(--el-border-color-lighter);border-radius:var(--el-border-radius-base);padding:10px 12px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:var(--el-font-size-extra-small);white-space:pre-wrap;word-break:break-all;max-height:320px;overflow:auto}

/* ============ 移动端 ============ */
@media (max-width:900px){
  :root{--cg-content-pad:12px}
  .cg-side{
    position:fixed;z-index:2001;transform:translateX(-100%);
    transition:transform var(--el-transition-duration);box-shadow:var(--el-box-shadow-dark);
  }
  .cg-side.is-open{transform:none}
  .cg-burger{display:inline-flex}
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
`;
