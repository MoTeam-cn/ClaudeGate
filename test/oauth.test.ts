#!/usr/bin/env node
/**
 * OAuth 授权登录 + 加号后自动查额度。
 *
 * 把令牌端点、profile 端点、用量端点全指到本地 mock，跑完整的：
 *   oauth.start -> oauth.finish -> 换令牌 -> 建号 -> 自动查额度 -> 落库
 *
 * 重点验两件事：
 *   1. finish 的响应里带上了额度，面板不用再手点「查用量」
 *   2. 额度落进了账号（后续 accounts 接口能读到），不是只回了前端
 *   3. 窗口 rejected 时账号被封印 —— 这条逻辑与 account.usage 共用，不能只在那条路上生效
 *
 * 运行：node test/oauth.test.ts 或 bun test/oauth.test.ts
 */
import fs from "node:fs";
import http from "node:http";
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

/* ================= mock 上游：令牌 / profile / 用量 ================= */
let usageCalls = 0;
let tokenCalls = 0;
let profileCalls = 0;
/** profile 端点要回的状态码 */
let profileStatus = 200;
/**
 * /api/oauth/profile 的真实形状（从 Claude Code 二进制还原）：
 *   account.display_name / account.full_name，organization.organization_type
 * 注意 organization_type 是 claude_max 这种，客户端要映射成 max
 */
let profilePayload: unknown = {
  account: { display_name: "Quota User", full_name: "Quota Example", email: "quota@example.com" },
  organization: {
    organization_type: "claude_max",
    rate_limit_tier: "default_claude_max_20x",
    plan_display_name: "Max 20x",
    subscription_created_at: "2025-01-01T00:00:00Z"
  }
};
/** 用量端点要回的状态码；设成非 200 就能验失败路径 */
let usageStatus = 200;
/** API Key 兑换端点：null 表示让它失败 */
let apiKeyPayload: unknown = { raw_key: "sk-ant-mock-key" };
/** 让用例能切换用量响应 */
let usagePayload: unknown = {
  subscription_type: "max",
  rate_limits_available: true,
  rate_limits: {
    five_hour: { utilization: 0.42, resets_at: Math.floor(Date.now() / 1000) + 3600 },
    seven_day: { utilization: 0.13, resets_at: Math.floor(Date.now() / 1000) + 86400 }
  },
  limits: [{ status: "allowed", rateLimitType: "five_hour", utilization: 0.42 }]
};

const upstream = http.createServer((req, res) => {
  const u = req.url ?? "";
  const send = (code: number, body: unknown): void => {
    const t = JSON.stringify(body);
    res.writeHead(code, { "content-type": "application/json" });
    res.end(t);
  };
  if (u.startsWith("/v1/oauth/token")) {
    tokenCalls++;
    send(200, {
      access_token: "oauth-access-token",
      refresh_token: "oauth-refresh-token",
      expires_in: 3600,
      scope: "user:inference user:profile org:create_api_key"
    });
    return;
  }
  if (u.startsWith("/api/oauth/profile")) {
    profileCalls++;
    send(profileStatus, profilePayload);
    return;
  }
  if (u.startsWith("/api/oauth/claude_cli/roles")) {
    /* 真实端点只回角色与组织名，没有邮箱 —— 名字要靠 /api/oauth/profile */
    send(200, { organization_role: "owner", workspace_role: "admin", organization_name: "TestOrg" });
    return;
  }
  if (u.startsWith("/api/oauth/usage")) {
    usageCalls++;
    send(usageStatus, usagePayload);
    return;
  }
  if (u.startsWith("/api/oauth/claude_cli/create_api_key")) {
    if (apiKeyPayload === null) { send(500, { error: "boom" }); return; }
    send(200, apiKeyPayload);
    return;
  }
  send(404, { error: "not found: " + u });
});
const upPort = await new Promise<number>((r) => upstream.listen(0, "127.0.0.1", () => r((upstream.address() as AddressInfo).port)));
const base = "http://127.0.0.1:" + upPort;

const dataDirs: string[] = [];
function boot(over: Record<string, string> = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cg-oauth-"));
  dataDirs.push(dataDir);
  return createGateway({
    PORT: "0", HOST: "127.0.0.1", DATA_DIR: dataDir, SECRET: "oauth-secret",
    ADMIN_TOKEN: "oauth-admin", LOG_LEVEL: "error",
    UPSTREAM_BASE: base,
    /* 三个上游端点全部指向 mock，这样整条链路都能离线跑 */
    OAUTH_TOKEN_URL: base + "/v1/oauth/token",
    OAUTH_ROLES_URL: base + "/api/oauth/claude_cli/roles",
    OAUTH_PROFILE_URL: base + "/api/oauth/profile",
    API_KEY_URL: base + "/api/oauth/claude_cli/create_api_key",
    ...over
  } as never);
}

