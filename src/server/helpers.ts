import type { IncomingMessage, ServerResponse } from "node:http";
import type { Protocol } from "../types.ts";

/** 面板与 API 之外的零散处理器与判定：都是纯函数，不依赖网关上下文 */

export function protocolOf(pathname: string): Protocol {
  if (pathname.startsWith("/v1/chat") || pathname.startsWith("/v1/models") || pathname.startsWith("/v1/completions")) {
    return "openai";
  }
  if (pathname.startsWith("/v1/messages")) return "anthropic";
  if (pathname.startsWith("/v1/")) return "other";
  return "admin";
}

export function clientIpOf(req: IncomingMessage, trustProxy: boolean): string {
  if (trustProxy) {
    const xff = req.headers["x-forwarded-for"];
    const raw = Array.isArray(xff) ? xff[0] : xff;
    if (raw) {
      const first = raw.split(",")[0]?.trim();
      if (first) return first;
    }
    const real = req.headers["x-real-ip"];
    const realRaw = Array.isArray(real) ? real[0] : real;
    if (realRaw) return realRaw.trim();
  }
  return req.socket.remoteAddress ?? "unknown";
}

/** 只有真正打上游的路径才进请求日志，面板与健康检查不记 */
export function shouldLogRequest(pathname: string): boolean {
  return pathname.startsWith("/v1/");
}


  /**
 * HEAD /api/hello —— Claude Code 的连接预热探测。
 *
 * 官方网关兼容指南把它列为「启动期尽力而为的流量，网关可以直接拒绝而不影响功能」，
 * 但 404 与 200 是可观测的差异，照着 api.anthropic.com 的真实响应回一份最省事：
 * 那边是 200 + {"message":"hello"} + application/json。
 * 探测不带任何凭据，也不需要转发上游。
 */
export function hello(_req: IncomingMessage, res: ServerResponse): void {
  /* 真端点带一个空格，content-length 是 20；少个空格就对不上了 */
  const body = Buffer.from('{"message": "hello"}', "utf8");
  res.writeHead(200, {
    "content-type": "application/json",
    "content-length": String(body.length),
    "x-robots-tag": "none"
  });
  /* HEAD 不能带 body，Node 会自己丢掉，但显式区分更清楚 */
  if ((_req.method ?? "GET").toUpperCase() === "HEAD") { res.end(); return; }
  res.end(body);
}

/** 浏览器会无条件请求 favicon，回 204 免得面板控制台一直挂个 404 */
export function favicon(_req: IncomingMessage, res: ServerResponse): void {
  res.writeHead(204, { "cache-control": "max-age=86400" });
  res.end();
}

export function isOpenaiPath(pathname: string): boolean {
  return pathname === "/v1/chat/completions" || pathname === "/v1/models" ||
    pathname.startsWith("/v1/chat/") || pathname.startsWith("/v1/completions");
}
