#!/usr/bin/env node
/**
 * 抓包探针：把真 Claude Code 指到网关上，记录
 *   1) 网关收到的原始请求（客户端 -> 网关）
 *   2) 网关转给上游的原始请求（网关 -> Anthropic）
 *   3) 上游返回的响应（状态 + 头 + 体）
 *   4) 网关回给客户端的响应（状态 + 头 + 体）
 * 运行：node test/capture-probe.ts
 * 环境：PROBE_DIR 输出目录
 */

import http from "node:http";
import fs from "node:fs";
import path from "node:path";

import { createGateway } from "../src/server.ts";
import { signGatewayToken } from "../src/tokens.ts";
import type { AddressInfo } from "node:net";

const OUT = process.env.PROBE_DIR || path.join(process.cwd(), "probe-out");
fs.mkdirSync(OUT, { recursive: true });

const logPath = path.join(OUT, "capture.jsonl");
fs.writeFileSync(logPath, "", "utf8");

function record(kind: string, payload: Record<string, unknown>): void {
  fs.appendFileSync(logPath, JSON.stringify({ kind, at: new Date().toISOString(), ...payload }) + "\n", "utf8");
}

/* ---------- 抓包上游：模拟 Anthropic，并把收到的请求原样记下来 ---------- */
const upstreamSeen: Array<Record<string, unknown>> = [];

const upstream = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (c: Buffer) => chunks.push(c));
  req.on("end", () => {
    const body = Buffer.concat(chunks).toString("utf8");
    const entry = {
      method: req.method ?? "GET",
      url: req.url ?? "/",
      headers: req.headers as Record<string, unknown>,
      body
    };
    upstreamSeen.push(entry);
    record("upstream_request", entry);

    if ((req.url ?? "").startsWith("/api/oauth/usage")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ rate_limits_available: false, rate_limits: null }));
      return;
    }

    /* 带上一堆响应头，用来验证透传范围 */
    res.writeHead(200, {
      "content-type": "application/json",
      "request-id": "req_mock_upstream_123456",
      "anthropic-organization-id": "org_mock_1",
      "anthropic-ratelimit-requests-limit": "1000",
      "anthropic-ratelimit-requests-remaining": "997",
      "anthropic-ratelimit-requests-reset": String(Math.floor(Date.now() / 1000) + 60),
      "anthropic-ratelimit-tokens-limit": "80000",
      "anthropic-ratelimit-tokens-remaining": "79900",
      "anthropic-ratelimit-tokens-reset": String(Math.floor(Date.now() / 1000) + 60),
      "anthropic-ratelimit-unified-status": "allowed_warning",
      "anthropic-ratelimit-unified-5h-reset": String(Math.floor(Date.now() / 1000) + 1800),
      "anthropic-ratelimit-unified-7d-reset": String(Math.floor(Date.now() / 1000) + 86400),
      "x-custom-upstream-header": "should-not-pass",
      "set-cookie": "upstream_session=abc; Path=/"
    });
    res.end(JSON.stringify({
      id: "msg_mock_1",
      type: "message",
      role: "assistant",
      model: "claude-sonnet-4-5-20250929",
      content: [{ type: "text", text: "pong from mock upstream" }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 12, output_tokens: 4, cache_creation_input_tokens: 6, cache_read_input_tokens: 2 }
    }));
  });
});

const upPort = await new Promise<number>((r) => upstream.listen(0, "127.0.0.1", () => r((upstream.address() as AddressInfo).port)));

/* ---------- 网关：记录客户端原始请求与回给客户端的响应 ---------- */
const dataDir = path.join(OUT, "data");
fs.rmSync(dataDir, { recursive: true, force: true });

const gw = createGateway({
  PORT: "0",
  HOST: "127.0.0.1",
  DATA_DIR: dataDir,
  SECRET: "capture-secret",
  UPSTREAM_BASE: "http://127.0.0.1:" + upPort,
  GUARD_MODE: "strict",
  INJECT_MISSING: "false",
  STEGO_MODE: "block",
  ADMIN_TOKEN: "capture-admin",
  LOG_LEVEL: "info"
});

/* 用真实号池账号，保证走的是正常链路 */
gw.accounts.create({
  label: "抓包号",
  kind: "oauth",
  accessToken: "upstream-oauth-access-token",
  refreshToken: "upstream-refresh",
  expiresAt: Math.floor(Date.now() / 1000) + 7200,
  scope: "user:inference"
});

/* 在网关最外层再包一层，记录客户端进来的原始请求与最终响应 */
const outer = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (c: Buffer) => chunks.push(c));
  req.on("end", () => {
    const body = Buffer.concat(chunks).toString("utf8");
    if ((req.url ?? "").startsWith("/v1/")) {
      record("client_request", {
        method: req.method ?? "GET",
        url: req.url ?? "/",
        headers: req.headers as Record<string, unknown>,
        body
      });
    }
    const resChunks: Buffer[] = [];
    const origWrite = res.write.bind(res);
    const origEnd = res.end.bind(res);
    (res as unknown as { write: unknown }).write = (c: Buffer, ...rest: unknown[]) => {
      if (c) resChunks.push(Buffer.from(c));
      return (origWrite as (...a: unknown[]) => boolean)(c, ...rest);
    };
    (res as unknown as { end: unknown }).end = (c?: Buffer, ...rest: unknown[]) => {
      if (c) resChunks.push(Buffer.from(c));
      if ((req.url ?? "").startsWith("/v1/")) {
        record("client_response", {
          status: res.statusCode,
          headers: res.getHeaders() as Record<string, unknown>,
          body: Buffer.concat(resChunks).toString("utf8")
        });
      }
      return (origEnd as (...a: unknown[]) => unknown)(c, ...rest);
    };
    gw.server.emit("request", req, res);
  });
});

const gwPort = await new Promise<number>((r) => outer.listen(0, "127.0.0.1", () => r((outer.address() as AddressInfo).port)));

const token = signGatewayToken(gw.cfg, "default");

fs.writeFileSync(
  path.join(OUT, "info.json"),
  JSON.stringify({ gatewayUrl: "http://127.0.0.1:" + gwPort, token, upstreamPort: upPort, captureFile: logPath }, null, 2),
  "utf8"
);

console.log("PROBE_READY");
console.log("gatewayUrl=http://127.0.0.1:" + gwPort);
console.log("token=" + token);
console.log("capture=" + logPath);

process.on("SIGTERM", () => {
  record("probe_stop", {});
  process.exit(0);
});
