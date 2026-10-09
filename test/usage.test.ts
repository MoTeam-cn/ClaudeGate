#!/usr/bin/env node
/**
 * 用量统计、额度耗尽封印与恢复的测试。
 * 运行：node test/usage.test.ts
 */

import http from "node:http";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

import { createGateway } from "../src/server.ts";
import { detectExhaustion } from "../src/pool/exhaustion.ts";
import { normalizeOauthUsage, observeRateLimit, windowsFromRateLimit } from "../src/pool/usage.ts";
import { request, getText, asRecord } from "./helpers/client.ts";
import type { AddressInfo } from "node:net";
import type { RateLimitObservation } from "../src/types.ts";

let pass = 0;
let fail = 0;
const failures: string[] = [];

function ok(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    pass++;
    console.log("  PASS  " + name);
  } else {
    fail++;
    const line = name + (detail ? " :: " + detail : "");
    failures.push(line);
    console.log("  FAIL  " + line);
  }
}
function eq(name: string, actual: unknown, expected: unknown): void {
  ok(name, actual === expected, "expected=" + JSON.stringify(expected) + " actual=" + JSON.stringify(actual));
}
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

const watchdog = setTimeout(() => {
  console.log("\n!! 测试超时（60s），已中断");
  process.exit(3);
}, 60000);

const cleanup: Array<() => Promise<void>> = [];
const dataDirs: string[] = [];
function newDir(tag: string): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "cg-usage-" + tag + "-"));
  dataDirs.push(d);
  return d;
}

const NOW = Math.floor(Date.now() / 1000);

/* ============ A. 额度耗尽判定 ============ */
console.log("\n=== A. 额度耗尽判定 ===");

const rlRejected: RateLimitObservation = {
  unifiedStatus: "rejected",
  fiveHourReset: NOW + 900,
  sevenDayReset: NOW + 86400 * 3,
  overageDisabledReason: "out_of_credits",
  dimensions: {}
};

const a1 = detectExhaustion({ status: 403, errorType: "billing_error", message: "usage limit reached", rateLimit: rlRejected });
eq("billing_error 判定耗尽", a1.exhausted, true);
ok("billing_error 原因可读", a1.reason.includes("billing_error"), a1.reason);
ok("取最早重置（5 小时窗）", a1.resetAt === NOW + 900, String(a1.resetAt));

const a2 = detectExhaustion({ status: 400, message: "Your credit balance is too low to access the API." });
eq("余额不足文案判定耗尽", a2.exhausted, true);
ok("原因含余额", a2.reason.includes("余额"), a2.reason);
ok("没有重置头时给默认 5 小时", a2.resetAt !== null && a2.resetAt > NOW + 3000, String(a2.resetAt));

const a3 = detectExhaustion({ status: 400, message: "usage credits are required for this request" });
eq("需要开用量额度判定耗尽", a3.exhausted, true);

const a4 = detectExhaustion({ status: 400, message: "You have reached your specified usage limits" });
eq("自定义上限文案判定耗尽", a4.exhausted, true);

const a5 = detectExhaustion({ status: 429, errorType: "rate_limit_error", message: "Rate limited", rateLimit: rlRejected });
eq("429 加 rejected 头判定耗尽", a5.exhausted, true);

const a6 = detectExhaustion({
  status: 429,
  errorType: "rate_limit_error",
  message: "Rate limited",
  rateLimit: { unifiedStatus: "allowed_warning", fiveHourReset: NOW + 600, sevenDayReset: null, overageDisabledReason: null, dimensions: {} }
});
eq("普通 429 不算耗尽", a6.exhausted, false);

const a7 = detectExhaustion({ status: 400, errorType: "invalid_request_error", message: "messages: field required" });
eq("普通 400 不算耗尽", a7.exhausted, false);

const a8 = detectExhaustion({
  status: 429,
  errorType: "rate_limit_error",
  message: "Rate limited",
  rateLimit: { unifiedStatus: "rejected", fiveHourReset: NOW + 86400 * 10, sevenDayReset: null, overageDisabledReason: null, dimensions: {} }
});
ok("禁用时长封顶 6 小时", a8.resetAt !== null && a8.resetAt <= NOW + 6 * 3600 + 2, String(a8.resetAt));
ok("溢出不可用原因带进说明", a1.reason.includes("out_of_credits"), a1.reason);

