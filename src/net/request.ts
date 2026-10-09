import http from "node:http";
import https from "node:https";
import type { Config } from "../types.ts";

export interface RawResponse {
  status: number;
  ok: boolean;
  headers: Record<string, string | string[]>;
  text: string;
}

export interface RawRequestOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  cfg: Config;
}

/**
 * 替掉全局 fetch。
 * 原因：fetch 走 undici，不认我们的 keep-alive Agent，也就绕过了代理；
 * 而 oauth 兑换、令牌刷新、用量查询这些恰恰都在墙外，必须一起走代理。
 */
export function requestRaw(url: string, opts: RawRequestOptions): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const isHttps = target.protocol === "https:";
    const mod = isHttps ? https : http;
    const timeoutMs = opts.timeoutMs ?? 30000;

    const req = mod.request(
      {
        method: opts.method ?? "GET",
        hostname: target.hostname,
        port: target.port || (isHttps ? 443 : 80),
        path: target.pathname + target.search,
        headers: opts.headers,
        agent: isHttps ? opts.cfg.agent : opts.cfg.agentHttp
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const status = res.statusCode ?? 0;
          resolve({
            status,
            ok: status >= 200 && status < 300,
            headers: res.headers as Record<string, string | string[]>,
            text: Buffer.concat(chunks).toString("utf8")
          });
        });
        res.on("error", reject);
      }
    );

    req.setTimeout(timeoutMs, () => req.destroy(new Error("请求超时 " + timeoutMs + "ms：" + target.host)));
    req.on("error", reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

/** 拿 JSON，解析失败返回 null 而不抛 */
export async function requestJson<T>(url: string, opts: RawRequestOptions): Promise<{ status: number; ok: boolean; data: T | null; text: string }> {
  const r = await requestRaw(url, opts);
  let data: T | null = null;
  try {
    data = JSON.parse(r.text) as T;
  } catch {
    data = null;
  }
  return { status: r.status, ok: r.ok, data, text: r.text };
}
