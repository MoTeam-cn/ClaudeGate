import http from "node:http";
import https from "node:https";
import tls from "node:tls";
import net from "node:net";
import zlib from "node:zlib";
import { pipeline } from "node:stream/promises";
import { Readable, Transform } from "node:stream";

import { HOP_BY_HOP, RESPONSE_PASS_HEADERS, ANTHROPIC_VERSION } from "./constants.ts";
import { mergeBeta, upstreamAuthHeaders } from "./oauth.ts";
import { injectCanonicalHeaders, fingerprintSeed } from "./guard.ts";
import { headerValue } from "./utils.ts";
import { connectViaProxy } from "./net/proxy.ts";
import type { Account, AuthState, Config, UpstreamResponse } from "./types.ts";
import type { IncomingMessage, ServerResponse } from "node:http";
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
    ALPNProtocols: alpn
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
            ALPNProtocols: alpn
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

export interface UpstreamCallOptions {
  method?: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body?: Buffer;
}

export function upstreamRequest(cfg: Config, opts: UpstreamCallOptions): Promise<UpstreamResponse> {
  return new Promise((resolve, reject) => {
    const target = new URL(cfg.upstreamBase + opts.path);
    const isHttps = target.protocol === "https:";
    const headers: Record<string, string | string[] | undefined> = { ...opts.headers };
    headers["host"] = target.host;

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
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

/** 上游若压缩则解压，避免把压缩体转给不支持的下游 */
export function decodeStream(res: IncomingMessage): Readable {
  const enc = String(res.headers["content-encoding"] ?? "").toLowerCase();
  if (enc === "gzip") return res.pipe(zlib.createGunzip());
  if (enc === "deflate") return res.pipe(zlib.createInflate());
  if (enc === "br") return res.pipe(zlib.createBrotliDecompress());
  return res;
}

/**
 * 组装上游请求头：客户端头原样透传（指纹保真），只替换认证头，并按需注入规范头。
 */
export function buildUpstreamHeaders(
  req: IncomingMessage,
  auth: AuthState,
  cfg: Config,
  account: Account | null
): Record<string, string | string[] | undefined> {
  const source = req.headers;
  let headers: Record<string, string | string[] | undefined> = {};

  for (const k of Object.keys(source)) {
    if (HOP_BY_HOP.has(k.toLowerCase())) continue;
    headers[k] = source[k];
  }

  /* 非 Claude Code 指纹的 Key 也必须注入规范头，否则上游一眼看出是第三方客户端 */
  if (cfg.injectMissing || auth.useClaudeFingerprint === false) {
    headers = injectCanonicalHeaders(headers, cfg, fingerprintSeed(auth));
  }

  const authHeaders = auth.passthroughKey
    ? { "x-api-key": auth.passthroughKey, "anthropic-version": ANTHROPIC_VERSION }
    : upstreamAuthHeaders(account);

  for (const ak of Object.keys(authHeaders)) {
    const lk = ak.toLowerCase();
    const existingKey = Object.keys(headers).find((hk) => hk.toLowerCase() === lk);

    /* beta 是能力集合，必须并集：客户端带什么就留什么，再补上我们需要的 */
    if (lk === "anthropic-beta") {
      headers[ak] = mergeBeta(existingKey ? headers[existingKey] : undefined, authHeaders[ak]);
      if (existingKey && existingKey !== ak) delete headers[existingKey];
      continue;
    }

    for (const hk of Object.keys(headers)) if (hk.toLowerCase() === lk) delete headers[hk];
    headers[ak] = authHeaders[ak];
  }

  if (!headers["content-type"] && !headers["Content-Type"]) headers["content-type"] = "application/json";
  return headers;
}

/** 收集流内容，带上限，避免异常上游把内存打满 */
export async function collect(stream: Readable, limit = 64 * 1024 * 1024): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > limit) throw new Error("upstream response too large");
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

/** 组装要回写给客户端的响应头（与 pipeUpstream 同一套规则） */
export function passThroughHeaders(up: UpstreamResponse): Record<string, string | number | string[]> {
  const headers: Record<string, string | number | string[]> = {};
  for (const name of RESPONSE_PASS_HEADERS) {
    const v = up.headers[name];
    if (v !== undefined) headers[name] = v;
  }
  for (const k of Object.keys(up.headers)) {
    if (k.toLowerCase().startsWith("anthropic-ratelimit-")) {
      const v = up.headers[k];
      if (v !== undefined) headers[k] = v;
    }
  }
  if (!headers["cache-control"]) headers["cache-control"] = "no-store";
  if (!headers["content-type"]) headers["content-type"] = "application/json";
  return headers;
}

export interface PipeOptions {
  /** true 时先收全量再回写（需要改写响应体时用） */
  json?: boolean;
  /** 与 json 搭配：把解析后的对象转换成要发给客户端的内容 */
  transform?: (parsed: unknown) => unknown;
  /** 旁路观测每个分片（不改字节），用于从 SSE 里嗅探用量 */
  tap?: (chunk: Buffer) => void;
}

/**
 * SSE 用量嗅探器：只看不改，从数据流里抽出 input_tokens 与 output_tokens。
 * 保留一小段尾巴用于跨分片拼接，避免 JSON 被切断时漏读。
 */
export function createUsageSniffer(): {
  tap: (chunk: Buffer) => void;
  usage: () => {
    promptTokens: number;
    completionTokens: number;
    cacheCreationTokens: number;
    cacheReadTokens: number;
  };
} {
  let carry = "";
  let input = 0;
  let output = 0;
  let cacheCreate = 0;
  let cacheRead = 0;

  function tap(chunk: Buffer): void {
    const text = carry + chunk.toString("utf8");
    carry = text.length > 512 ? text.slice(-512) : text;

    /* 键名带引号前缀，所以 "input_tokens" 不会误配 "cache_creation_input_tokens" */
    if (input === 0) {
      const m = /"input_tokens"\s*:\s*(\d+)/.exec(text);
      if (m) input = Number(m[1]) || 0;
    }
    const mc = /"cache_creation_input_tokens"\s*:\s*(\d+)/.exec(text);
    if (mc) {
      const v = Number(mc[1]) || 0;
      if (v > cacheCreate) cacheCreate = v;
    }
    const mr = /"cache_read_input_tokens"\s*:\s*(\d+)/.exec(text);
    if (mr) {
      const v = Number(mr[1]) || 0;
      if (v > cacheRead) cacheRead = v;
    }

    const re = /"output_tokens"\s*:\s*(\d+)/g;
    let mm: RegExpExecArray | null;
    while ((mm = re.exec(text)) !== null) {
      const v = Number(mm[1]) || 0;
      if (v > output) output = v;
    }
  }

  return {
    tap,
    usage: () => ({
      promptTokens: input,
      completionTokens: output,
      cacheCreationTokens: cacheCreate,
      cacheReadTokens: cacheRead
    })
  };
}

/** 把上游响应回写客户端；非 json 模式走 stream.pipeline，天然带背压与连接回收 */
export async function pipeUpstream(
  res: ServerResponse,
  up: UpstreamResponse,
  opts: PipeOptions = {}
): Promise<void> {
  const headers: Record<string, string | number | string[]> = {};
  for (const name of RESPONSE_PASS_HEADERS) {
    const v = up.headers[name];
    if (v !== undefined) headers[name] = v;
  }
  for (const k of Object.keys(up.headers)) {
    if (k.toLowerCase().startsWith("anthropic-ratelimit-")) {
      const v = up.headers[k];
      if (v !== undefined) headers[k] = v;
    }
  }
  if (!headers["cache-control"]) headers["cache-control"] = "no-store";
  if (!headers["content-type"]) headers["content-type"] = "application/json";

  const stream = decodeStream(up.raw);

  if (!opts.json) {
    res.writeHead(up.status, headers);
    const tap = opts.tap;
    if (tap) {
      const spy = new Transform({
        transform(chunk: Buffer, _enc, cb): void {
          try {
            tap(chunk);
          } catch {
            /* 观测失败不能影响转发 */
          }
          cb(null, chunk);
        }
      });
      await pipeline(stream, spy, res);
    } else {
      await pipeline(stream, res);
    }
    return;
  }

  const buf = await collect(stream);
  if (opts.transform && up.status < 400) {
    let out: unknown;
    try {
      out = opts.transform(JSON.parse(buf.toString("utf8")));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      res.writeHead(502, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify({ error: { message: "translate failed: " + msg, type: "api_error" } }));
      return;
    }
    const body = Buffer.from(JSON.stringify(out), "utf8");
    headers["content-type"] = "application/json; charset=utf-8";
    res.writeHead(up.status, headers);
    res.end(body);
    return;
  }

  res.writeHead(up.status, headers);
  res.end(buf);
}

export function firstHeader(v: string | string[] | undefined): string {
  return headerValue(v);
}
