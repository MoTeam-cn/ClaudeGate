#!/usr/bin/env node
/**
 * access_token 的后台巡检（pool/refresh-loop.ts）。
 *
 * 验的是「不等请求来才刷」这件事：
 *   - 剩余有效期不足 lead 的号，sweep 会主动刷掉
 *   - 还有很久的号一次都不碰（不浪费刷新令牌的轮换）
 *   - 停用 / 没有 refresh_token / apikey 都跳过
 *   - 刷新失败会计数并记 lastError，不吞掉
 *   - 面板 account.token 单个与全部都工作，缺 id 400、不存在 404
 *
 * 令牌端点指到本地 mock，不碰网。
 * 运行：node test/refresh.test.ts
 */
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createGateway } from "../src/server.ts";
import { request, getText } from "./helpers/client.ts";
import { cleanupDir } from "./helpers/tmp.ts";
import type { AddressInfo } from "node:net";

let pass = 0;
let fail = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, detail?: string): void {
  if (cond) { pass++; console.log("  PASS  " + name); }
  else { fail++; const l = name + (detail ? " :: " + detail : ""); failures.push(l); console.log("  FAIL  " + l); }
}
function eq(name: string, a: unknown, b: unknown): void {
  ok(name, a === b, "expected=" + JSON.stringify(b) + " actual=" + JSON.stringify(a));
}

const watchdog = setTimeout(() => { console.log("\n!! 超时"); process.exit(3); }, 60000);

/* ================= mock 令牌端点 ================= */
let tokenCalls = 0;
let tokenStatus = 200;
let lastTokenBody = "";

const tokenServer = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (c: Buffer) => chunks.push(c));
  req.on("end", () => {
    tokenCalls++;
    lastTokenBody = Buffer.concat(chunks).toString("utf8");
    if (tokenStatus !== 200) {
      res.writeHead(tokenStatus, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "invalid_grant", error_description: "mock rejection" }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      access_token: "at_" + tokenCalls,
      refresh_token: "rt_" + tokenCalls,
      expires_in: 3600,
      scope: "user:inference"
    }));
  });
});
const tokenPort = await new Promise<number>((r) =>
  tokenServer.listen(0, "127.0.0.1", () => r((tokenServer.address() as AddressInfo).port))
);
const tokenBase = "http://127.0.0.1:" + tokenPort;

/* ================= 网关 ================= */
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cg-refresh-"));
const ADMIN = "refresh-test-admin-token";

const gw = createGateway({
  PORT: "0",
  HOST: "127.0.0.1",
  DATA_DIR: tmp,
  SECRET: "refresh-test-secret",
  ADMIN_TOKEN: ADMIN,
  /* 巡检由测试手动驱动，不让定时器自己跑，否则计数对不上 */
  TOKEN_AUTO_REFRESH: "off",
  OAUTH_TOKEN_URL: tokenBase + "/v1/oauth/token",
  IP_CHECK: "off",
  LOG_LEVEL: "error",
  CG_ENV_FILE: "",
  CONTEXT_GUARD: "off",
  IDENTITY_MODE: "off"
});

const addr = await gw.listen(0, "127.0.0.1");
const now = Math.floor(Date.now() / 1000);

const expiring = gw.accounts.create({
  label: "即将过期", kind: "oauth",
  accessToken: "old_at", refreshToken: "old_rt", expiresAt: now + 60
});
const fresh = gw.accounts.create({
  label: "还很新", kind: "oauth",
  accessToken: "keep_at", refreshToken: "keep_rt", expiresAt: now + 3600
});
const noRT = gw.accounts.create({
  label: "没有刷新令牌", kind: "oauth",
  accessToken: "x", expiresAt: now + 60
});
const disabled = gw.accounts.create({
  label: "停用的", kind: "oauth",
  accessToken: "d", refreshToken: "d_rt", expiresAt: now + 60
});
gw.accounts.setStatus(disabled.id, "disabled", "手动停用");
const apiKeyAcc = gw.accounts.create({
  label: "Key 号", kind: "apikey", apiKey: "sk-ant-api03-xxxx", expiresAt: now + 60
});

/* ================= A. needsRefresh 语义 ================= */
console.log("\n=== A. needsRefresh ===");
const cm = gw.credentials;
ok("剩余 60 秒、lead 600 —— 该刷", cm.needsRefresh(gw.accounts.get(expiring.id)!, 600));
ok("剩余 60 秒、lead 30 —— 不该刷", !cm.needsRefresh(gw.accounts.get(expiring.id)!, 30));
ok("剩余 3600 秒、lead 600 —— 不该刷", !cm.needsRefresh(gw.accounts.get(fresh.id)!, 600));
ok("没有 refresh_token —— 不刷", !cm.needsRefresh(gw.accounts.get(noRT.id)!, 600));
ok("停用的号 —— 不刷", !cm.needsRefresh(gw.accounts.get(disabled.id)!, 600));
ok("apikey —— 不刷", !cm.needsRefresh(gw.accounts.get(apiKeyAcc.id)!, 600));

/* ================= B. sweep 只刷该刷的 ================= */
console.log("\n=== B. sweep ===");
tokenCalls = 0;
const swept = await gw.tokenRefresh.sweep(false);
eq("scanned 是号池总数", swept.scanned, 5);
eq("只刷了 1 个", swept.refreshed, 1);
eq("令牌端点只被打了一次", tokenCalls, 1);
ok("刷的是即将过期的那个", swept.results.some((r) => r.id === expiring.id && r.ok));

