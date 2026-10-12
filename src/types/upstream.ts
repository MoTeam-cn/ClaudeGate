import type { IncomingHttpHeaders } from "node:http";
import type { Readable } from "node:stream";
import type { Account } from "./account.ts";

export interface UpstreamResponse {
  status: number;
  headers: IncomingHttpHeaders;
  raw: Readable;
}

/** 成功建立的上游调用，带上本次使用的号池账号 */
export interface UpstreamOk extends UpstreamResponse {
  account: Account | null;
}

export interface UpstreamError {
  error: "no_credential";
  /** 为什么挑不到号：空池 / 全在冷却 / 全耗尽 / 全停用，尽量说清 */
  reason?: string;
  /** 全在冷却时给出「多少秒后重试」，调用方据此退避 */
  retryAfterSec?: number | null;
}

export type UpstreamResult = UpstreamOk | UpstreamError;

export function isUpstreamError(r: UpstreamResult): r is UpstreamError {
  return (r as UpstreamError).error === "no_credential";
}

export interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  [k: string]: unknown;
}

export interface PendingCall {
  path: string;
  method?: string;
  headers: Record<string, string | string[] | undefined>;
  body?: Buffer;
}