/* ============ B. 用量响应归一化 ============ */
console.log("\n=== B. 用量归一化 ===");

const usagePayload = {
  subscription_type: "max",
  rate_limits_available: true,
  rate_limits: {
    five_hour: { utilization: 0.42, resets_at: String(NOW + 1800) },
    seven_day: { utilization: 0.87, resets_at: String(NOW + 86400 * 2) },
    seven_day_opus: null,
    extra_usage: { is_enabled: true, monthly_limit: 5000, used_credits: 1200, utilization: 0.24, currency: "USD" }
  },
  limits: [
    { status: "allowed_warning", rateLimitType: "seven_day", utilization: 0.87, resetsAt: NOW + 86400 * 2 },
    { status: "rejected", rateLimitType: "seven_day_sonnet", utilization: 1.02, resetsAt: NOW + 3600 }
  ]
};
const u1 = normalizeOauthUsage(usagePayload);
eq("归一化成功", u1.ok, true);
eq("来源标记为 oauth", u1.source, "oauth");
eq("套餐类型", u1.subscriptionType, "max");
eq("5 小时利用率", u1.windows.five_hour?.utilization, 0.42);
eq("5 小时重置（字符串秒）", u1.windows.five_hour?.resetsAt, NOW + 1800);
eq("7 天利用率", u1.windows.seven_day?.utilization, 0.87);
eq("limits 覆盖出 rejected 状态", u1.windows.seven_day_sonnet?.status, "rejected");
eq("额外用量解析", (u1.extraUsage as Record<string, unknown>)?.monthly_limit, 5000);

const u2 = normalizeOauthUsage({ rate_limits: { five_hour: { utilization: 0.1, resets_at: "2026-10-10T00:00:00Z" } } });
eq("ISO 时间也能解析", typeof u2.windows.five_hour?.resetsAt, "number");

const u3 = normalizeOauthUsage({ rate_limits_available: false, rate_limits: null });
eq("无用量接口时不报错", u3.ok, true);
eq("无窗口", Object.keys(u3.windows).length, 0);

/* ============ C. 响应头观测 ============ */
console.log("\n=== C. 响应头观测 ===");

const rl = observeRateLimit({
  "anthropic-ratelimit-unified-status": "allowed_warning",
  "anthropic-ratelimit-unified-5h-reset": String(NOW + 1200),
  "anthropic-ratelimit-unified-7d-reset": String(NOW + 500000),
  "anthropic-ratelimit-unified-overage-disabled-reason": "org_level_disabled",
  "anthropic-ratelimit-requests-limit": "1000",
  "anthropic-ratelimit-requests-remaining": "750",
  "anthropic-ratelimit-requests-reset": String(NOW + 60)
});
ok("解析出限流观测", rl !== null);
eq("unified 状态", rl?.unifiedStatus, "allowed_warning");
eq("5 小时重置", rl?.fiveHourReset, NOW + 1200);
eq("溢出不可用原因", rl?.overageDisabledReason, "org_level_disabled");
eq("维度 requests 上限", rl?.dimensions.requests?.limit, 1000);
eq("维度 requests 剩余", rl?.dimensions.requests?.remaining, 750);

eq("无关响应头返回 null", observeRateLimit({ "content-type": "application/json" }), null);

const w = windowsFromRateLimit(rl);
eq("由响应头推出 5 小时窗口", typeof w.five_hour?.resetsAt, "number");
eq("维度利用率按剩余推算", Math.round((w["dim:requests"]?.utilization ?? 0) * 100), 25);

/* ============ D. 端到端 ============ */
console.log("\n=== D. 端到端 ===");

