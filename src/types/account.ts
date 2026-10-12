export type AccountKind = "oauth" | "apikey";
export type AccountStatus = "active" | "disabled" | "error" | "exhausted";
export type FingerprintMode = "claude_code" | "passthrough";
export type Outcome = "ok" | "blocked" | "error";

/** 单个限流窗口（5 小时 / 7 天 / 按模型周窗） */
export interface UsageWindow {
  utilization: number | null;
  resetsAt: number | null;
  status?: string;
  /** limits[] 里带 scope 的行，服务端给的展示标签（模型名或界面名） */
  scopeLabel?: string;
  /** 服务端挑出来的「头条」行 —— 单值指示器显示的就是它 */
  isActive?: boolean;
}

export interface UsageSnapshot {
  /** 上游原始响应（截断）。面板上能看，省得「窗口在但没数字」时只能猜 */
  raw?: string;
  ok: boolean;
  /** oauth = 查了 /api/oauth/usage；headers = 从响应头推断；none = 没数据 */
  source: "oauth" | "headers" | "none";
  subscriptionType?: string | null;
  rateLimitsAvailable?: boolean;
  windows: Record<string, UsageWindow>;
  extraUsage?: Record<string, unknown> | null;
  error?: string | null;
  fetchedAt: number;
}

export interface RateLimitObservation {
  unifiedStatus: string | null;
  fiveHourReset: number | null;
  sevenDayReset: number | null;
  /** 响应头里直接给的百分比（0-100）。有了它就不必再打用量接口 ——
   *  官方客户端就是这么读的，sgproxy 也走这条路。 */
  fiveHourUtilization: number | null;
  sevenDayUtilization: number | null;
  overageDisabledReason: string | null;
  dimensions: Record<string, { limit: number | null; remaining: number | null; reset: number | null }>;
}

export interface Account {
  id: string;
  label: string;
  kind: AccountKind;
  accessToken: string | null;
  refreshToken: string | null;
  apiKey: string | null;
  expiresAt: number | null;
  scope: string | null;
  clientId: string | null;
  mode: string | null;
  accountUuid: string | null;
  /** 这个号专属的 device_id，首次用到时生成，之后固定不变 */
  deviceId: string | null;
  /** 这个号钉住的 Claude Code 版本号，单调递增（只升不降） */
  ccVersion: string | null;
  email: string | null;
  status: AccountStatus;
  lastError: string | null;
  errorCount: number;
  requestCount: number;
  weight: number;
  cooldownUntil: number | null;
  /** 额度耗尽的恢复时刻（unix 秒）；到期自动回到 active */
  exhaustedUntil: number | null;
  /** 为什么被标记为耗尽，给人看的 */
  exhaustedReason: string | null;
  /** 最近一次用量快照 */
  usage: UsageSnapshot | null;
  usageAt: number | null;
  /** 最近一次从上游响应头观察到的限流状态 */
  rateLimit: RateLimitObservation | null;
  createdAt: number;
  updatedAt: number;
}

export interface AccountInput {
  label: string;
  kind: AccountKind;
  accessToken?: string | null;
  refreshToken?: string | null;
  apiKey?: string | null;
  expiresAt?: number | null;
  scope?: string | null;
  clientId?: string | null;
  mode?: string | null;
  accountUuid?: string | null;
  email?: string | null;
  weight?: number;
}
