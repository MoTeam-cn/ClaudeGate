import { Readable } from "node:stream";
import type { IncomingHttpHeaders } from "node:http";

import type { Config, UpstreamResponse } from "../types.ts";
import type { UpstreamCallOptions } from "../upstream.ts";

/** 是不是跑在 Bun 上 */
export function isBun(): boolean {
  return typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";
}

/**
 * 这条通道只在 Bun 上有意义。
 *
 * 实测（同一台机器、同一个 TLS 服务端）：
 *   Node node:https + 钉套件   JA3 10ece698233123fa8829a8b2a7de6db1
 *   Bun  node:https + 钉套件   JA3 c33df997f0ea608c617c58df7ad5f1f6
 *   Bun  fetch                JA3 5260242a2eb12c71995767c24569bff5  ← 与真 Claude Code 完全一致
 *
 * Node 的 fetch 是 undici，TLS 还是 OpenSSL，换了没意义，所以只在 Bun 上启用。
 *
 * 代理：实测 Bun 的 fetch **支持 HTTP/HTTPS 代理**（CONNECT 隧道），
 * 走代理时 ClientHello 与直连逐位一致 —— 因为 CONNECT 是透明隧道，
 * TLS 仍然端到端握到 Anthropic，指纹是网关自己的。
 * SOCKS5 不行：直接报 UnsupportedProxyProtocol，所以那种情况退回 node:https。
 *
 * 代价只剩一条：Bun 的 fetch 会重排请求头（普通对象 / Headers.set / Headers.append 都重排），
 * 而真 Claude Code 的头序是插入序。想要头序就把 TRANSPORT 设成 https。
 */
export function fetchTransportUsable(): boolean {
  return isBun();
}

/** fetch 通道能不能承载这种代理。HTTP/HTTPS 走 CONNECT 可以，SOCKS5 不行。 */
export function fetchSupportsProxy(kind: string | null | undefined): boolean {
  return kind === "http" || kind === "https";
}

/** 把出站代理配置转成 fetch 认的 URL */
function proxyUrl(cfg: Config): string | undefined {
  const p = cfg.proxy;
  if (!p) return undefined;
  const auth = p.username ? p.username + (p.password ? ":" + p.password : "") + "@" : "";
  /* socks5h 交给代理解析域名，Bun 只认 socks5 这个 scheme */
  const scheme = p.kind === "https" ? "https" : p.kind === "http" ? "http" : "socks5";
  return scheme + "://" + auth + p.host + ":" + p.port;
}

/** 走 fetch 的上游调用（Bun 专用，为的是 BoringSSL 的 ClientHello） */
export async function fetchUpstream(cfg: Config, opts: UpstreamCallOptions): Promise<UpstreamResponse> {
  const url = cfg.upstreamBase + opts.path;
  const headers = new Headers();

  for (const [k, v] of Object.entries(opts.headers)) {
    if (v === undefined) continue;
    const lk = k.toLowerCase();
    /* 这三个由 fetch 自己算；手动给要么被忽略，要么和它冲突 */
    if (lk === "host" || lk === "content-length" || lk === "connection") continue;
    if (Array.isArray(v)) {
      for (const one of v) headers.append(k, String(one));
    } else {
      headers.set(k, String(v));
    }
  }

  const init: RequestInit & { proxy?: string } = {
    method: opts.method ?? "POST",
    headers,
    redirect: "manual",
    signal: AbortSignal.timeout(cfg.upstreamTimeoutMs)
  };
  if (opts.body) init.body = opts.body;
  const px = proxyUrl(cfg);
  if (px) init.proxy = px;

  const res = await fetch(url, init);

  const out: IncomingHttpHeaders = {};
  res.headers.forEach((value, key) => {
    out[key.toLowerCase()] = value;
  });
  /* set-cookie 不能走 forEach，它会被逗号拼成一坨 */
  const cookies = (res.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie?.();
  if (cookies && cookies.length > 0) out["set-cookie"] = cookies;

  const body = res.body
    ? Readable.fromWeb(res.body as unknown as import("node:stream/web").ReadableStream)
    : Readable.from([]);

  return { status: res.status, headers: out, raw: body };
}