/** 可控上游：能返回正常响应、额度耗尽错误，也能提供 /api/oauth/usage */
function createUsageUpstream() {
  let mode: "ok" | "exhausted" = "ok";
  let usageCalls = 0;
  const seenAuth: string[] = [];

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const url = req.url ?? "/";

      if (url.startsWith("/api/oauth/usage")) {
        usageCalls += 1;
        seenAuth.push(String(req.headers.authorization ?? ""));
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          subscription_type: "max",
          rate_limits_available: true,
          rate_limits: {
            five_hour: { utilization: 0.31, resets_at: String(Math.floor(Date.now() / 1000) + 3600) },
            seven_day: { utilization: 0.62, resets_at: String(Math.floor(Date.now() / 1000) + 86400) }
          }
        }));
        return;
      }

      if (!url.startsWith("/v1/messages")) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end("{}");
        return;
      }

      if (mode === "exhausted") {
        res.writeHead(403, {
          "content-type": "application/json",
          "anthropic-ratelimit-unified-status": "rejected",
          "anthropic-ratelimit-unified-5h-reset": String(Math.floor(Date.now() / 1000) + 900),
          "anthropic-ratelimit-unified-overage-disabled-reason": "out_of_credits"
        });
        res.end(JSON.stringify({
          type: "error",
          error: { type: "billing_error", message: "usage limit reached — check plan" }
        }));
        return;
      }

      let parsed: { stream?: boolean } = {};
      try {
        parsed = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as { stream?: boolean };
      } catch {
        /* 忽略 */
      }

      if (parsed.stream) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        const events: Array<[string, unknown]> = [
          ["message_start", { type: "message_start", message: { id: "msg_x", model: "m", usage: { input_tokens: 11, cache_creation_input_tokens: 5, cache_read_input_tokens: 3 } } }],
          ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
          ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } }],
          ["content_block_stop", { type: "content_block_stop", index: 0 }],
          ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 7 } }],
          ["message_stop", { type: "message_stop" }]
        ];
        let i = 0;
        const tick = (): void => {
          if (i >= events.length) { res.end(); return; }
          res.write("event: " + events[i][0] + "\n");
          res.write("data: " + JSON.stringify(events[i][1]) + "\n\n");
          i += 1;
          setTimeout(tick, 2);
        };
        tick();
        return;
      }

      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        id: "msg_x",
        model: "m",
        content: [{ type: "text", text: "ok" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 11, output_tokens: 7, cache_creation_input_tokens: 5, cache_read_input_tokens: 3 }
      }));
    });
  });

  return {
    setMode(m: "ok" | "exhausted") { mode = m; },
    get usageCalls() { return usageCalls; },
    get seenAuth() { return seenAuth; },
    listen(): Promise<number> {
      return new Promise((r) => server.listen(0, "127.0.0.1", () => r((server.address() as AddressInfo).port)));
    },
    close(): Promise<void> {
      if (typeof server.closeAllConnections === "function") server.closeAllConnections();
      return new Promise((r) => server.close(() => r()));
    }
  };
}

const upstream = createUsageUpstream();
const upPort = await upstream.listen();
cleanup.push(() => upstream.close());

const ADMIN = "usage-admin";
const gw = createGateway({
  PORT: "0",
  HOST: "127.0.0.1",
  DATA_DIR: newDir("main"),
  SECRET: "usage-secret",
  UPSTREAM_BASE: "http://127.0.0.1:" + upPort,
  GUARD_MODE: "strict",
  STEGO_MODE: "block",
  ADMIN_TOKEN: ADMIN,
  LOG_LEVEL: "error"
});
const addr = await gw.listen(0, "127.0.0.1");
cleanup.push(() => gw.close());

const acc1 = gw.accounts.create({
  label: "订阅号一",
  kind: "oauth",
  accessToken: "oauth-token-1",
  refreshToken: "refresh-1",
  expiresAt: Math.floor(Date.now() / 1000) + 7200
});
const acc2 = gw.accounts.create({ label: "Console 号二", kind: "apikey", apiKey: "sk-ant-two" });

