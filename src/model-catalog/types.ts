/** 模型目录的形状：条目、来源、对外状态、OpenAI 形状、句柄 */

export interface CatalogEntry {
  /** 家族 id，比如 claude-opus-5 */
  id: string;
  label: string;
  family: string;
  /** 发给上游的规范 id；老模型带日期后缀 */
  firstParty: string;
}

export type CatalogSource = "builtin" | "remote" | "cache";

export interface ModelCatalogState {
  entries: CatalogEntry[];
  source: CatalogSource;
  /** 远端拉取成功的时间；从内置清单起步时为 null */
  fetchedAt: number | null;
  /** 目录自带的版本号（远端文档里有 version 字段） */
  version: number | null;
  error: string | null;
}

export interface OpenAIModelEntry {
  id: string;
  object: "model";
  created: number;
  owned_by: string;
  /** 非标准字段，方便面板/客户端看出这是什么档位 */
  display_name?: string;
  family?: string;
  /**
   * 上下文窗口与最大输出。来自 MODEL_LIMITS 配置，没配就不带这两个字段。
   * 客户端开了 CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY 时会读它，
   * 从而按模型决定自动压缩线 —— 这是比每台机器配
   * CLAUDE_CODE_AUTO_COMPACT_WINDOW 更干净的那条路。
   */
  context_window?: number;
  max_output_tokens?: number;
}

export interface ModelCatalogHandle {
  /** 当前快照。永远同步返回，不出网 */
  get(): ModelCatalogState;
  /** 懒加载：过期就在后台刷，立即返回当前快照 */
  ensure(): ModelCatalogState;
  /** 强制刷新，等结果 */
  refresh(): Promise<ModelCatalogState>;
  list(): OpenAIModelEntry[];
  /** 这个模型 id 认不认（别名、日期后缀、[1m] 后缀都算过） */
  accepts(model: string | undefined | null): boolean;
  /** 解析成目录里的条目；认不出来返回 null */
  resolve(model: string | undefined | null): CatalogEntry | null;
  /** 正在刷新？ */
  refreshing(): boolean;
  /** 设置隐藏清单（面板里勾掉的那些）。传进来的 id 会归一后再比 */
  setDisabled(ids: string[]): void;
  /** 当前隐藏清单（归一后的 key） */
  disabled(): string[];
  /** 目录里全部模型，含被隐藏的 */
  all(): CatalogEntry[];
  /** 这个模型是不是被隐藏了 */
  isHidden(id: string): boolean;
}

/** Claude Code 就是这么比的：去掉尾部 -YYYYMMDD */

