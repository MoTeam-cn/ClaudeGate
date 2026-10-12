import type { Account, GatewayContext, UsageSnapshot } from "../../types.ts";

/** 一次额度查询的结果；sealedUntil 非空表示窗口 rejected 并封印到了这个时刻 */
export interface UsageRefresh {
  snap: UsageSnapshot;
  sealedUntil: number | null;
}

/**
 * 面板 API 处理器的公共依赖。
 *
 * 处理器从 createPanelApi 的闭包里搬出来之后，不再能直接捕获 cfg / accounts / ...
 * 这些值全都在 ctx 上，所以这里只留 ctx 一个入口；
 * refreshUsage 是唯一带状态的（含「窗口 rejected 就封印」的逻辑，两处共用）。
 */
export interface PanelDeps {
  ctx: GatewayContext;
  refreshUsage(acc: Account, timeoutMs?: number): Promise<UsageRefresh>;
}
