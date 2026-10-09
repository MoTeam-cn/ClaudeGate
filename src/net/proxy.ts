import net from "node:net";
import tls from "node:tls";
import http from "node:http";
import dns from "node:dns";
import type { Duplex } from "node:stream";

/**
 * 出站代理支持：http、https、socks5、socks5h。
 * 全部零依赖自己实现——SOCKS5 握手只有几十行，不值得为它引一个包。
 */

export type ProxyKind = "http" | "https" | "socks5" | "socks5h";

export interface ProxySpec {
  kind: ProxyKind;
  host: string;
  port: number;
  username: string;
  password: string;
  /** 原始写法，仅用于日志 */
  raw: string;
}

const DEFAULT_PORTS: Record<ProxyKind, number> = {
  http: 80,
  https: 443,
  socks5: 1080,
  socks5h: 1080
};

/** 允许不带协议的 host:port，默认当 http 代理 */
export function parseProxySpec(raw: string): ProxySpec | null {
  const s = String(raw ?? "").trim();
  if (!s) return null;

  /* 已经带协议就直接解析；不带协议的按 http 补上 */
  const hasScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(s);
  let u: URL;
  try {
    u = new URL(hasScheme ? s : "http://" + s);
  } catch {
    throw new Error("代理地址无法解析（检查主机名与端口是否在 1-65535）：" + s);
  }

  const scheme = u.protocol.replace(/:$/, "").toLowerCase();
  let kind: ProxyKind;
  if (scheme === "http") kind = "http";
  else if (scheme === "https") kind = "https";
  else if (scheme === "socks5" || scheme === "socks5h") kind = scheme;
  else if (scheme === "socks" || scheme === "socks4" || scheme === "socks4a") {
    throw new Error("不支持 " + scheme + " 代理，请用 socks5:// 或 socks5h://");
  } else {
    throw new Error("无法识别的代理协议：" + scheme);
  }

  if (!u.hostname) throw new Error("代理地址缺少主机名：" + s);
  const port = Number(u.port) || DEFAULT_PORTS[kind];
  if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error("代理端口非法：" + u.port);

  return {
    kind,
    host: u.hostname,
    port,
    username: u.username ? decodeURIComponent(u.username) : "",
    password: u.password ? decodeURIComponent(u.password) : "",
    raw: s
  };
}

/** 打日志用：抹掉密码 */
export function describeProxy(spec: ProxySpec): string {
  const auth = spec.username ? spec.username + ":***@" : "";
  return spec.kind + "://" + auth + spec.host + ":" + spec.port;
}

/* ------------------------------------------------------------------ */
/* SOCKS5                                                              */
/* ------------------------------------------------------------------ */

const SOCKS5_ERRORS: Record<number, string> = {
  0x01: "代理内部故障",
  0x02: "规则不允许连接",
  0x03: "网络不可达",
  0x04: "主机不可达",
  0x05: "目标拒绝连接",
  0x06: "TTL 超时",
  0x07: "不支持的指令",
  0x08: "不支持的地址类型"
};

interface SocketReader {
  take(n: number): Promise<Buffer>;
  detach(): Buffer;
}

/**
 * 在握手里按需取字节。socket 全程保持 paused，
 * 取数据时短暂 resume，拿够就立刻 pause，避免多余字节在交接时丢掉。
 */
function createReader(socket: net.Socket, timeoutMs: number): SocketReader {
  let chunks: Buffer[] = [];
  let size = 0;
  let notify: (() => void) | null = null;
  let failed: Error | null = null;

  const wake = (): void => {
    const n = notify;
    notify = null;
    n?.();
  };
  const onData = (c: Buffer): void => {
    chunks.push(c);
    size += c.length;
    wake();
  };
  const onError = (e: Error): void => {
    failed = e;
    wake();
  };
  const onClose = (): void => {
    failed = failed ?? new Error("SOCKS5 代理提前关闭了连接");
    wake();
  };

  socket.on("data", onData);
  socket.on("error", onError);
  socket.on("close", onClose);

  return {
    async take(n: number): Promise<Buffer> {
      const deadline = Date.now() + timeoutMs;
      while (size < n) {
        if (failed) throw failed;
        const left = deadline - Date.now();
        if (left <= 0) throw new Error("SOCKS5 握手超时");
        socket.resume();
        await new Promise<void>((resolve) => {
          notify = resolve;
          const t = setTimeout(resolve, left);
          if (typeof t.unref === "function") t.unref();
        });
        socket.pause();
      }
      if (failed) throw failed;
      const all = Buffer.concat(chunks, size);
      const out = Buffer.from(all.subarray(0, n));
      const rest = all.subarray(n);
      chunks = rest.length ? [Buffer.from(rest)] : [];
      size = rest.length;
      return out;
    },
    detach(): Buffer {
      socket.off("data", onData);
      socket.off("error", onError);
      socket.off("close", onClose);
      const rest = size ? Buffer.concat(chunks, size) : Buffer.alloc(0);
      chunks = [];
      size = 0;
      return rest;
    }
  };
}

