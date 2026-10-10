/**
 * 面板样式 · 表格工具条与单元格
 */
export const WIDGETS_CSS = `
/* ============ 工具类 ============ */
.cg-mt{margin-top:12px}
.cg-mb{margin-bottom:12px}
.cg-row{display:flex;gap:12px;flex-wrap:wrap;align-items:flex-end}
.cg-col{flex:1;min-width:0}
.cg-stack{display:flex;flex-direction:column;gap:8px}
.cg-code{background:var(--el-fill-color-light);border:1px solid var(--el-border-color-lighter);border-radius:var(--el-border-radius-base);padding:10px 12px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:var(--el-font-size-extra-small);white-space:pre-wrap;word-break:break-all;max-height:320px;overflow:auto}


/* ============ 表格工具条：筛选栏 ============ */
/*
 * 筛选控件原先塞在表头下面那一行里。那一行没有列宽约束，和表头各排各的，
 * 列一多整行全是裸输入框，也看不出哪个框筛哪列。现在提到表格上方做成工具栏：
 * 每个控件带列名标签，右侧显示生效条数与清除按钮。
 */
.cg-table-host{display:flex;flex-direction:column;min-width:0}
.cg-filterbar{
  display:flex;flex-wrap:wrap;align-items:flex-end;gap:10px 16px;
  padding:10px 14px 12px;
  border-bottom:1px solid var(--el-border-color-lighter);
  background:var(--el-fill-color-lighter);
}
.cg-filterbar.hidden{display:none}
.cg-filterbar.is-active{background:var(--el-color-primary-light-9);border-bottom-color:var(--el-color-primary-light-8)}
.cg-filterbar__item{display:flex;flex-direction:column;gap:5px;min-width:0}
.cg-filterbar__label{font-size:var(--el-font-size-extra-small);line-height:1;color:var(--el-text-color-secondary);white-space:nowrap}
.cg-filterbar__control{height:28px!important;width:132px;min-width:132px;padding:0 8px!important;font-size:var(--el-font-size-extra-small)!important}
.cg-filterbar__control.cg-select{width:auto;min-width:132px}
.cg-filterbar__control.cg-select .cg-select__inner{height:28px!important;padding:0 8px!important;font-size:var(--el-font-size-extra-small)!important}
.cg-filterbar__control.cg-select .cg-select__arrow{border-top-width:4px}
.cg-filterbar__tail{margin-left:auto;display:flex;align-items:center;gap:10px}
.cg-filterbar__count{font-size:var(--el-font-size-extra-small);color:var(--el-color-primary);white-space:nowrap}
.cg-filterbar .el-button--text{height:28px;padding:0 4px;font-size:var(--el-font-size-extra-small)}

/* ============ 用量计量条 ============ */
/* 一个窗口两行：名字 · 百分比 · 重置时间，下面一条细进度条。
   原先拆成三行且左右不齐，号池里两个窗口叠起来把整行撑得很高。 */
.cg-usage{display:flex;flex-direction:column;gap:10px;min-width:196px}
.cg-meter{display:flex;flex-direction:column;gap:4px}
.cg-meter__head{display:flex;align-items:center;gap:6px;font-size:var(--el-font-size-extra-small);line-height:1.2}
.cg-meter__name{color:var(--el-text-color-secondary);white-space:nowrap}
.cg-meter__now{
  flex:0 0 auto;padding:0 5px;height:15px;line-height:15px;border-radius:7px;
  font-size:10px;color:var(--el-color-success);background:var(--el-color-success-light-9);
  border:1px solid var(--el-color-success-light-7);
}
.cg-meter__pct{margin-left:auto;font-variant-numeric:tabular-nums;font-weight:500;color:var(--el-text-color-primary)}
.cg-meter__pct.is-empty{color:var(--el-text-color-placeholder);font-weight:400}
.cg-meter__reset{color:var(--el-text-color-placeholder);font-variant-numeric:tabular-nums;white-space:nowrap}
.cg-meter__bar{height:5px;border-radius:3px;background:var(--el-fill-color);overflow:hidden}
.cg-meter__inner{height:100%;border-radius:3px;transition:width var(--el-transition-duration)}
.cg-meter__inner.is-success{background:var(--el-color-success)}
.cg-meter__inner.is-warning{background:var(--el-color-warning)}
.cg-meter__inner.is-danger{background:var(--el-color-danger)}
/* 表格里的行内按钮：紧凑、靠右、不换行成一列孤零零的「删除」 */
.el-table td{vertical-align:middle}
/* 行内按钮：一行放得下就不换行；窄屏实在放不下才折 */
.el-table .cg-actions{display:flex;gap:5px;flex-wrap:wrap;justify-content:flex-end;margin-top:0}
.el-table .cg-actions .el-button{height:25px;padding:0 8px;font-size:var(--el-font-size-extra-small);white-space:nowrap}
.cg-th__label{display:inline-flex;align-items:center;gap:4px}
.el-table .cg-col-check{width:34px;padding-left:10px;padding-right:0}
.el-table .cg-col-check input{width:14px;height:14px;cursor:pointer;accent-color:var(--el-color-primary)}
.el-table tbody tr.is-selected td{background:var(--el-color-primary-light-9)!important}
.cg-batchbar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:8px 12px;margin-bottom:8px;border-radius:var(--el-border-radius-base);background:var(--el-color-primary-light-9);border:1px solid var(--el-color-primary-light-8)}
.cg-batchbar__n{font-size:var(--el-font-size-small);color:var(--el-color-primary);font-weight:500;margin-right:4px}
/* ============ 「更多」下拉 ============ */
/* 主行只留常用按钮，其余收进这里。弹层挂 body + fixed，表格的 overflow 裁不到 */
.el-dropdown-menu{
  background:var(--el-bg-color-overlay);border:1px solid var(--el-border-color-light);
  border-radius:var(--el-border-radius-base);box-shadow:var(--el-box-shadow-light);
  padding:4px;z-index:3000;
}
.el-dropdown-menu__item{
  padding:6px 10px;border-radius:var(--el-border-radius-base);font-size:var(--el-font-size-small);
  color:var(--el-text-color-regular);cursor:pointer;white-space:nowrap;
  display:flex;align-items:center;gap:6px;
}
.el-dropdown-menu__item:hover{background:var(--el-fill-color-light);color:var(--el-text-color-primary)}
.el-dropdown-menu__item.is-danger{color:var(--el-color-danger)}
.el-dropdown-menu__item.is-danger:hover{background:var(--el-color-danger-light-9)}
.cg-more{display:inline-flex;align-items:center}
.cg-more__btn{min-width:30px;padding:0 6px!important;line-height:1;letter-spacing:0}
.cg-more__dots{font-size:15px;line-height:1;display:block;margin-top:-4px}
.cg-more.is-open .cg-more__btn{border-color:var(--el-color-primary);color:var(--el-color-primary)}
.cg-more__drop{position:fixed;min-width:140px;max-height:60vh;overflow:auto}
.cg-more__sep{height:1px;margin:4px 2px;background:var(--el-border-color-lighter)}

/* ============ 列对齐 ============ */
.el-table th.is-right,.el-table td.is-right{text-align:right}
.el-table th.is-center,.el-table td.is-center{text-align:center}
.el-table td.is-right .cell{text-align:right}
.el-table td.is-center .cell{text-align:center}

/* ============ 筛选栏里的文本筛选 ============ */
.cg-filterbar__field{position:relative;display:inline-flex;align-items:center}
.cg-filterbar__field .cg-filterbar__control{padding-right:22px!important}
.cg-filterbar__clear{
  position:absolute;right:2px;top:50%;transform:translateY(-50%);
  width:18px;height:18px;padding:0;line-height:1;border:0;border-radius:50%;
  background:transparent;color:var(--el-text-color-placeholder);
  font-size:10px;cursor:pointer;display:none;
}
.cg-filterbar__field.has-value .cg-filterbar__clear{display:block}
.cg-filterbar__clear:hover{background:var(--el-fill-color);color:var(--el-text-color-primary)}

/* ============ 表格密度 ============ */
.el-table--dense th{padding:8px 10px}
.el-table--dense td{padding:7px 10px}
.el-table-wrap.is-free{max-height:none}

/* ============ 单元格内容 ============ */
/* 一行里的主次信息：主行正常色，次行小字灰。代替到处写内联 style */
.cg-cell{display:flex;flex-direction:column;gap:3px;min-width:0}
.cg-cell__main{color:var(--el-text-color-primary);overflow:hidden;text-overflow:ellipsis}
.cg-cell__sub{font-size:var(--el-font-size-extra-small);color:var(--el-text-color-secondary);overflow:hidden;text-overflow:ellipsis}
.cg-cell__bad{font-size:var(--el-font-size-extra-small);color:var(--el-color-danger)}
.cg-cell--right{align-items:flex-end;text-align:right}
.cg-mono-chip{
  font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
  font-size:var(--el-font-size-extra-small);color:var(--el-text-color-secondary);
  background:var(--el-fill-color-light);border:1px solid var(--el-border-color-lighter);
  border-radius:var(--el-border-radius-base);padding:1px 6px;cursor:copy;white-space:nowrap;
}
.cg-mono-chip:hover{color:var(--el-text-color-primary);border-color:var(--el-border-color)}
.cg-num{font-variant-numeric:tabular-nums}
.cg-inline{cursor:text;border-bottom:1px dashed transparent;transition:border-color var(--el-transition-duration-fast)}
.cg-inline:hover{border-bottom-color:var(--el-border-color-darker)}
.cg-inline-edit{display:inline-block;min-width:120px}
.cg-inline-edit .el-input__inner{height:24px;font-size:var(--el-font-size-extra-small);padding:0 7px}
`;
