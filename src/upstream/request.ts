import http from "node:http";
import https from "node:https";
import { headerValue } from "../utils.ts";
import { fetchUpstream, fetchTransportUsable, fetchSupportsProxy } from "../net/fetch.ts";
import { createAgent, createHttpAgent } from "./agent.ts";
import type { Config, UpstreamResponse } from "../types.ts";
import type { IncomingMessage } from "node:http";
export interface UpstreamCallOptions {
  method?: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body?: Buffer;
}

/**
 * 选出真正要用的通道。
 *
 * 四条路实测的 JA3（同一台机器、同一个 TLS 服务端、同一个目标 IP）：
 *
 *   Node node:https + 钉套件   10ece698233123fa8829a8b2a7de6db1   17 套件 / 11 扩展 / 曲线 8 条 / 点格式 0-1-2
 *   Bun  node:https + 钉套件   c33df997f0ea608c617c58df7ad5f1f6   17 套件 / 10 扩展 / 曲线 4 条 / 点格式 0
 *   Bun  fetch                 5260242a2eb12c71995767c24569bff5   17 套件 / 12 扩展 / 曲线 4 条 / 点格式 0  ← 与真 Claude Code 逐位一致
 *   Bun  Bun.connect           117e3a479f24fc1d38052d156be91f71   10 扩展（还少了 ALPN）
 *
 * 试过但走不通的：Bun.connect 加 requestOCSP 对 ClientHello 毫无影响；
 * 加 ALPNProtocols 直接抛 TLSOptions.ALPNProtocols must be of type string...。
 * 所以「完全一致的 JA3」只有 fetch 一条路，没有别的入口。
 *
 * fetch 的代价是两条：请求头被 Bun 的 Headers 重排（三种传参方式都重排，控制不了），
 * 以及不支持 SOCKS5 与 CONNECT 代理。
 *
 * 代理不是障碍：实测 Bun 的 fetch 支持 HTTP/HTTPS 代理（CONNECT 隧道），
 * 而且**走代理时 ClientHello 与直连逐位一致** —— CONNECT 是透明隧道，
 * TLS 端到端握到 Anthropic，指纹是网关自己的，不是代理的。
 * 只有 SOCKS5 不行（UnsupportedProxyProtocol），那种情况退回 node:https。
 *
 * 所以 auto 的规则是：能拿 JA3 就拿 —— Bun 且（没配代理、或代理是 http/https）时走 fetch；
 * 其余退回 node:https。要强制头序优先就显式设 TRANSPORT=https。
 */
export function effectiveTransport(cfg: Config): "fetch" | "https" {
  if (cfg.transport === "fetch") return "fetch";
  if (cfg.transport === "https") return "https";
  if (!fetchTransportUsable()) return "https";
  /* 没配代理，或者配的是 fetch 能承载的代理，都能拿到 JA3 */
  if (!cfg.proxy || fetchSupportsProxy(cfg.proxy.kind)) return "fetch";
  return "https";
}

export function upstreamRequest(cfg: Config, opts: UpstreamCallOptions): Promise<UpstreamResponse> {
  if (effectiveTransport(cfg) === "fetch") return fetchUpstream(cfg, opts);
  return nodeUpstreamRequest(cfg, opts);
}

function nodeUpstreamRequest(cfg: Config, opts: UpstreamCallOptions): Promise<UpstreamResponse> {
  return new Promise((resolve, reject) => {
    const target = new URL(cfg.upstreamBase + opts.path);
    const isHttps = target.protocol === "https:";
    const headers: Record<string, string | string[] | undefined> = { ...opts.headers };
    /* host 必须指向真实上游；客户端带了就原地改值，别挪到末尾 */
    const hostKey = Object.keys(headers).find((k) => k.toLowerCase() === "host");
    if (hostKey) headers[hostKey] = target.host;
    else headers["host"] = target.host;

    const mod = isHttps ? https : http;
    const reqOpts: https.RequestOptions = {
      method: opts.method ?? "POST",
      hostname: target.hostname,
      port: target.port || (isHttps ? 443 : 80),
      path: target.pathname + target.search,
      headers
    };

    /* 代理、keep-alive、TLS 参数都在 Agent 里，这里只管选对那一个 */
    reqOpts.agent = isHttps ? cfg.agent : cfg.agentHttp;

    const req = mod.request(reqOpts, (res) => {
      resolve({ status: res.statusCode ?? 502, headers: res.headers, raw: res });
    });
    req.on("error", reject);
    req.setTimeout(cfg.upstreamTimeoutMs, () => req.destroy(new Error("upstream timeout")));
    if (opts.body) {
      /* 必须显式给 content-length：不写的话 Node 会退回 chunked 传输，
         而真 Claude Code 发的是 content-length —— 传输分帧方式是可观测的差异 */
      req.setHeader("content-length", String(opts.body.length));
      req.write(opts.body);
    }
    req.end();
  });
}

/** 上游若压缩则解压，避免把压缩体转给不支持的下游 */