function writeIPv6(buf: Buffer, offset: number, addr: string): void {
  const groups = expandIPv6(addr);
  for (let i = 0; i < 8; i++) buf.writeUInt16BE(groups[i], offset + i * 2);
}

function expandIPv6(addr: string): number[] {
  let head = addr;
  let tail = "";
  const dc = addr.indexOf("::");
  if (dc !== -1) {
    head = addr.slice(0, dc);
    tail = addr.slice(dc + 2);
  }
  const parse = (s: string): number[] =>
    s
      .split(":")
      .filter((x) => x.length > 0)
      .map((x) => parseInt(x, 16));
  const h = parse(head);
  const t = parse(tail);
  const zeros = new Array<number>(Math.max(0, 8 - h.length - t.length)).fill(0);
  return [...h, ...zeros, ...t].slice(0, 8);
}

/** 组装 SOCKS5 的目标地址字段。socks5h 交给代理解析域名，socks5 在本地解析。 */
async function buildSocks5Address(spec: ProxySpec, host: string): Promise<Buffer> {
  const ipVer = net.isIP(host);
  if (ipVer === 4) {
    const parts = host.split(".").map((x) => Number(x));
    return Buffer.from([0x01, parts[0], parts[1], parts[2], parts[3]]);
  }
  if (ipVer === 6) {
    const buf = Buffer.alloc(17);
    buf[0] = 0x04;
    writeIPv6(buf, 1, host);
    return buf;
  }

  if (spec.kind === "socks5") {
    /* 本地解析：把域名换成 IP 再交给代理 */
    const { address } = await dns.promises.lookup(host, { family: 0 });
    if (net.isIP(address) === 4) {
      const parts = address.split(".").map((x) => Number(x));
      return Buffer.from([0x01, parts[0], parts[1], parts[2], parts[3]]);
    }
    const buf = Buffer.alloc(17);
    buf[0] = 0x04;
    writeIPv6(buf, 1, address);
    return buf;
  }

  const name = Buffer.from(host, "utf8");
  if (name.length > 255) throw new Error("SOCKS5 目标域名过长");
  return Buffer.concat([Buffer.from([0x03, name.length]), name]);
}

