import http from "node:http";
import type { IncomingHttpHeaders } from "node:http";

import { BILLING_HEADER_PREFIX, HEADER_KEYS } from "../../src/fingerprint/attribution.ts";
import { IDENTITY_LINES, isWellFormedAttribution } from "../../src/security/identity.ts";

const SP = " ";

/**
 * 一份**完整**的归因头。刻意用真实常量拼，不写字面量 ——
 * 带等号的串写进源码会被上层的输入改写吃掉。
 */
export const TEST_BILLING =
  BILLING_HEADER_PREFIX + SP + HEADER_KEYS.version + "2.1.293.abc" + HEADER_KEYS.semi +
  SP + HEADER_KEYS.entrypoint + "cli" + HEADER_KEYS.semi +
  SP + HEADER_KEYS.cch;

/** 归因头 + 身份行的 system 数组，就是真 Claude Code 发的那两段 */
export function ccSystem(extra?: string): Array<{ type: string; text: string }> {
  const blocks = [
    { type: "text", text: TEST_BILLING },
    { type: "text", text: IDENTITY_LINES[0] }
  ];
  if (extra) blocks.push({ type: "text", text: extra });
  return blocks;
}

function blockText(b: unknown): string {
  if (typeof b === "string") return b;
  if (b && typeof b === "object") {
    const t = (b as Record<string, unknown>).text;
    if (typeof t === "string") return t;
  }
  return "";
}

/**
 * 给发往 /v1/messages 的请求补上 Claude Code 的 system。
 *
 * 真客户端一定会带这两段；不带的话身份校验（IDENTITY_MODE 默认 block）会回 403，
 * 而绝大多数测试测的是别的东西，不该被这个挡住。
 * 补法是「缺什么补什么」，不覆盖已有的段 —— 所以测 stego 的用例照样能测它的日期行。
 * 专门测身份校验的用例传 raw:true 自己给 body。
 */
function withCcSystem(pathname: string, body: unknown): unknown {
  if (!pathname.startsWith("/v1/messages")) return body;
  if (!body || typeof body !== "object" || Array.isArray(body)) return body;
  const m = body as Record<string, unknown>;
  const sys = m.system;

  if (sys === undefined) return { ...m, system: ccSystem() };

  if (typeof sys === "string") return { ...m, system: ccSystem(sys) };

  if (Array.isArray(sys)) {
    const blocks: unknown[] = [...sys];
    if (!isWellFormedAttribution(blockText(blocks[0]))) {
      blocks.unshift({ type: "text", text: TEST_BILLING });
    }
    const hasId = blocks.some((b) => IDENTITY_LINES.includes(blockText(b).trim()));
    if (!hasId) blocks.push({ type: "text", text: IDENTITY_LINES[0] });
    return { ...m, system: blocks };
  }

  /* system 是单个对象（非数组）——也补成规范的两段 */
  if (sys && typeof sys === "object") {
    const t = blockText(sys);
    return { ...m, system: ccSystem(t || undefined) };
  }

  return body;
}

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
  /** 不要自动补 Claude Code 的 system（专门测身份校验时用） */
  raw?: boolean;
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
    const payload = opts.raw ? opts.body : withCcSystem(pathname, opts.body);
    const body = payload !== undefined ? Buffer.from(JSON.stringify(payload)) : null;
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
