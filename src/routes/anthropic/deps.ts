import type { ServerResponse } from "node:http";
import type { Config, GatewayContext, Logger } from "../../types.ts";

/**
 * 两个 Anthropic 处理器的公共依赖。
 *
 * messages / countTokens 原本是 createAnthropicRoutes 里的闭包，直接捕获了
 * cfg / log / ctx 与两个错误应答小工具。搬出来之后显式传进来 ——
 * 处理器函数体一字未改，靠解构把名字对上。
 */
export interface AnthropicDeps {
  cfg: Config;
  log: Logger;
  ctx: GatewayContext;
  blocked(res: ServerResponse, code: string | undefined, message: string | undefined): void;
  rejectPolicy(res: ServerResponse, code: string, reason: string): void;
}
