import http from "node:http";
import type { IncomingHttpHeaders } from "node:http";

export interface Reply {
  status: number;
  headers: IncomingHttpHeaders;
  text: string;
  json: unknown;
}

export interface RequestOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
}

function finish(res: http.IncomingMessage, resolve: (r: Reply) => void): void {
  const chunks: Buffer[] = [];
  res.on("data", (c: Buffer) => chunks.push(c));
  res.on("end", () => {
    const text = Buffer.concat(chunks).toString("utf8");
    let json: unknown = null;
    try {
      json = JSON.parse(text) as unknown;
    } catch {
      json = null;
    }
    resolve({ status: res.statusCode ?? 0, headers: res.headers, text, json });
  });
}

/** 简单 HTTP 客户端：禁用 keep-alive，避免测试进程挂住 */
export function request(port: number, pathname: string, opts: RequestOptions = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const body = opts.body !== undefined ? Buffer.from(JSON.stringify(opts.body)) : null;
    const headers: Record<string, string> = { ...(opts.headers ?? {}) };
    if (body && !headers["content-type"]) headers["content-type"] = "application/json";
    if (body) headers["content-length"] = String(body.length);

    const req = http.request(
      {
        agent: false,
        hostname: "127.0.0.1",
        port,
        path: pathname,
        method: opts.method ?? (body ? "POST" : "GET"),
        headers
      },
      (res) => finish(res, resolve)
    );
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

export function requestForm(port: number, pathname: string, form: string): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const body = Buffer.from(form);
    const req = http.request(
      {
        agent: false,
        hostname: "127.0.0.1",
        port,
        path: pathname,
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "content-length": String(body.length)
        }
      },
      (res) => finish(res, resolve)
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

export function getText(port: number, pathname: string, headers?: Record<string, string>): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { agent: false, hostname: "127.0.0.1", port, path: pathname, method: "GET", headers: headers ?? {} },
      (res) => finish(res, resolve)
    );
    req.on("error", reject);
    req.end();
  });
}

export function asRecord(v: unknown): Record<string, unknown> {
  return (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
}
