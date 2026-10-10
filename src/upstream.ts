import http from "node:http";
import https from "node:https";
import tls from "node:tls";
import net from "node:net";
import zlib from "node:zlib";
import { pipeline } from "node:stream/promises";
import { PassThrough, Readable, Transform } from "node:stream";

import { HOP_BY_HOP, RESPONSE_DROP_HEADERS, DECODED_ENCODINGS, ANTHROPIC_VERSION, AUTH_HEADER_NAMES } from "./constants.ts";
import { mergeBeta, upstreamAuthHeaders } from "./oauth.ts";
import { injectCanonicalHeaders, injectFingerprintHeaders, fingerprintSeed } from "./guard.ts";
import { headerValue } from "./utils.ts";
import { connectViaProxy } from "./net/proxy.ts";
import { fetchUpstream, fetchTransportUsable, fetchSupportsProxy } from "./net/fetch.ts";
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
/**
 * 各压缩格式的魔数。brotli 没有魔数，只能按声明的来。
 */
const COMPRESS_MAGIC: Record<string, readonly (readonly number[])[]> = {
  gzip: [[0x1f, 0x8b]],
  zstd: [[0x28, 0xb5, 0x2f, 0xfd]],
  deflate: [[0x78, 0x01], [0x78, 0x9c], [0x78, 0xda], [0x78, 0x5e]]
};

/** 头几个字节像不像这个格式。null = 判不了（brotli 或字节还不够） */
function looksCompressed(enc: string, head: Buffer): boolean | null {
  const sigs = COMPRESS_MAGIC[enc];
  if (!sigs || !sigs.length) return null;
  for (const sig of sigs) {
    if (head.length < sig.length) continue;
    let same = true;
    for (let i = 0; i < sig.length; i++) {
      if (head[i] !== sig[i]) { same = false; break; }
    }
    if (same) return true;
  }
  return head.length >= 2 ? false : null;
}

function decompressorFor(enc: string): (() => NodeJS.ReadWriteStream) | null {
  if (enc === "gzip") return () => zlib.createGunzip();
  if (enc === "deflate") return () => zlib.createInflate();
  if (enc === "br") return () => zlib.createBrotliDecompress();
  const zstd = (zlib as unknown as { createZstdDecompress?: () => NodeJS.ReadWriteStream }).createZstdDecompress;
  if (enc === "zstd" && typeof zstd === "function") return () => zstd();
  return null;
}

/**
 * 按 content-encoding 解压上游响应体。
 *
 * 先嗅魔数再决定：声明的编码与实际字节对不上时直接透传，不要硬解。
 * 这是为了防止「body 已经被运行时解压过、头却还留着」这种情况 ——
 * 硬解会抛 incorrect header check，把整个请求打成 500。
 */
export function decodeStream(body: Readable, encoding?: string): Readable {
  const enc = String(encoding ?? "").toLowerCase();
  const found = decompressorFor(enc);
  if (!found) return body;
  /* 收窄一次：下面在嵌套函数里用，TS 会丢掉这里的判断 */
  const make: () => NodeJS.ReadWriteStream = found;

  const out = new PassThrough();
  const chunks: Buffer[] = [];
  let len = 0;
  let settled = false;

  const onBodyError = (e: Error): void => { out.destroy(e); };

  /** 拿定主意：解压还是透传 */
  function settle(): void {
    settled = true;
    body.removeListener("data", onData);
    body.removeListener("end", onEnd);
    const head = Buffer.concat(chunks);
    /* 只有明确「不像」才透传；判不了（brotli / 字节不够）就按声明的解 */
    if (looksCompressed(enc, head) === false) {
      if (head.length) out.write(head);
      body.pipe(out);
      return;
    }
    const dec = make();
    dec.on("error", onBodyError);
    dec.pipe(out);
    if (head.length) dec.write(head);
    body.pipe(dec);
  }

  function onData(c: Buffer): void {
    chunks.push(c);
    len += c.length;
    /* 魔数最长 4 字节，够了就定 */
    if (len >= 4) settle();
  }

  function onEnd(): void {
    if (settled) return;
    settled = true;
    const head = Buffer.concat(chunks);
    /* 空体：没有东西可解，硬解会 "unexpected end of file" */
    if (head.length === 0) {
      out.end();
      return;
    }
    if (looksCompressed(enc, head) === false) {
      out.end(head);
      return;
    }
    const dec = make();
    dec.on("error", onBodyError);
    dec.pipe(out);
    dec.end(head);
  }

  body.on("data", onData);
  body.once("end", onEnd);
  body.once("error", onBodyError);
  return out;
}

