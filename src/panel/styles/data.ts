/**
 * 面板样式 · 数据展示
 */
export const DATA_CSS = `
/* ============ 表格 ============ */
/*
 * 表格自己有内滚动高度。之前只有 overflow-x，纵向不滚，于是行一多就把整页顶高，
 * 侧栏是 sticky 100vh，内容却越长越长，滚动条一路到底 —— 很难看。
 * overscroll-behavior:contain 让滚到表格尽头时不要把滚动传给整页。
 */
.el-table-wrap{
  width:100%;max-height:var(--cg-table-max-h,60vh);overflow:auto;
  -webkit-overflow-scrolling:touch;overscroll-behavior:contain;
}
/* 表头整块吸顶。用 thead 而不是只钉 th —— 筛选行也在 thead 里，得跟着一起钉住 */
.el-table thead{position:sticky;top:0;z-index:3}
/* 吸顶后下面的分隔线会跟着滚走，用阴影补一条 */
.el-table thead tr:last-child > *{box-shadow:inset 0 -1px 0 var(--el-border-color-lighter)}
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
`;