const afterExpiring = gw.accounts.get(expiring.id)!;
ok("access_token 换新了", afterExpiring.accessToken === "at_1", "got=" + String(afterExpiring.accessToken));
ok("refresh_token 跟着轮换", afterExpiring.refreshToken === "rt_1", "got=" + String(afterExpiring.refreshToken));
ok("expires_at 往后推了", (afterExpiring.expiresAt ?? 0) > now + 3000, "got=" + String(afterExpiring.expiresAt));
eq("新号没被碰", gw.accounts.get(fresh.id)!.accessToken, "keep_at");
eq("apikey 没被碰", gw.accounts.get(apiKeyAcc.id)!.apiKey, "sk-ant-api03-xxxx");

console.log("\n=== B2. 刚刷完再扫一次不该动 ===");
tokenCalls = 0;
const again = await gw.tokenRefresh.sweep(false);
eq("这轮没刷任何号", again.refreshed, 0);
eq("令牌端点没被打", tokenCalls, 0);
eq("统计保留了上一轮的结果", again.failed, 0);

/* ================= C. 失败要计数 ================= */
console.log("\n=== C. 刷新失败 ===");
tokenStatus = 400;
const failing = gw.accounts.create({
  label: "会被拒", kind: "oauth",
  accessToken: "f_at", refreshToken: "f_rt", expiresAt: now + 60
});
const bad = await gw.tokenRefresh.refreshOne(failing.id);
eq("failed 记成 1", bad.failed, 1);
eq("结果里 ok 是 false", bad.results[0]?.ok, false);
ok("带了错误原因", typeof bad.results[0]?.error === "string" && bad.results[0]!.error!.length > 0);
const st1 = gw.tokenRefresh.state();
ok("state.lastError 有值", typeof st1.lastError === "string" && st1.lastError!.length > 0);
ok("totalFailed 累加了", st1.totalFailed >= 1);

tokenStatus = 200;

/* ================= D. 不存在的号 ================= */
console.log("\n=== D. 边界 ===");
const ghost = await gw.tokenRefresh.refreshOne("acc_does_not_exist");
eq("不存在 —— failed 1", ghost.failed, 1);
eq("不存在 —— 带原因", ghost.results[0]?.error, "账号不存在");

/* ================= E. 面板接口 ================= */
console.log("\n=== E. 面板 account.token ===");
const noAuth = await getText(addr.port, "/panel/api?action=account.tokenState");
eq("没密钥 —— 401", noAuth.status, 401);

const stateRes = await getText(addr.port, "/panel/api?action=account.tokenState&key=" + ADMIN);
eq("tokenState 200", stateRes.status, 200);
const stateData = (stateRes.json as { data?: Record<string, unknown> }).data ?? {};
eq("enabled 跟着 env", stateData.enabled, false);
eq("intervalSec 默认 60", stateData.intervalSec, 60);
eq("leadSec 默认 600", stateData.leadSec, 600);
ok("带 requestPathRefreshes 字段", typeof stateData.requestPathRefreshes === "number");

const missingId = await request(addr.port, "/panel/api?action=account.token&key=" + ADMIN, {
  method: "POST", raw: true, body: {}
});
eq("缺 id —— 400", missingId.status, 400);

const unknownId = await request(addr.port, "/panel/api?action=account.token&key=" + ADMIN, {
  method: "POST", raw: true, body: { id: "acc_nope" }
});
eq("账号不存在 —— 404", unknownId.status, 404);

tokenCalls = 0;
const oneRes = await request(addr.port, "/panel/api?action=account.token&key=" + ADMIN, {
  method: "POST", raw: true, body: { id: fresh.id }
});
eq("单个刷新 200", oneRes.status, 200);
const oneData = (oneRes.json as { data?: Record<string, unknown> }).data ?? {};
eq("单个刷新成功", oneData.ok, true);
eq("强制刷新不看剩余时间 —— 打了一次端点", tokenCalls, 1);

tokenCalls = 0;
const allRes = await request(addr.port, "/panel/api?action=account.token&key=" + ADMIN, {
  method: "POST", raw: true, body: { all: true }
});
eq("全部刷新 200", allRes.status, 200);
const allData = (allRes.json as { data?: Record<string, unknown> }).data ?? {};
ok("全部刷新有 refreshed 字段", typeof allData.refreshed === "number");
ok("全部刷新跳过了 apikey 与停用号", (allData.skipped as number) >= 2, "skipped=" + String(allData.skipped));

/* ================= F. overview 带巡检状态 ================= */
console.log("\n=== F. overview ===");
const ov = await getText(addr.port, "/panel/api?action=overview&key=" + ADMIN);
const ovData = ((ov.json as Record<string, unknown>).data ?? {}) as Record<string, unknown>;
const tr = ovData.tokenRefresh as Record<string, unknown> | undefined;
ok("overview 带 tokenRefresh", !!tr);
ok("tokenRefresh 里有 lastRunAt", tr ? typeof tr.lastRunAt === "number" : false);

clearTimeout(watchdog);
tokenServer.close();
await gw.close();
cleanupDir(tmp);

console.log("\n" + (fail === 0 ? "全部通过" : "有失败"));
console.log("PASS " + pass + "   FAIL " + fail);
if (fail) {
  console.log("\n失败明细：");
  for (const f of failures) console.log("  - " + f);
}
process.exit(fail ? 1 : 0);