/** 组装要回写给客户端的响应头：只丢必须丢的，其余原样透传 */
export function passThroughHeaders(up: UpstreamResponse): Record<string, string | number | string[]> {
  const headers: Record<string, string | number | string[]> = {};
  const enc = String(up.headers["content-encoding"] ?? "").toLowerCase();
  const decoded = DECODED_ENCODINGS.has(enc);
  for (const [k, v] of Object.entries(up.headers)) {
    if (v === undefined) continue;
    const lk = k.toLowerCase();
    if (RESPONSE_DROP_HEADERS.has(lk)) continue;
    /* 只有我们真解压了才敢丢 content-encoding，否则下游拿到的是压缩体却没有标记 */
    if (lk === "content-encoding" && !decoded) continue;
    headers[k] = v;
  }
  if (!headers["cache-control"]) headers["cache-control"] = "no-store";
  if (!headers["content-type"]) headers["content-type"] = "application/json";
  return headers;
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
  /* 用 rawHeaders 而不是 headers：前者保留客户端发来的原始顺序与大小写。
     HTTP 头的顺序本身是可观测的指纹，打乱它等于白做保真。 */
  const source = req.rawHeaders;
  const entries: Array<{ name: string; value: string }> = [];
  let authSlot = -1;

  for (let i = 0; i + 1 < source.length; i += 2) {
    const name = source[i];
    const lk = name.toLowerCase();
    /* 凭据头要先判：它不在逐跳集合里，但万一有人加回去也不能被吃掉 */
    if (AUTH_HEADER_NAMES.has(lk)) {
      /* 记住第一个凭据头的位置，稍后原地换成我们的凭据 */
      if (authSlot === -1) authSlot = entries.length;
      continue;
    }
    if (HOP_BY_HOP.has(lk)) continue;
    /* connection 保位置但值归一：上游连接是复用的，客户端说 close 也不能真关 */
    if (lk === "connection") {
      entries.push({ name, value: "keep-alive" });
      continue;
    }
    entries.push({ name, value: source[i + 1] });
  }

  /* 先落成对象，让规范头注入按老逻辑跑（它只补缺失项，不改顺序） */
  let headers: Record<string, string | string[] | undefined> = {};
  for (const e of entries) headers[e.name] = e.value;

  /* 指纹头（anthropic-version / anthropic-beta / x-claude-code-session-id）任何模式下都补。
     它们是网关的职责：session-id 从 Key 种子派生，保证同一调用方跨请求稳定。
     注意这一段读的是 rawHeaders 重建出来的对象，守卫写回的 req.headers 到这里已经不算数，
     所以注入必须在这里再做一次，否则 claude_code 的 Key 根本拿不到 session-id。 */
  headers = injectFingerprintHeaders(headers, cfg, fingerprintSeed(auth));

  /* 身份头（user-agent / x-app）：非 Claude Code 指纹的 Key 必须补，否则上游一眼看出是第三方 */
  if (cfg.injectMissing || auth.useClaudeFingerprint === false) {
    headers = injectCanonicalHeaders(headers, cfg, fingerprintSeed(auth));
  }

  const authHeaders = auth.passthroughKey
    ? { "x-api-key": auth.passthroughKey, "anthropic-version": ANTHROPIC_VERSION }
    : upstreamAuthHeaders(account);

  /* 凭据头：插回客户端原本的位置，而不是删了再加到末尾 */
  const credName = Object.keys(authHeaders).find((k) => AUTH_HEADER_NAMES.has(k.toLowerCase()));
  if (credName) {
    const credValue = authHeaders[credName];
    if (authSlot >= 0) {
      /* 原地插入：先重建有序数组，再插到那个下标 */
      const rebuilt = Object.keys(headers).map((k) => ({ name: k, value: String(headers[k]) }));
      const insertAt = Math.min(authSlot, rebuilt.length);
      rebuilt.splice(insertAt, 0, { name: credName, value: credValue });
      headers = {};
      for (const e of rebuilt) headers[e.name] = e.value;
    } else {
      headers[credName] = credValue;
    }
  }

  /* 其余认证头：beta 求并集（原地），版本号缺失才补 */
  for (const ak of Object.keys(authHeaders)) {
    const lk = ak.toLowerCase();
    if (AUTH_HEADER_NAMES.has(lk)) continue;
    const existingKey = Object.keys(headers).find((hk) => hk.toLowerCase() === lk);

    if (lk === "anthropic-beta") {
      /* 覆盖会丢掉 claude-code-20250219 / interleaved-thinking / tool-search-tool，
         请求体里的 thinking 与 tool search 依赖它们 */
      const merged = mergeBeta(existingKey ? headers[existingKey] : undefined, authHeaders[ak]);
      if (existingKey) headers[existingKey] = merged;
      else headers[ak] = merged;
      continue;
    }

    if (!existingKey) headers[ak] = authHeaders[ak];
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

/**
 * 上游在「流式响应的第一个字节之前」就断了。
 *
 * 抛出它的好处是：这时候我们还**没有**给客户端写过任何响应头，
 * 路由还能改成一个可重试的 5xx —— Claude Code 把 5xx 当可重试，会干净地重试。
 * 反过来如果先 writeHead 再断，它看到的是「200 + text/event-stream 却一个事件都没有」，
 * 于是报 "Streaming response ended before any complete data was received"，
 * 并退化成非流式重试。我们最不想要的就是那条路。
 */
export class StreamHeadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StreamHeadError";
  }
}

