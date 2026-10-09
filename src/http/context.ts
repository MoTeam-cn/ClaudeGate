import type { ServerResponse } from "node:http";
import type { RequestMeta, RequestTracker } from "../types.ts";

/**
 * 每请求上下文用 WeakMap 挂在 res 上，
 * 这样响应助手和路由都能拿到请求 ID 与记账对象，而不用一路加参数。
 */
const metaStore = new WeakMap<ServerResponse, RequestMeta>();
const trackerStore = new WeakMap<ServerResponse, RequestTracker>();

export function setRequestMeta(res: ServerResponse, meta: RequestMeta): void {
  metaStore.set(res, meta);
}

export function getRequestMeta(res: ServerResponse): RequestMeta | undefined {
  return metaStore.get(res);
}

export function requestIdOf(res: ServerResponse): string | undefined {
  return metaStore.get(res)?.id;
}

export function setTracker(res: ServerResponse, tracker: RequestTracker): void {
  trackerStore.set(res, tracker);
}

export function getTracker(res: ServerResponse): RequestTracker | undefined {
  return trackerStore.get(res);
}
