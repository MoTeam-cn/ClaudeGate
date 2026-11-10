#!/usr/bin/env node
/**
 * 重新授权（oauth.relogin.*）—— 用新的授权码把凭证**写回已有账号**。
 *
 * 这个入口是给「refresh_token 失效、上游回 invalid_grant」准备的：
 * 以前只能删号重建，号一删 deviceId 这类指纹绑定也跟着丢；现在原地覆盖。
 *
 * 验的是：
 *   - 令牌真的换掉了，而且**没有**多出一个账号
 *   - 备注名（用户自己起的）不被覆盖
 *   - deviceId 不变 —— 这是这件事最关键的一条
 *   - 状态从 error 回到 active，error_count / lastError / 耗尽状态全清
 *   - 授权到另一个号时 switched=true，前端才能提醒
 *   - 边界：缺 id / 不存在的号 / apikey 号 / 过期 state
 *
 * 令牌、profile、用量端点全指到本地 mock，不碰网。
 * 运行：node test/relogin.test.ts
 */
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createGateway } from "../src/server.ts";
import { request } from "./helpers/client.ts";
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

/* ================= mock 上游 ================= */
let tokenCalls = 0;
let profileEmail = "quota@example.com";
let profileName = "Quota User";

const upstream = http.createServer((req, res) => {
  const u = req.url ?? "";
  const send = (code: number, body: unknown): void => {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  if (u.startsWith("/v1/oauth/token")) {
    tokenCalls++;
    send(200, {
      access_token: "new-access-token-" + tokenCalls,
      refresh_token: "new-refresh-token-" + tokenCalls,
      expires_in: 3600,
      scope: "user:inference user:profile"
    });
    return;
  }
  if (u.startsWith("/api/oauth/profile")) {
    send(200, {
      account: { display_name: profileName, full_name: profileName, email: profileEmail },
      organization: { organization_type: "claude_max", rate_limit_tier: "default_claude_max_20x", plan_display_name: "Max 20x" }
    });
    return;
  }
  if (u.startsWith("/api/oauth/claude_cli/roles")) {
    send(200, { organization_role: "owner", workspace_role: "admin", organization_name: "TestOrg" });
    return;
  }
  if (u.startsWith("/api/oauth/usage")) {
    send(200, {
      subscription_type: "max",
      rate_limits_available: true,
      rate_limits: {
        five_hour: { utilization: 5, resets_at: Math.floor(Date.now() / 1000) + 3600 },
        seven_day: { utilization: 2, resets_at: Math.floor(Date.now() / 1000) + 86400 }
      }
    });
    return;
  }
  send(404, { error: "not found: " + u });
});
const upPort = await new Promise<number>((r) =>
  upstream.listen(0, "127.0.0.1", () => r((upstream.address() as AddressInfo).port))
);
const upBase = "http://127.0.0.1:" + upPort;

/* ================= 网关 ================= */
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cg-relogin-"));
const ADMIN = "relogin-admin-token";
const gw = createGateway({
  PORT: "0", HOST: "127.0.0.1", DATA_DIR: dataDir, SECRET: "relogin-secret",
  ADMIN_TOKEN: ADMIN, LOG_LEVEL: "error",
  UPSTREAM_BASE: upBase,
  OAUTH_TOKEN_URL: upBase + "/v1/oauth/token",
  OAUTH_ROLES_URL: upBase + "/api/oauth/claude_cli/roles",
  OAUTH_PROFILE_URL: upBase + "/api/oauth/profile",
  TOKEN_AUTO_REFRESH: "off",
  IP_CHECK: "off",
  CONTEXT_GUARD: "off",
  IDENTITY_MODE: "off",
  STEGO_MODE: "off",
  CG_ENV_FILE: ""
} as never);
const port = (await gw.listen()) as unknown as AddressInfo;
const p = port.port;

function api(action: string, body: unknown): Promise<{ status: number; data: Record<string, unknown> }> {
  return request(p, "/panel/api?action=" + action + "&key=" + ADMIN, {
    method: "POST", raw: true, body
  }).then((r) => ({
    status: r.status,
    data: ((r.json as { data?: Record<string, unknown> }) || {}).data ?? {}
  }));
}

/* 造一个「已经废掉」的号：令牌过期、refresh_token 被拒、状态 error、还带着耗尽记录 */
const now = Math.floor(Date.now() / 1000);
const dead = gw.accounts.create({
  label: "我自己起的名字",
  kind: "oauth",
  accessToken: "old-dead-at",
  refreshToken: "old-dead-rt",
  expiresAt: now - 7200,
  scope: "user:inference",
  clientId: "test-client",
  email: "quota@example.com"
});
gw.accounts.markError(dead.id, "refresh failed: 刷新令牌失败：HTTP 400 invalid_grant", 30 * 60_000);
gw.accounts.setStatus(dead.id, "error", "refresh token rejected: invalid_grant");
gw.accounts.markExhausted(dead.id, "额度耗尽", now + 3600);
/* 先把指纹造出来 —— deviceId 是惰性生成的，不显式建的话 before/after 都是 null，
   后面那条「指纹不变」的断言就等于没测 */
gw.accounts.ensureDeviceId(dead.id);

const before = gw.accounts.get(dead.id)!;
const deviceBefore = before.deviceId;
ok("指纹已生成（后面的断言才有意义）", typeof deviceBefore === "string" && deviceBefore!.length > 0,
  "got=" + String(deviceBefore));
const countBefore = gw.accounts.list().length;

/* ================= A. start 拿到链接 ================= */
console.log("\n=== A. 授权链接 ===");
const started = await api("oauth.relogin.start", { id: dead.id });
eq("start 200", started.status, 200);
ok("带回 state", typeof started.data.state === "string" && String(started.data.state).length > 0);
ok("带回 authorizeUrl", String(started.data.authorizeUrl ?? "").includes("oauth/authorize"),
  "got=" + String(started.data.authorizeUrl ?? "").slice(0, 80));
eq("带回账号备注名", started.data.label, "我自己起的名字");

/* ================= B. finish 写回同一个号 ================= */
console.log("\n=== B. 换码写回 ===");
tokenCalls = 0;
const done = await api("oauth.relogin.finish", { state: started.data.state, code: "mock-code" });
eq("finish 200", done.status, 200);
eq("换了一次令牌", tokenCalls, 1);
eq("还是同一个 id", done.data.id, dead.id);
eq("没有多出账号", gw.accounts.list().length, countBefore);

const after = gw.accounts.get(dead.id)!;
eq("access_token 换了", after.accessToken, "new-access-token-1");
eq("refresh_token 换了", after.refreshToken, "new-refresh-token-1");
ok("expires_at 推到未来", (after.expiresAt ?? 0) > now + 3000, "got=" + String(after.expiresAt));
eq("邮箱从档案更新", after.email, "quota@example.com");

console.log("\n=== C. 状态被彻底清干净 ===");
eq("状态回到 active", after.status, "active");
eq("error_count 归零", after.errorCount, 0);
eq("lastError 清空", after.lastError, null);
eq("耗尽状态清掉", after.exhaustedUntil, null);
eq("冷却清掉", after.cooldownUntil, null);

console.log("\n=== D. 备注名与指纹不动 ===");
eq("label 保持用户起的名字", after.label, "我自己起的名字");
eq("deviceId 不变", after.deviceId, deviceBefore);
ok("巡检不再认为它需要刷", !gw.credentials.needsRefresh(after, 600));

/* 授权页给的是 code 或 code#state，两种都要认；但 inline state 对不上必须拒 */
console.log("\n=== D2. code#state 两种写法 ===");
{
  const s = await api("oauth.relogin.start", { id: dead.id });
  const withState = await api("oauth.relogin.finish", { state: s.data.state, code: "abc#" + String(s.data.state) });
  eq("code#state（匹配）—— 200", withState.status, 200);

  const s2b = await api("oauth.relogin.start", { id: dead.id });
  const mismatch = await api("oauth.relogin.finish", { state: s2b.data.state, code: "abc#wrong-state" });
  eq("code#state（不匹配）—— 400", mismatch.status, 400);
  eq("不匹配时令牌没被换", gw.accounts.get(dead.id)!.refreshToken, "new-refresh-token-2");
}

/* ================= E. 授权到另一个号 ================= */
console.log("\n=== E. 换了另一个号 ===");
profileEmail = "someone-else@example.com";
const s2 = await api("oauth.relogin.start", { id: dead.id });
const d2 = await api("oauth.relogin.finish", { state: s2.data.state, code: "another-code" });
eq("finish 200", d2.status, 200);
eq("提示 switched", d2.data.switched, true);
eq("带回原邮箱", d2.data.previousEmail, "quota@example.com");
eq("邮箱已更新", gw.accounts.get(dead.id)!.email, "someone-else@example.com");
eq("deviceId 仍然不变", gw.accounts.get(dead.id)!.deviceId, deviceBefore);

/* ================= F. 边界 ================= */
console.log("\n=== F. 边界 ===");
const noId = await api("oauth.relogin.start", {});
eq("缺 id —— 400", noId.status, 400);

const ghost = await api("oauth.relogin.start", { id: "acc_nope" });
eq("号不存在 —— 404", ghost.status, 404);

const keyAcc = gw.accounts.create({ label: "Key 号", kind: "apikey", apiKey: "sk-ant-api03-zzz" });
const onKey = await api("oauth.relogin.start", { id: keyAcc.id });
eq("apikey 号 —— 400", onKey.status, 400);

const badState = await api("oauth.relogin.finish", { state: "no-such-state", code: "x" });
eq("state 过期 —— 400", badState.status, 400);

const noCode = await api("oauth.relogin.finish", { state: "whatever", code: "" });
eq("缺授权码 —— 400", noCode.status, 400);

/* state 只能用一次：同一个 state 再来一遍必须失败 */
const s3 = await api("oauth.relogin.start", { id: dead.id });
const first = await api("oauth.relogin.finish", { state: s3.data.state, code: "c1" });
const second = await api("oauth.relogin.finish", { state: s3.data.state, code: "c2" });
eq("第一次成功", first.status, 200);
eq("同一个 state 第二次失败", second.status, 400);

clearTimeout(watchdog);
upstream.close();
await gw.close();
cleanupDir(dataDir);

console.log("\n" + (fail === 0 ? "全部通过" : "有失败"));
console.log("PASS " + pass + "   FAIL " + fail);
if (fail) {
  console.log("\n失败明细：");
  for (const f of failures) console.log("  - " + f);
}
process.exit(fail ? 1 : 0);
