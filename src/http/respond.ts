import type { ServerResponse } from "node:http";
import { getRequestMeta } from "./context.ts";

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/**
 * 统一 JSON 响应。
 * 按 REQ_ID_IN_RESPONSE 约定注入请求 ID：错误响应总是带，
 * 成功响应只有 always 模式才带（默认不污染上游透传体）。
 */
export function sendJson(
  res: ServerResponse,
  status: number,
  obj: unknown,
  extraHeaders?: Record<string, string>
): void {
  const meta = getRequestMeta(res);
  let payload = obj;

  if (
    meta &&
    meta.reqIdInResponse !== "off" &&
    (status >= 400 || meta.reqIdInResponse === "always") &&
    isPlainObject(obj) &&
    !("request_id" in obj)
  ) {
    payload = { ...obj, request_id: meta.id };
  }

  const body = Buffer.from(JSON.stringify(payload), "utf8");
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": String(body.length),
    "cache-control": "no-store",
    ...(extraHeaders ?? {})
  });
  res.end(body);
}

export function sendHtml(res: ServerResponse, status: number, html: string): void {
  const body = Buffer.from(html, "utf8");
  res.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "content-length": String(body.length),
    "cache-control": "no-store"
  });
  res.end(body);
}

export function sendText(res: ServerResponse, status: number, text: string, type?: string): void {
  const body = Buffer.from(text, "utf8");
  res.writeHead(status, {
    "content-type": type ?? "text/plain; charset=utf-8",
    "content-length": String(body.length),
    "cache-control": "no-store"
  });
  res.end(body);
}

export function openaiError(
  res: ServerResponse,
  status: number,
  message: string,
  type?: string,
  code?: string | null
): void {
  const id = getRequestMeta(res)?.id;
  sendJson(res, status, {
    error: {
      message,
      type: type ?? "invalid_request_error",
      code: code ?? null,
      param: null,
      ...(id ? { request_id: id } : {})
    }
  });
}

export function anthropicError(
  res: ServerResponse,
  status: number,
  message: string,
  type?: string,
  code?: string | null
): void {
  const id = getRequestMeta(res)?.id;
  sendJson(res, status, {
    type: "error",
    error: {
      type: type ?? "invalid_request_error",
      message,
      ...(code ? { code } : {}),
      ...(id ? { request_id: id } : {})
    }
  });
}