export interface PipeResult {
  /** 回给客户端的字节数 */
  bytes: number;
  /** 流被中途打断（上游断了或客户端先走了） */
  aborted: boolean;
  error?: string;
}

/**
 * 首字节闸门。
 *
 * 关键点：**不能「取到第一块就把 data 监听器摘掉、稍后再挂管道」**。
 * 摘监听器与挂管道之间隔着一次微任务，而同一个 socket 读循环里可能连着
 * 派发两三个 data —— 中间那几块会被静默丢掉。踩过一次：
 * 上游把 "event: message_start\n" 与 "data: {...}\n\n" 分两次写，
 * 第二块正好落进那个空档，于是 input_tokens / cache_* 全读成 0。
 *
 * 所以这里用一个 PassThrough 一直收着：先 write 再 resolve，
 * 下游接手的永远是同一个连续流。
 */
function gateFirstByte(stream: Readable): { head: Promise<Buffer | null>; out: PassThrough } {
  const out = new PassThrough();
  /*
   * 兜底监听，必须有。
   *
   * out 有可能在 pipeline 接手之前就出错（上游在首字节前断连，我们 destroy 它）。
   * 那一刻它身上没有任何 'error' 监听者，Node 会把它当未捕获异常直接抛出，
   * **把整个网关进程带走** —— 测试里真的复现过：一次代理抽风 = 所有在途请求一起断。
   * 真正的错误传播靠 head 这个 promise 和之后的 pipeline，这里只负责不让它崩。
   */
  out.on("error", () => undefined);
  let settled = false;
  let resolveHead: (v: Buffer | null) => void = () => undefined;
  let rejectHead: (e: Error) => void = () => undefined;
  const head = new Promise<Buffer | null>((res, rej) => {
    resolveHead = res;
    rejectHead = rej;
  });

  stream.on("data", (c: Buffer) => {
    out.write(c);
    if (!settled) {
      settled = true;
      resolveHead(c);
    }
  });
  stream.once("end", () => {
    if (!settled) {
      settled = true;
      resolveHead(null);
    }
    out.end();
  });
  stream.once("error", (e: Error) => {
    if (!settled) {
      settled = true;
      /* 首字节之前就断：对调用方来说和「空流」是同一类事，都还能重试 */
      rejectHead(new StreamHeadError("上游在流式响应首字节前中断：" + e.message));
    }
    out.destroy(e);
  });

  return { head, out };
}

/** 把上游响应回写客户端；非 json 模式走 stream.pipeline，天然带背压与连接回收 */
export async function pipeUpstream(
  res: ServerResponse,
  up: UpstreamResponse,
  opts: PipeOptions = {}
): Promise<PipeResult> {
  const headers = passThroughHeaders(up);

  const stream = decodeStream(up.raw, up.headers["content-encoding"]);

  if (!opts.json) {
    const tap = opts.tap;
    const tapOne = (chunk: Buffer): void => {
      if (!tap) return;
      try {
        tap(chunk);
      } catch {
        /* 观测失败不能影响转发 */
      }
    };

    /* 首字节闸门：拿到第一个字节之前绝不写响应头 */
    const gate = gateFirstByte(stream);
    const first = await gate.head;
    if (first === null) {
      throw new StreamHeadError("上游在流式响应的第一个字节之前就结束了（空流）");
    }

    /* 流式响应别让中间的反向代理攒够一批再吐 */
    if (String(headers["content-type"] ?? "").indexOf("text/event-stream") !== -1) {
      headers["x-accel-buffering"] = "no";
    }

    res.writeHead(up.status, headers);

    let bytes = 0;
    const count = new Transform({
      transform(chunk: Buffer, _enc, cb): void {
        bytes += chunk.length;
        tapOne(chunk);
        cb(null, chunk);
      }
    });

    try {
      await pipeline(gate.out, count, res);
      return { bytes, aborted: false };
    } catch (e) {
      /* 上游中途断了、或者客户端先走了。pipeline 已经把 res 销毁，
         这里只把原因交回去 —— 响应头早发出去了，没法再改成错误码。 */
      return { bytes, aborted: true, error: e instanceof Error ? e.message : String(e) };
    }
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
      return { bytes: 0, aborted: false };
    }
    const body = Buffer.from(JSON.stringify(out), "utf8");
    headers["content-type"] = "application/json; charset=utf-8";
    res.writeHead(up.status, headers);
    res.end(body);
    return { bytes: body.length, aborted: false };
  }

  res.writeHead(up.status, headers);
  res.end(buf);
  return { bytes: buf.length, aborted: false };
}

export function firstHeader(v: string | string[] | undefined): string {
  return headerValue(v);
}