function connectTcp(host: string, port: number, timeoutMs: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("连接代理超时 " + host + ":" + port));
    }, timeoutMs);
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.setNoDelay(true);
      resolve(socket);
    });
    socket.once("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}

async function socks5Connect(
  spec: ProxySpec,
  targetHost: string,
  targetPort: number,
  timeoutMs: number
): Promise<net.Socket> {
  const socket = await connectTcp(spec.host, spec.port, timeoutMs);
  /* 先暂停再挂 data 监听，否则多余字节会在交接时丢掉 */
  socket.pause();
  const reader = createReader(socket, timeoutMs);

  try {
    /* 1) 问候：声明我们支持的方式 */
    const methods = spec.username ? [0x00, 0x02] : [0x00];
    socket.write(Buffer.from([0x05, methods.length, ...methods]));

    const greet = await reader.take(2);
    if (greet[0] !== 0x05) throw new Error("SOCKS5 代理响应版本不符：" + greet[0]);
    const method = greet[1];

    /* 2) 认证 */
    if (method === 0x02) {
      const u = Buffer.from(spec.username, "utf8");
      const p = Buffer.from(spec.password, "utf8");
      if (u.length > 255 || p.length > 255) throw new Error("SOCKS5 用户名或密码超过 255 字节");
      socket.write(Buffer.concat([Buffer.from([0x01, u.length]), u, Buffer.from([p.length]), p]));
      const auth = await reader.take(2);
      if (auth[1] !== 0x00) throw new Error("SOCKS5 用户名密码认证失败");
    } else if (method === 0x00) {
      /* 不需要认证 */
    } else if (method === 0xff) {
      throw new Error("SOCKS5 代理拒绝了所有可用的认证方式");
    } else {
      throw new Error("SOCKS5 代理要求不支持的认证方式：" + method);
    }

    /* 3) CONNECT */
    const addr = await buildSocks5Address(spec, targetHost);
    const portBuf = Buffer.alloc(2);
    portBuf.writeUInt16BE(targetPort, 0);
    socket.write(Buffer.concat([Buffer.from([0x05, 0x01, 0x00]), addr, portBuf]));

    const head = await reader.take(4);
    if (head[0] !== 0x05) throw new Error("SOCKS5 应答版本不符：" + head[0]);
    if (head[1] !== 0x00) {
      throw new Error("SOCKS5 连接失败：" + (SOCKS5_ERRORS[head[1]] ?? "未知错误码 " + head[1]));
    }

    /* 4) 吃掉绑定地址，长度随类型而定 */
    const atyp = head[3];
    if (atyp === 0x01) await reader.take(4 + 2);
    else if (atyp === 0x04) await reader.take(16 + 2);
    else if (atyp === 0x03) {
      const l = await reader.take(1);
      await reader.take(l[0] + 2);
    } else throw new Error("SOCKS5 应答里的地址类型未知：" + atyp);

    const leftover = reader.detach();
    if (leftover.length) socket.unshift(leftover);
    socket.setTimeout(0);
    /* 必须恢复流动：握手期间一直 paused，不 resume 的话
       Agent 挂上 data 监听也收不到任何字节，请求就永远等在那儿 */
    socket.resume();
    return socket;
  } catch (e) {
    reader.detach();
    socket.destroy();
    throw e;
  }
}

/* ------------------------------------------------------------------ */
/* HTTP / HTTPS 代理（CONNECT 隧道）                                    */
/* ------------------------------------------------------------------ */

function httpConnect(
  spec: ProxySpec,
  targetHost: string,
  targetPort: number,
  timeoutMs: number
): Promise<Duplex> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { host: targetHost + ":" + targetPort };
    if (spec.username) {
      headers["proxy-authorization"] =
        "Basic " + Buffer.from(spec.username + ":" + spec.password, "utf8").toString("base64");
    }

    /* https 代理：先跟代理本身建 TLS，再在隧道里发 CONNECT */
    const overTls = spec.kind === "https";
    const req = http.request({
      host: spec.host,
      port: spec.port,
      method: "CONNECT",
      path: targetHost + ":" + targetPort,
      headers,
      agent: false,
      ...(overTls
        ? {
            createConnection: (): net.Socket =>
              tls.connect({ host: spec.host, port: spec.port, servername: spec.host })
          }
        : {})
    });

    const timer = setTimeout(() => {
      req.destroy(new Error("代理 CONNECT 超时 " + spec.host + ":" + spec.port));
    }, timeoutMs);

    req.on("connect", (res, socket) => {
      clearTimeout(timer);
      const s = socket as net.Socket;
      if (res.statusCode !== 200) {
        s.destroy();
        reject(new Error("代理 CONNECT 被拒：" + res.statusCode + " " + res.statusMessage));
        return;
      }
      s.setNoDelay(true);
      resolve(s);
    });
    req.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    req.end();
  });
}

/* ------------------------------------------------------------------ */

/** 经代理连到目标，返回一条已经打通、可以直接当隧道用的 socket */
export function connectViaProxy(
  spec: ProxySpec,
  targetHost: string,
  targetPort: number,
  timeoutMs: number
): Promise<Duplex> {
  if (spec.kind === "socks5" || spec.kind === "socks5h") {
    return socks5Connect(spec, targetHost, targetPort, timeoutMs);
  }
  return httpConnect(spec, targetHost, targetPort, timeoutMs);
}
