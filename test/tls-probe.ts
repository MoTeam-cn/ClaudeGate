#!/usr/bin/env node
/**
 * 原始 TLS ClientHello 抓取器：解析并打印 JA3 三元组，用来对比
 * 「真 Claude Code 的 TLS 指纹」与「网关的 TLS 指纹」。
 * 自签证书不用管——ClientHello 在证书之前就发出来了。
 * 运行：node test/tls-probe.ts <port>
 */
import net from "node:net";
import crypto from "node:crypto";
import fs from "node:fs";

const port = Number(process.argv[2] || 3199);
const out = process.env.TLS_OUT || "";

const GREASE = new Set([0x0a0a, 0x1a1a, 0x2a2a, 0x3a3a, 0x4a4a, 0x5a5a, 0x6a6a, 0x7a7a,
  0x8a8a, 0x9a9a, 0xaaaa, 0xbaba, 0xcaca, 0xdada, 0xeaea, 0xfafa]);

const EXT_NAMES: Record<number, string> = {
  0: "server_name", 5: "status_request", 10: "supported_groups", 11: "ec_point_formats",
  13: "signature_algorithms", 16: "application_layer_protocol_negotiation", 18: "signed_certificate_timestamp",
  21: "padding", 23: "extended_master_secret", 27: "compress_certificate", 35: "session_ticket",
  41: "pre_shared_key", 42: "early_data", 43: "supported_versions", 44: "cookie",
  45: "psk_key_exchange_modes", 49: "post_handshake_auth", 50: "signature_algorithms_cert",
  51: "key_share", 57: "quic_transport_parameters", 65281: "renegotiation_info",
  17513: "application_settings", 30032: "channel_id"
};

function parseHello(buf: Buffer): Record<string, unknown> | null {
  let p = 0;
  if (buf[p] !== 0x16) return null;
  p += 1;
  const recVer = buf.readUInt16BE(p); p += 2;
  const recLen = buf.readUInt16BE(p); p += 2;
  if (buf.length < p + recLen) return null;
  if (buf[p] !== 0x01) return null;
  p += 4; // handshake type + length(3)

  const clientVer = buf.readUInt16BE(p); p += 2;
  p += 32; // random

  const sidLen = buf[p]; p += 1 + sidLen;

  const csLen = buf.readUInt16BE(p); p += 2;
  const ciphers: number[] = [];
  for (let i = 0; i < csLen; i += 2) ciphers.push(buf.readUInt16BE(p + i));
  p += csLen;

  const compLen = buf[p]; p += 1;
  const comps = [...buf.subarray(p, p + compLen)];
  p += compLen;

  const exts: number[] = [];
  let curves: number[] = [];
  let points: number[] = [];
  let alpn: string[] = [];
  let sni = "";
  let supportedVersions: number[] = [];

  if (p + 2 <= buf.length) {
    const extTotal = buf.readUInt16BE(p); p += 2;
    const end = Math.min(buf.length, p + extTotal);
    while (p + 4 <= end) {
      const et = buf.readUInt16BE(p);
      const el = buf.readUInt16BE(p + 2);
      p += 4;
      const data = buf.subarray(p, p + el);
      p += el;
      if (!GREASE.has(et)) exts.push(et);

      if (et === 10 && data.length >= 2) {
        const n = data.readUInt16BE(0);
        for (let i = 0; i < n; i += 2) {
          const g = data.readUInt16BE(2 + i);
          if (!GREASE.has(g)) curves.push(g);
        }
      } else if (et === 11 && data.length >= 1) {
        const n = data[0];
        for (let i = 0; i < n; i++) points.push(data[1 + i]);
      } else if (et === 16 && data.length >= 2) {
        const n = data.readUInt16BE(0);
        let q = 2;
        for (let i = 0; i < n && q < data.length; i++) {
          const l = data[q]; q += 1;
          alpn.push(data.subarray(q, q + l).toString("utf8")); q += l;
        }
      } else if (et === 0 && data.length >= 5) {
        const l = data.readUInt16BE(3);
        sni = data.subarray(5, 5 + l).toString("utf8");
      } else if (et === 43 && data.length >= 1) {
        const n = data[0];
        for (let i = 0; i < n; i += 2) supportedVersions.push(data.readUInt16BE(1 + i));
      }
    }
  }

  const hex = (a: number[]): string => a.map((x) => x.toString(16)).join("-");
  const ja3Str = [
    clientVer,
    ciphers.filter((c) => !GREASE.has(c)).join("-"),
    exts.join("-"),
    curves.join("-"),
    points.join("-")
  ].join(",");
  const ja3 = crypto.createHash("md5").update(ja3Str).digest("hex");

  return {
    recordVersion: "0x" + recVer.toString(16),
    clientVersion: "0x" + clientVer.toString(16),
    cipherCount: ciphers.filter((c) => !GREASE.has(c)).length,
    ciphers: hex(ciphers.filter((c) => !GREASE.has(c))),
    extensionCount: exts.length,
    extensions: exts.map((e) => (EXT_NAMES[e] ?? "ext_" + e) + "(" + e + ")"),
    curves: curves.map((c) => c.toString(16)).join("-"),
    pointFormats: points.join("-"),
    alpn,
    sni,
    supportedVersions: supportedVersions.map((v) => "0x" + v.toString(16)),
    compression: comps.join("-"),
    ja3,
    ja3Raw: ja3Str
  };
}

const server = net.createServer((sock) => {
  let buf = Buffer.alloc(0);
  sock.on("data", (c: Buffer) => {
    buf = Buffer.concat([buf, c]);
    const parsed = parseHello(buf);
    if (!parsed) return;
    const line = JSON.stringify({ label: process.env.TLS_LABEL || "?", ...parsed });
    console.log("CLIENTHELLO " + line);
    if (out) fs.appendFileSync(out, line + "\n", "utf8");
    sock.destroy();
  });
  sock.on("error", () => { /* 忽略 */ });
});
server.listen(port, "127.0.0.1", () => console.log("TLS_READY " + port));