const key = gw.keys.create({ name: "usage-key", fingerprintMode: "passthrough" });
const CC: Record<string, string> = {
  "content-type": "application/json",
  "x-api-key": key.plaintext,
  "user-agent": "claude-cli/2.1.293 (external, cli)",
  "x-app": "cli",
  "anthropic-version": "2023-06-01",
  "x-claude-code-session-id": "sess-usage-1"
};
const BODY = { model: "claude-sonnet-4-5-20250929", max_tokens: 32, messages: [{ role: "user", content: "hi" }] };

/* D1 非流式 token 计数 */
const nonStream = await request(addr.port, "/v1/messages", { headers: CC, body: BODY });
eq("非流式成功", nonStream.status, 200);
await sleep(120);
const log1 = gw.logs.queryRequests({ limit: 1 });
eq("非流式 input_tokens", log1.rows[0]?.promptTokens, 11);
eq("非流式 output_tokens", log1.rows[0]?.completionTokens, 7);
eq("非流式 cache_creation", log1.rows[0]?.cacheCreationTokens, 5);
eq("非流式 cache_read", log1.rows[0]?.cacheReadTokens, 3);

/* D2 流式 token 计数 */
const streamRes = await request(addr.port, "/v1/messages", { headers: CC, body: { ...BODY, stream: true } });
eq("流式成功", streamRes.status, 200);
ok("流式确实有 SSE 帧", streamRes.text.includes("message_start"), streamRes.text.slice(0, 80));
await sleep(150);
const log2 = gw.logs.queryRequests({ limit: 1 });
eq("流式 input_tokens", log2.rows[0]?.promptTokens, 11);
eq("流式 output_tokens", log2.rows[0]?.completionTokens, 7);
eq("流式 cache_creation", log2.rows[0]?.cacheCreationTokens, 5);
eq("流式 cache_read", log2.rows[0]?.cacheReadTokens, 3);
eq("流式标记", log2.rows[0]?.stream, true);

/* D3 Key 用量把 cache 计入总额度 */
gw.quota.flush();
const keyUsage = gw.keys.usage(key.record.id, new Date().toISOString().slice(0, 10));
eq("Key 请求数", keyUsage.requests, 2);
eq("Key cache 用量", keyUsage.cacheTokens, 16);

/* D4 查询上游用量 */
const usageRes = await request(addr.port, "/panel/api?action=account.usage&key=" + ADMIN, {
  method: "POST",
  body: { id: acc1.id }
});
eq("查用量 200", usageRes.status, 200);
const usageData = (asRecord(usageRes.json).data as Array<Record<string, unknown>>)[0] ?? {};
eq("查用量命中 oauth 账号", usageData.ok, true);
eq("上游收到 Bearer", upstream.seenAuth[0], "Bearer oauth-token-1");
eq("用量已落库", gw.accounts.get(acc1.id)?.usage?.windows.five_hour?.utilization, 0.31);

const consoleUsage = await request(addr.port, "/panel/api?action=account.usage&key=" + ADMIN, {
  method: "POST",
  body: { id: acc2.id }
});
const consoleData = (asRecord(consoleUsage.json).data as Array<Record<string, unknown>>)[0] ?? {};
eq("Console Key 查询被明确拒绝", consoleData.ok, false);
ok("给出可读原因", String(consoleData.error).includes("订阅"), String(consoleData.error));

/* D5 额度耗尽封印 + 故障转移 */
upstream.setMode("exhausted");
const exhaustedRes = await request(addr.port, "/v1/messages", { headers: CC, body: BODY });
eq("耗尽错误原样返回 403", exhaustedRes.status, 403);
await sleep(150);
const sealed = gw.accounts.get(acc1.id);
eq("账号被标记 exhausted", sealed?.status, "exhausted");
ok("记录耗尽原因", String(sealed?.exhaustedReason).includes("billing_error"), String(sealed?.exhaustedReason));
ok("记录恢复时刻", (sealed?.exhaustedUntil ?? 0) > Math.floor(Date.now() / 1000), String(sealed?.exhaustedUntil));
ok("恢复时刻不超 6 小时", (sealed?.exhaustedUntil ?? 0) <= Math.floor(Date.now() / 1000) + 6 * 3600 + 2);

const snap = gw.scheduler.snapshot();
eq("快照里耗尽数为 1", snap.exhausted, 1);

