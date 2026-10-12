import http from "node:http";
import https from "node:https";
import tls from "node:tls";
import net from "node:net";
import { connectViaProxy } from "../net/proxy.ts";
import type { Config } from "../types.ts";
import type { SecureVersion } from "node:tls";
import type { Duplex } from "node:stream";
/** tls 的 SecureVersion 是字面量联合，env 给的是 string，这里收窄 */
function secureVersion(v: string): SecureVersion {
  return v as SecureVersion;
}

/** Agent 自定义连接工厂的签名（@types/node 没导出，自己写一份） */
interface ConnOptions {
  host?: string;
  port?: string | number;
}
type ConnCallback = (err: Error | null, socket: Duplex | null) => void;

function alpnList(cfg: Config): string[] {
  return String(cfg.upstreamAlpn || "http/1.1")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function keepAliveBase(cfg: Config): { keepAlive: boolean; keepAliveMsecs: number; maxSockets: number; maxFreeSockets: number } {
  return {
    keepAlive: true,
    keepAliveMsecs: 15000,
    maxSockets: cfg.upstreamMaxSockets,
    maxFreeSockets: Math.max(4, Math.floor(cfg.upstreamMaxSockets / 4))
  };
}

/**
 * 固定 TLS 参数的 keep-alive Agent —— 到上游的指纹稳定性核心。
 * 配了代理就先用代理打通隧道，再在隧道里做 TLS，
 * 这样上游看到的 TLS 指纹仍然是我们自己的（不是代理的）。
 */
export function createAgent(cfg: Config): https.Agent {
  const alpn = alpnList(cfg);
  const base: https.AgentOptions = {
    ...keepAliveBase(cfg),
    minVersion: secureVersion(cfg.tlsMin),
    maxVersion: secureVersion(cfg.tlsMax),
    ALPNProtocols: alpn,
    ...(cfg.tlsCiphers ? { ciphers: cfg.tlsCiphers } : {})
  };
  const spec = cfg.proxy ?? null;
  if (!spec) return new https.Agent(base);

  /* 注意：new Agent({ createConnection }) 会被静默忽略——Node 不读这个选项，
     必须在实例上赋值。踩过一次，别再改回去。 */
  const agent = new https.Agent(base);
  agent.createConnection = ((opts: ConnOptions, cb: ConnCallback) => {
      const host = String(opts.host ?? "");
      const port = Number(opts.port) || 443;
      connectViaProxy(spec, host, port, cfg.upstreamTimeoutMs)
        .then((socket) => {
          const s = tls.connect({
            socket,
            servername: net.isIP(host) ? undefined : host,
            minVersion: secureVersion(cfg.tlsMin),
            maxVersion: secureVersion(cfg.tlsMax),
            ALPNProtocols: alpn,
            ...(cfg.tlsCiphers ? { ciphers: cfg.tlsCiphers } : {})
          });
          s.on("secureConnect", () => cb(null, s));
          s.on("error", (e: Error) => cb(e, null));
        })
        .catch((e: Error) => cb(e, null));
      return undefined;
  }) as unknown as typeof https.Agent.prototype.createConnection;
  return agent;
}

/** http 目标的 Agent（内网与测试用）；配了代理同样能走隧道 */
export function createHttpAgent(cfg: Config): http.Agent {
  const base = keepAliveBase(cfg);
  const spec = cfg.proxy ?? null;
  if (!spec) return new http.Agent(base);
  const agent = new http.Agent(base);
  agent.createConnection = ((opts: ConnOptions, cb: ConnCallback) => {
      connectViaProxy(spec, String(opts.host ?? ""), Number(opts.port) || 80, cfg.upstreamTimeoutMs)
        .then((socket) => cb(null, socket))
        .catch((e: Error) => cb(e, null));
      return undefined;
  }) as unknown as typeof http.Agent.prototype.createConnection;
  return agent;
}