async function startGw(gw: ReturnType<typeof boot>): Promise<number> {
  const addr = await gw.listen();
  return (addr as AddressInfo).port;
}
async function startAndFinish(gw: ReturnType<typeof boot>): Promise<Record<string, unknown>> {
  const port = await startGw(gw);
  const s = await request(port, "/panel/api?action=oauth.start&key=oauth-admin", { body: {} });
  const state = ((s.json as { data?: { state?: string } }).data?.state) ?? "";
  const f = await request(port, "/panel/api?action=oauth.finish&key=oauth-admin", { body: { state, code: "mock-code" } });
  if (f.status !== 200) throw new Error("finish 失败: " + f.status + " " + f.text.slice(0, 200));
  return (f.json as { data?: Record<string, unknown> }).data ?? {};
}

console.log("\n=== A. 加号后自动查额度 ===");
{
  const gw = boot();
  const before = usageCalls;
  const acc = await startAndFinish(gw);

  eq("账号建成了", acc.kind, "oauth");
  eq("名字用了 profile 的 display_name", acc.label, "Quota User");
  eq("邮箱也从 profile 里挖出来了", acc.email, "quota@example.com");
  eq("订阅档位映射成 max", ((acc.profile ?? {}) as { subscriptionType?: string }).subscriptionType, "max");
  eq("套餐展示名带回来了", ((acc.profile ?? {}) as { planDisplayName?: string }).planDisplayName, "Max 20x");
  ok("确实查了 profile 端点", profileCalls > 0, "次数=" + profileCalls);
  ok("自动查了一次用量", usageCalls - before === 1, "次数=" + (usageCalls - before));
  ok("响应里带了额度", !!acc.usage, JSON.stringify(acc.usage).slice(0, 160));
  const u = (acc.usage ?? {}) as { ok?: boolean; subscriptionType?: string; windows?: Record<string, { utilization?: number }> };
  eq("额度查询成功", u.ok, true);
  eq("带上了订阅类型", u.subscriptionType, "max");
  eq("5 小时窗口读数正确", u.windows?.five_hour?.utilization, 0.42);
  eq("7 天窗口读数正确", u.windows?.seven_day?.utilization, 0.13);

  /* 关键：额度必须真的落库，不能只回给前端 */
  const port = (gw.server.address() as AddressInfo).port;
  const list = await request(port, "/panel/api?action=accounts&key=oauth-admin");
  const rows = ((list.json as { data?: Array<Record<string, unknown>> }).data) ?? [];
  eq("号池里有一个号", rows.length, 1);
  const persisted = (rows[0]?.usage ?? {}) as { ok?: boolean; windows?: Record<string, { utilization?: number }> };
  eq("额度已落库", persisted.ok, true);
  eq("落库的 5 小时读数正确", persisted.windows?.five_hour?.utilization, 0.42);
  await gw.close();
}

console.log("\n=== B. 用量端点挂了也不能影响建号 ===");
{
  usageStatus = 500;
  usagePayload = { error: "boom" };
  const gw = boot();
  const acc = await startAndFinish(gw);
  eq("账号照样建成了", acc.kind, "oauth");
  const u = (acc.usage ?? {}) as { ok?: boolean; error?: string | null };
  eq("额度标记为失败", u.ok, false);
  ok("失败原因带回来了", !!u.error, String(u.error));
  ok("原因里带上了状态码", String(u.error ?? "").includes("500"), String(u.error));
  await gw.close();
  usageStatus = 200;
}

console.log("\n=== C. 窗口 rejected 时封印账号 ===");
{
  const resetAt = Math.floor(Date.now() / 1000) + 1800;
  usagePayload = {
    subscription_type: "max",
    rate_limits_available: true,
    rate_limits: { five_hour: { utilization: 1, resets_at: resetAt } },
    limits: [{ status: "rejected", rateLimitType: "five_hour", utilization: 1, resetsAt: resetAt }]
  };
  const gw = boot();
  const port = await startGw(gw);
  const s = await request(port, "/panel/api?action=oauth.start&key=oauth-admin", { body: {} });
  const state = ((s.json as { data?: { state?: string } }).data?.state) ?? "";
  const f = await request(port, "/panel/api?action=oauth.finish&key=oauth-admin", { body: { state, code: "mock-code" } });
  eq("finish 成功", f.status, 200);

  const list = await request(port, "/panel/api?action=accounts&key=oauth-admin");
  const rows = ((list.json as { data?: Array<Record<string, unknown>> }).data) ?? [];
  eq("账号状态被改成 exhausted", rows[0]?.status, "exhausted");
  ok("封印到窗口重置时刻", Number(rows[0]?.exhaustedUntil) === resetAt, String(rows[0]?.exhaustedUntil) + " vs " + resetAt);
  ok("记下了封印原因", String(rows[0]?.exhaustedReason ?? "").includes("rejected"), String(rows[0]?.exhaustedReason));
  await gw.close();
}

