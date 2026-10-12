import net from "node:net";
import tls from "node:tls";
import http from "node:http";
import type { Duplex } from "node:stream";
import type { ProxySpec } from "./spec.ts";
import { socks5Connect } from "./socks5.ts";

/** 经代理建连：http/https 走 CONNECT，socks5 走握手 */

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