/* 耗尽账号不再被选中，请求落到另一个号 */
const afterSeal = await request(addr.port, "/v1/messages", {
  headers: { ...CC, "x-claude-code-session-id": "sess-usage-2" },
  body: BODY
});
eq("耗尽后仍能靠另一个号成功", afterSeal.status, 403);
await sleep(120);
const logsAfter = gw.logs.queryRequests({ limit: 2 });
ok("耗尽号没被再次使用", logsAfter.rows.some((r) => r.accountId === acc2.id), JSON.stringify(logsAfter.rows.map((r) => r.accountId)));

/* D6 面板展示 */
const accList = await getText(addr.port, "/panel/api?action=accounts&key=" + ADMIN);
const rows = asRecord(accList.json).data as Array<Record<string, unknown>>;
const row1 = rows.find((r) => r.id === acc1.id) ?? {};
eq("面板显示 exhausted", row1.status, "exhausted");
ok("面板带耗尽原因", !!row1.exhaustedReason, JSON.stringify(row1.exhaustedReason));
ok("面板带用量窗口", !!asRecord(row1.usage).windows, JSON.stringify(asRecord(row1.usage).windows).slice(0, 120));

const ov = await getText(addr.port, "/panel/api?action=overview&key=" + ADMIN);
/* 两个号都被同一个上游错误封印，所以这里是 2 —— 与账号表实际状态对齐 */
eq(
  "概览统计耗尽数与账号表一致",
  asRecord(asRecord(asRecord(ov.json).data).pool).exhausted,
  gw.accounts.list().filter((a) => a.status === "exhausted").length
);
eq("此时两个号都已封印", gw.accounts.list().filter((a) => a.status === "exhausted").length, 2);
ok("概览有耗尽清单", Array.isArray(asRecord(asRecord(asRecord(ov.json).data).pool).exhaustedList));

/* D7 手动恢复 */
const revived = await request(addr.port, "/panel/api?action=account.revive&key=" + ADMIN, {
  method: "POST",
  body: { id: acc1.id }
});
eq("手动恢复 200", revived.status, 200);
eq("状态回到 active", gw.accounts.get(acc1.id)?.status, "active");
eq("耗尽时刻已清空", gw.accounts.get(acc1.id)?.exhaustedUntil, null);

/* D8 到期自动恢复 */
gw.accounts.markExhausted(acc2.id, "占位", Math.floor(Date.now() / 1000) + 3600);
gw.accounts.markExhausted(acc1.id, "测试自动恢复", Math.floor(Date.now() / 1000) - 10);
eq("重新封印为 exhausted", gw.accounts.get(acc1.id)?.status, "exhausted");
gw.scheduler.pick({ sessionKey: "force-revive" });
eq("到点后调度器自动放回", gw.accounts.get(acc1.id)?.status, "active");

/* D9 Console Key 的响应头也能落库 */
upstream.setMode("ok");
gw.scheduler.observeRateLimit(acc2.id, {
  unifiedStatus: "allowed_warning",
  fiveHourReset: Math.floor(Date.now() / 1000) + 600,
  sevenDayReset: null,
  overageDisabledReason: null,
  dimensions: { requests: { limit: 100, remaining: 90, reset: Math.floor(Date.now() / 1000) + 60 } }
});
gw.scheduler.stop();
const rlSaved = gw.accounts.get(acc2.id)?.rateLimit;
eq("响应头观测已落库", rlSaved?.unifiedStatus, "allowed_warning");
ok("维度数据也在", rlSaved?.dimensions.requests?.remaining === 90, JSON.stringify(rlSaved?.dimensions));

for (const fn of cleanup) {
  try { await fn(); } catch { /* 忽略 */ }
}
for (const d of dataDirs) {
  try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* 忽略 */ }
}

clearTimeout(watchdog);
console.log("\n================================");
console.log("  PASS " + pass + "   FAIL " + fail);
if (fail) {
  console.log("  失败项：");
  for (const f of failures) console.log("   - " + f);
}
console.log("================================\n");
process.exit(fail ? 1 : 0);