console.log("\n=== D. Console 模式不查订阅额度 ===");
{
  const gw = boot({ OAUTH_MODE: "console" });
  const before = usageCalls;
  const acc = await startAndFinish(gw);
  /* console 模式会把令牌换成 API Key，号变成 apikey 类型，用量接口对它没意义 */
  eq("号变成了 apikey 类型", acc.kind, "apikey");
  eq("没去查订阅额度（apikey 没这个接口）", usageCalls - before, 0);
  eq("响应里 usage 为 null", acc.usage, null);
  await gw.close();
}

console.log("\n=== E. console 模式兑换 API Key 失败要报错，不能静默降级 ===");
{
  apiKeyPayload = null;
  const gw = boot({ OAUTH_MODE: "console" });
  const port = await startGw(gw);
  const s = await request(port, "/panel/api?action=oauth.start&key=oauth-admin", { body: {} });
  const state = ((s.json as { data?: { state?: string } }).data?.state) ?? "";
  const f = await request(port, "/panel/api?action=oauth.finish&key=oauth-admin", { body: { state, code: "mock-code" } });
  eq("finish 失败", f.status, 400);
  ok("说明是兑换 API Key 失败", JSON.stringify(f.json).includes("兑换成 API Key"), JSON.stringify(f.json).slice(0, 160));

  const list = await request(port, "/panel/api?action=accounts&key=oauth-admin");
  const rows = ((list.json as { data?: Array<Record<string, unknown>> }).data) ?? [];
  eq("没有留下半个账号", rows.length, 0);
  await gw.close();
  apiKeyPayload = { raw_key: "sk-ant-mock-key" };
}

console.log("\n=== F. profile 拿不到时不能挡住建号 ===");
{
  profileStatus = 500;
  const gw = boot();
  const acc = await startAndFinish(gw);
  eq("账号照样建成了", acc.kind, "oauth");
  ok("名字退回占位", String(acc.label).length > 0, String(acc.label));
  eq("没有邮箱", acc.email, null);
  await gw.close();
  profileStatus = 200;
}

console.log("\n=== G. limits[] 新形状（utilization 是 0-100）===");
{
  usagePayload = {
    subscription_type: "pro",
    rate_limits_available: true,
    limits: [
      { kind: "session", group: "session", utilization: 42, severity: "normal",
        resetsAt: new Date(Date.now() + 3600e3).toISOString() },
      { kind: "weekly_scoped", group: "weekly", utilization: 7.5, severity: "warning",
        scope: { label: "Opus" }, resetsAt: new Date(Date.now() + 86400e3).toISOString() }
    ]
  };
  const gw = boot();
  const acc = await startAndFinish(gw);
  const u = (acc.usage ?? {}) as { ok?: boolean; subscriptionType?: string; windows?: Record<string, { utilization?: number; status?: string; scopeLabel?: string; resetsAt?: number }> };
  eq("查询成功", u.ok, true);
  eq("订阅类型读到了", u.subscriptionType, "pro");
  eq("session 读数换算成小数", u.windows?.session?.utilization, 0.42);
  eq("session 状态带过来了", u.windows?.session?.status, "normal");
  eq("weekly_scoped 也换算成小数", u.windows?.weekly_scoped?.utilization, 0.075);
  eq("带 scope 的行保留了标签", u.windows?.weekly_scoped?.scopeLabel, "Opus");
  ok("ISO 时间解析成了 unix 秒", typeof u.windows?.session?.resetsAt === "number" && (u.windows?.session?.resetsAt ?? 0) > 1e9,
    String(u.windows?.session?.resetsAt));
  await gw.close();
}

