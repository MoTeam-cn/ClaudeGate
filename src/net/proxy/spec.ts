/** 出站代理的规格解析与描述。零依赖，纯函数。 */

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

