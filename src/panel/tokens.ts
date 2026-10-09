/**
 * 设计 token：照搬 Element Plus 的调色板、间距、圆角与阴影。
 *
 * 单独一份、不带任何选择器，方便以后整体换皮；主题切换靠 <html data-theme>。
 * 变量名保持 el- 前缀，这样从 Element 抄组件样式时不用翻译。
 */
export const TOKENS_CSS = `
:root{
  /* 表格内滚动高度。屏幕矮就调小，想要一屏看更多行就调大 */
  --cg-table-max-h:60vh;
  /* 主色与状态色 —— Element Plus 原值 */
  --el-color-primary:#409eff;
  --el-color-primary-light-3:#79bbff;
  --el-color-primary-light-5:#a0cfff;
  --el-color-primary-light-7:#c6e2ff;
  --el-color-primary-light-8:#d9ecff;
  --el-color-primary-light-9:#ecf5ff;
  --el-color-primary-dark-2:#337ecc;
  --el-color-success:#67c23a;
  --el-color-success-light-3:#95d475;
  --el-color-success-light-5:#b3e19d;
  --el-color-success-light-9:#f0f9eb;
  --el-color-success-dark-2:#529b2e;
  --el-color-warning:#e6a23c;
  --el-color-warning-light-3:#eebe77;
  --el-color-warning-light-5:#f3d19e;
  --el-color-warning-light-9:#fdf6ec;
  --el-color-warning-dark-2:#b88230;
  --el-color-danger:#f56c6c;
  --el-color-danger-light-3:#f89898;
  --el-color-danger-light-5:#fab6b6;
  --el-color-danger-light-9:#fef0f0;
  --el-color-danger-dark-2:#c45656;
  --el-color-error:var(--el-color-danger);
  --el-color-info:#909399;
  --el-color-info-light-3:#b1b3b8;
  --el-color-info-light-5:#c8c9cc;
  --el-color-info-light-9:#f4f4f5;
  --el-color-info-dark-2:#73767a;

  --el-text-color-primary:#303133;
  --el-text-color-regular:#606266;
  --el-text-color-secondary:#909399;
  --el-text-color-placeholder:#a8abb2;
  --el-text-color-disabled:#c0c4cc;
  --el-text-color-primary-inverse:#ffffff;

  --el-border-color:#dcdfe6;
  --el-border-color-light:#e4e7ed;
  --el-border-color-lighter:#ebeef5;
  --el-border-color-extra-light:#f2f6fc;
  --el-border-color-dark:#d4d7de;
  --el-border-color-darker:#cdd0d6;

  --el-fill-color:#f0f2f5;
  --el-fill-color-light:#f5f7fa;
  --el-fill-color-lighter:#fafafa;
  --el-fill-color-extra-light:#fafcff;
  --el-fill-color-dark:#ebedf0;
  --el-fill-color-darker:#e6e8eb;
  --el-fill-color-blank:#ffffff;

  --el-bg-color:#ffffff;
  --el-bg-color-page:#f2f3f5;
  --el-bg-color-overlay:#ffffff;
  --el-mask-color:rgba(255,255,255,.9);

  --el-border-radius-base:4px;
  --el-border-radius-small:2px;
  --el-border-radius-round:20px;
  --el-border-radius-circle:100%;

  --el-box-shadow:0 12px 32px 4px rgba(0,0,0,.04),0 8px 20px rgba(0,0,0,.08);
  --el-box-shadow-light:0 0 12px rgba(0,0,0,.12);
  --el-box-shadow-lighter:0 0 6px rgba(0,0,0,.12);
  --el-box-shadow-dark:0 16px 48px 16px rgba(0,0,0,.08),0 12px 32px rgba(0,0,0,.12),0 8px 16px -8px rgba(0,0,0,.16);

  --el-font-size-extra-large:20px;
  --el-font-size-large:18px;
  --el-font-size-medium:16px;
  --el-font-size-base:14px;
  --el-font-size-small:13px;
  --el-font-size-extra-small:12px;
  --el-font-family:"Helvetica Neue",Helvetica,"PingFang SC","Hiragino Sans GB","Microsoft YaHei",Arial,sans-serif;

  --el-transition-duration:.3s;
  --el-transition-duration-fast:.2s;
  --el-transition-function-ease-in-out-bezier:cubic-bezier(.645,.045,.355,1);
  --el-transition-function-fast-bezier:cubic-bezier(.23,1,.32,1);

  --el-component-size-large:40px;
  --el-component-size:32px;
  --el-component-size-small:24px;

  --cg-sidebar-w:200px;
  --cg-header-h:56px;
  --cg-content-pad:20px;
}

/* 暗色 —— 同样取 Element Plus 的 dark 变量值 */
html[data-theme="dark"]{
  --el-color-primary:#409eff;
  --el-color-primary-light-3:#3375b9;
  --el-color-primary-light-5:#2a598a;
  --el-color-primary-light-7:#213d5b;
  --el-color-primary-light-8:#1d3043;
  --el-color-primary-light-9:#18222c;
  --el-color-primary-dark-2:#66b1ff;
  --el-color-success:#67c23a;
  --el-color-success-light-3:#4e8e2f;
  --el-color-success-light-5:#3e6b27;
  --el-color-success-light-9:#1d3011;
  --el-color-success-dark-2:#85ce61;
  --el-color-warning:#e6a23c;
  --el-color-warning-light-3:#a77730;
  --el-color-warning-light-5:#7d5b28;
  --el-color-warning-light-9:#332c1c;
  --el-color-warning-dark-2:#ebb563;
  --el-color-danger:#f56c6c;
  --el-color-danger-light-3:#b25252;
  --el-color-danger-light-5:#854040;
  --el-color-danger-light-9:#332020;
  --el-color-danger-dark-2:#f78989;
  --el-color-info:#909399;
  --el-color-info-light-3:#6b6d71;
  --el-color-info-light-5:#525457;
  --el-color-info-light-9:#262727;
  --el-color-info-dark-2:#a6a9ad;

  --el-text-color-primary:#e5eaf3;
  --el-text-color-regular:#cfd3dc;
  --el-text-color-secondary:#a3a6ad;
  --el-text-color-placeholder:#8d9095;
  --el-text-color-disabled:#6c6e72;
  --el-text-color-primary-inverse:#141414;

  --el-border-color:#4c4d4f;
  --el-border-color-light:#414243;
  --el-border-color-lighter:#363637;
  --el-border-color-extra-light:#2b2b2c;
  --el-border-color-dark:#58585b;
  --el-border-color-darker:#636466;

  --el-fill-color:#303030;
  --el-fill-color-light:#262727;
  --el-fill-color-lighter:#1d1d1d;
  --el-fill-color-extra-light:#191919;
  --el-fill-color-dark:#39393a;
  --el-fill-color-darker:#424243;
  --el-fill-color-blank:transparent;

  --el-bg-color:#141414;
  --el-bg-color-page:#0a0a0a;
  --el-bg-color-overlay:#1d1e1f;
  --el-mask-color:rgba(0,0,0,.8);

  --el-box-shadow:0 12px 32px 4px rgba(0,0,0,.36),0 8px 20px rgba(0,0,0,.72);
  --el-box-shadow-light:0 0 12px rgba(0,0,0,.72);
  --el-box-shadow-lighter:0 0 6px rgba(0,0,0,.72);
}
`;