console.log("\n=== H. 用量响应没有任何可识别字段要报错，不能假装成功 ===");
{
  usagePayload = { something_else: true };
  const gw = boot();
  const acc = await startAndFinish(gw);
  const u = (acc.usage ?? {}) as { ok?: boolean; error?: string | null; windows?: Record<string, unknown> };
  eq("标记为失败", u.ok, false);
  ok("说明是没解析到字段", String(u.error).includes("没有任何可识别字段"), String(u.error).slice(0, 140));
  ok("把原始响应带上了", String(u.error).includes("something_else"), String(u.error).slice(0, 160));
  eq("窗口是空的", Object.keys(u.windows ?? {}).length, 0);
  await gw.close();
  usagePayload = {
    subscription_type: "max",
    rate_limits_available: true,
    rate_limits: {
      five_hour: { utilization: 0.42, resets_at: Math.floor(Date.now() / 1000) + 3600 },
      seven_day: { utilization: 0.13, resets_at: Math.floor(Date.now() / 1000) + 86400 }
    },
    limits: [{ status: "allowed", rateLimitType: "five_hour", utilization: 0.42 }]
  };
}

/* ================= I. 刷新账号信息 ================= */
console.log("\n=== I. 刷新账号信息 ===");
{
  const gw = boot();
  const acc = await startAndFinish(gw);
  const port = (gw.server.address() as AddressInfo).port;
  const id = String(acc.id ?? "");
  ok("拿到账号 id", !!id, id);

  /* 模拟老库里的样子：备注名是建号时瞎填的默认值。
     这种值不一定匹配 isPlaceholderLabel 的启发式，所以得靠手动刷新补真名 */
  gw.accounts.update(id, { label: "账号 7", email: null } as never);

  const before = profileCalls;
  const res = await request(port, "/panel/api?action=account.refresh&key=oauth-admin", { body: { id } });
  eq("刷新接口 200", res.status, 200);
  const data = (res.json as { data?: { refreshed?: number; results?: Array<Record<string, unknown>> } }).data ?? {};
  eq("刷了一个", data.refreshed, 1);
  const one = (data.results ?? [])[0] ?? {};
  eq("刷新前是默认名", one.before, "账号 7");
  eq("刷新后换成真名", one.label, "Quota User");
  eq("邮箱也带回来了", one.email, "quota@example.com");
  ok("确实打了档案接口", profileCalls > before, "次数 " + before + " -> " + profileCalls);
  eq("没有档案错误", one.profileError, null);
  eq("额度也查了", one.usageOk, true);

  /* 关键：得落库，不能只回给前端 */
  const list = await request(port, "/panel/api?action=accounts&key=oauth-admin");
  const rows = ((list.json as { data?: Array<Record<string, unknown>> }).data) ?? [];
  eq("库里也是真名", rows[0]?.label, "Quota User");
  eq("库里也有邮箱", rows[0]?.email, "quota@example.com");

  /* 不带 id = 刷全部 */
  const allRes = await request(port, "/panel/api?action=account.refresh&key=oauth-admin", { body: {} });
  eq("全部刷新 200", allRes.status, 200);
  eq("刷了全部 1 个", ((allRes.json as { data?: { refreshed?: number } }).data ?? {}).refreshed, 1);

  const miss = await request(port, "/panel/api?action=account.refresh&key=oauth-admin", { body: { id: "acc_nope" } });
  eq("不存在的 id 404", miss.status, 404);
  await gw.close();
}

/* 档案接口挂了也要说清楚，不能装作刷成功 */
console.log("\n=== J. 档案拉不到时的刷新 ===");
{
  const gw = boot();
  const acc = await startAndFinish(gw);
  const port = (gw.server.address() as AddressInfo).port;
  const id = String(acc.id ?? "");
  gw.accounts.update(id, { label: "账号 9" } as never);
  profileStatus = 500;
  const res = await request(port, "/panel/api?action=account.refresh&key=oauth-admin", { body: { id } });
  eq("接口本身还是 200", res.status, 200);
  const one = (((res.json as { data?: { results?: Array<Record<string, unknown>> } }).data ?? {}).results ?? [])[0] ?? {};
  ok("如实报告档案没拿到", typeof one.profileError === "string" && String(one.profileError).length > 0, String(one.profileError));
  eq("名字保持原样", one.label, "账号 9");
  profileStatus = 200;
  await gw.close();
}
clearTimeout(watchdog);
upstream.close();
for (const d of dataDirs) cleanupDir(d);

console.log("\n================================");
console.log("  PASS " + pass + "   FAIL " + fail);
if (fail) { console.log("  失败项："); for (const f of failures) console.log("   - " + f); }
console.log("================================\n");
process.exit(fail ? 1 : 0);
