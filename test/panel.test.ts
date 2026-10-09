#!/usr/bin/env node
/**
 * 面板测试。面板没有前端构建，所以能测的都测在「源码契约」与「渲染产物」上：
 *
 * 1. 渲染出来的 HTML 结构完整（有脚本、有样式、标签闭合）。
 * 2. 内联脚本能被解析 —— 这是唯一能在 Node 侧抓到的语法错误。
 * 3. 前端调用的每个 action，后端都真的处理（跨文件契约，最容易写错的地方）。
 * 4. 每个路由都有渲染函数。
 * 5. 六个痛点的实现特征都在（防止以后重构时悄悄丢掉）。
 * 6. HTTP 层：面板页可达、api 无令牌 401、有令牌 200。
 *
 * 运行：node test/panel.test.ts
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { panelHtml } from "../src/panel/html.ts";
import { createGateway } from "../src/server.ts";
import { cleanupDir } from "./helpers/tmp.ts";
import { request } from "./helpers/client.ts";
import type { AddressInfo } from "node:net";
import type { GatewayContext } from "../src/types.ts";

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
const here = path.dirname(fileURLToPath(import.meta.url));
const src = (rel: string) => fs.readFileSync(path.join(here, "..", "src", "panel", rel), "utf8");

/* ================= 渲染产物 ================= */
console.log("\n=== A. 渲染产物 ===");
const html = panelHtml({ cfg: { adminToken: "test-admin" } } as unknown as GatewayContext);
ok("不是空串", html.length > 20000, "长度=" + html.length);
ok("声明了 doctype", html.startsWith("<!doctype html>"));
eq("script 开闭配对", (html.match(/<script>/g) ?? []).length, (html.match(/<\/script>/g) ?? []).length);
eq("style 开闭配对", (html.match(/<style>/g) ?? []).length, (html.match(/<\/style>/g) ?? []).length);
ok("有 viewport（移动端的前提）", html.includes("width=device-width"));
ok("有消息容器", html.includes('id="messages"'));
ok("六个菜单项", (html.match(/data-route="/g) ?? []).length === 6, String((html.match(/data-route="/g) ?? []).length));
ok("令牌没写死在页面里", !html.includes("test-admin"));

/* ctx 不完整（只给 cfg）时不能崩，退化成静态说明 */
const html2 = panelHtml({ cfg: { adminToken: "" } } as unknown as GatewayContext);
ok("ctx 缺 adminKey 也不崩", html2.includes("登录密钥"));

/* 三种密钥来源各自的说明文字 */
const noteOf = (info: Record<string, unknown>): string =>
  panelHtml({ cfg: { adminToken: "" }, adminKey: { info: () => info } } as unknown as GatewayContext);
ok("派生模式说明", noteOf({ mode: "derived", envOverride: false }).includes("已启用登录密钥"));
ok("重置过说明", noteOf({ mode: "custom", envOverride: false }).includes("重置过"));
ok("ADMIN_TOKEN 接管说明", noteOf({ mode: "env", envOverride: true }).includes("ADMIN_TOKEN 接管"));

/* 令牌的来路与去路：不进 URL、走头、存 localStorage、失效重问 */
const authSrc = src("client.ts");
ok("前端不再从查询串取令牌", !authSrc.includes('QS.get("key")') && !authSrc.includes('"&key="'));
ok("令牌走 x-admin-token 头", authSrc.includes("x-admin-token"));
ok("令牌存 localStorage", authSrc.includes('localStorage.getItem("cg_admin")'));
ok("401 会清空令牌", /clearToken\(\)/.test(authSrc));
ok("清空后重新询问", /clearToken\(\)[\s\S]{0,300}askToken\(/.test(authSrc));
ok("要令牌的弹窗不可关闭", authSrc.includes("noClose:true"));
ok("令牌在写进 localStorage 前先校验", /x-admin-token": v[\s\S]{0,400}setToken\(v\)/.test(authSrc));
ok("对话框支持 noClose", authSrc.includes("var noClose = !!opt.noClose"));
ok("面板路由不再对页面做鉴权", !src("../routes/panel.ts").includes("请用 /panel?key="));
ok("登录成功页不再把令牌拼进链接", !src("../routes/auth.ts").includes("/panel?key="));
ok("根路由不再带 key 跳转", !src("../routes/admin.ts").includes('location: "/panel" + '));

/* 下拉框：原生 <select> 的弹出层由操作系统画，跟面板其它部分两个世界，所以自绘了一个 */
const viewsSrc = src("views.ts");
/* 不用正则字面量 —— node 的类型剥离器对它们挑刺 */
const countOf = (hay: string, needle: string): number => hay.split(needle).length - 1;
ok("自绘下拉组件在 client.ts 里", authSrc.includes("function selectBox("));
ok("自绘下拉已导出", authSrc.includes("window.CG.selectBox = selectBox"));
eq("视图层不再用原生 select", countOf(viewsSrc, 'h("select"'), 0);
ok("表格筛选也用自绘下拉", authSrc.includes("var sel = selectBox("));
ok("弹层样式在组件表里", src("components.ts").includes(".cg-select__drop{"));
/* 组件对象不是 DOM 元素，当 slot 用时必须取 .el，否则 appendChild 会炸 */
ok("slot 筛选取的是 .el",
  viewsSrc.includes('type:"slot", el:protocol.el') &&
  viewsSrc.includes('type:"slot", el:outcome.el') &&
  viewsSrc.includes('type:"slot", el:level.el'));
ok("没有把组件对象直接塞给 slot",
  !viewsSrc.includes('type:"slot", el:protocol}') &&
  !viewsSrc.includes('type:"slot", el:outcome}') &&
  !viewsSrc.includes('type:"slot", el:level}'));
ok("设置页守卫选项用真实枚举 lenient", viewsSrc.includes('value:"lenient"'));
/* 注意别写太宽：运行日志级别筛选里的 warn 是合法的日志级别，不是守卫枚举 */
ok("守卫不再有会被静默忽略的 warn 选项", !viewsSrc.includes('value:"warn", label:"warn（只记日志）"'));
/* Key 重置：换密钥而不是逼人删了重建 */
ok("面板有 key.reset 动作", src("api.ts").includes('case "key.reset"'));
ok("Key 行有重置按钮", viewsSrc.includes("重置密钥"));
ok("store 暴露 resetSecret", src("../store/apikeys.ts").includes("resetSecret"));

/* ================= 内联脚本可解析 ================= */
console.log("\n=== B. 内联脚本 ===");
const scriptMatch = /<script>([\s\S]*?)<\/script>/.exec(html);
const js = scriptMatch ? scriptMatch[1] : "";
ok("取到了脚本", js.length > 5000, "长度=" + js.length);
{
  let err: string | null = null;
  try { new Function(js); } catch (e) { err = e instanceof Error ? e.message : String(e); }
  ok("脚本语法正确", err === null, err ?? "");
}
ok("脚本里没有模板字面量（会和外层冲突）", !js.includes(String.fromCharCode(96)));

/* ================= 前后端 action 契约 ================= */
console.log("\n=== C. action 契约 ===");
const clientSrc = src("client.ts") + src("views.ts");
const apiSrc = src("api.ts");

const called = new Set<string>();
for (const m of clientSrc.matchAll(/CG\.api\(\s*"([^"]+)"/g)) {
  called.add(m[1].split("?")[0]!);
}
const handled = new Set<string>();
for (const m of apiSrc.matchAll(/case\s+"([a-z][a-z0-9.]*)"/g)) handled.add(m[1]!);

ok("前端确实调了接口", called.size >= 10, "数量=" + called.size);
const missing = [...called].filter((a) => !handled.has(a));
eq("前端调用的 action 后端都处理", missing.join(","), "");
ok("密钥接口走全小写 action 名（与既有约定一致）", called.has("admin.keyinfo") && called.has("admin.keyreset"), [...called].filter((a) => a.startsWith("admin.")).join(","));
const orphan = [...handled].filter((a) => !called.has(a));
console.log("    （后端有、前端暂未调用: " + (orphan.join(", ") || "无") + "）");

/* ================= 路由契约 ================= */
console.log("\n=== D. 路由契约 ===");
const routesMatch = /var ROUTES = \[([^\]]+)\]/.exec(src("client.ts"));
const routes = routesMatch ? routesMatch[1]!.split(",").map((s) => s.trim().replace(/"/g, "")) : [];
const mapMatch = /var map = \{([^}]+)\}/.exec(src("views.ts"));
const mapKeys = mapMatch ? [...mapMatch[1]!.matchAll(/([a-z]+)\s*:/g)].map((m) => m[1]!) : [];
eq("路由数量", routes.length, 6);
for (const r of routes) ok("路由 " + r + " 有渲染函数", mapKeys.includes(r));
const titles = src("client.ts").match(/var TITLES = \{([\s\S]*?)\};/);
for (const r of routes) ok("路由 " + r + " 有标题", !!titles && titles[1]!.includes(r + ":"));

/* ================= 六个痛点的实现特征 ================= */
console.log("\n=== E. 六个痛点 ===");
const all = src("client.ts") + src("views.ts") + src("components.ts");
const features: Array<[string, boolean]> = [
  ["表格排序（表头可点）", all.includes("is-sortable")],
  ["表头吸顶", /el-table th\{[^}]*position:sticky/.test(src("components.ts"))],
  ["长文本截断", all.includes("clamp") && all.includes("-webkit-line-clamp")],
  ["列筛选", all.includes("cg-colfilter") && all.includes("filterRows")],
  ["批量操作", all.includes("batchActions") && all.includes("cg-batchbar")],
  ["就地编辑", all.includes("function inlineEdit") && all.includes("cg-inline")],
  ["加载态骨架屏", all.includes("function skeleton") && all.includes("cg-shimmer")],
  ["空状态", all.includes("function emptyState") && all.includes("el-empty")],
  ["消息提示", all.includes("function toast") && all.includes("el-message")],
  ["移动端抽屉", all.includes("cg-side.is-open") && all.includes("cg-scrim")],
  ["自动刷新", all.includes("autoTick") && all.includes("cg_auto")],
  ["分页带页码", all.includes("pager-num")]
];
for (const [name, has] of features) ok(name, has);

/* ================= HTTP 层 ================= */
console.log("\n=== F. HTTP 层 ===");
try {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cg-panel-"));
  const gw = createGateway({
    PORT: "0", HOST: "127.0.0.1", DATA_DIR: dataDir, SECRET: "panel-secret",
    ADMIN_TOKEN: "panel-admin", LOG_LEVEL: "error", UPSTREAM_BASE: "http://127.0.0.1:1"
  });
  const port = await new Promise<number>((r) => gw.server.listen(0, "127.0.0.1", () => r((gw.server.address() as AddressInfo).port)));

  /* 用仓库自带的 http 助手而不是 fetch：undici 的 keep-alive 会让
     Windows 上的 libuv 在进程退出时断言（UV_HANDLE_CLOSING） */
  /* 面板外壳不再要鉴权：它就是一份静态 HTML，一个字节的数据都不含 */
  const noKey = await request(port, "/panel");
  eq("面板页不需要令牌（外壳是静态的）", noKey.status, 200);
  ok("返回的是 HTML", noKey.text.startsWith("<!doctype html>"));
  ok("面板页带上了内联脚本", noKey.text.includes("<script>"));
  ok("页面里没有管理员令牌", !noKey.text.includes("panel-admin"));

  const withQuery = await request(port, "/panel?key=panel-admin");
  eq("带不带 key 都是 200（页面已忽略它）", withQuery.status, 200);

  const noAuth = await request(port, "/panel/api?action=overview");
  eq("无令牌被拒", noAuth.status, 401);

  /* 查询串这条路留着，是给 curl 用的；前端已经不用了 */
  const badAuth = await request(port, "/panel/api?action=overview&key=wrong");
  eq("错令牌被拒（查询串仍兼容 curl）", badAuth.status, 401);

  const badHeader = await request(port, "/panel/api?action=overview", { headers: { "x-admin-token": "wrong" } });
  eq("错令牌走头也被拒", badHeader.status, 401);

  const goodHeader = await request(port, "/panel/api?action=overview", { headers: { "x-admin-token": "panel-admin" } });
  eq("前端走 x-admin-token 头放行", goodHeader.status, 200);

  const good = await request(port, "/panel/api?action=overview&key=panel-admin");
  eq("正确令牌放行", good.status, 200);
  const payload = good.json as { ok?: boolean; data?: { pool?: unknown } };
  ok("返回 ok", payload?.ok === true);
  ok("带 pool 数据", !!payload?.data && !!payload.data.pool);

  /* 前端实际用的那几种带查询串的调用 */
  const logs = await request(port, "/panel/api?action=logs.requests&limit=10&offset=0&key=panel-admin");
  eq("带查询串的 action 可用", logs.status, 200);
  const logsBody = logs.json as { rows?: unknown[]; total?: number };
  ok("返回 rows 与 total", Array.isArray(logsBody?.rows) && typeof logsBody.total === "number");

  /* 写路径：建号、改名、删除，走的是面板真实调用的那三个 action */
  const created = await request(port, "/panel/api?action=account.create&key=panel-admin", {
    body: { kind: "apikey", secret: "sk-ant-panel-test", label: "面板测试号" }
  });
  eq("建号 200", created.status, 200);
  const createdId = ((created.json as { data?: { id?: string } })?.data?.id) ?? "";
  ok("拿到账号 id", createdId.startsWith("acc_"), createdId);

  const renamed = await request(port, "/panel/api?action=account.update&key=panel-admin", {
    body: { id: createdId, label: "改过的名字" }
  });
  eq("就地改名 200", renamed.status, 200);

  const list = await request(port, "/panel/api?action=accounts&key=panel-admin");
  /* 读接口把数组包在 data 里，写接口也是——前端 api() 统一解包 */
  const arr = ((list.json as { data?: Array<{ id: string; label: string }> })?.data) ?? [];
  eq("改名生效", arr.find((x) => x.id === createdId)?.label, "改过的名字");

  const removed = await request(port, "/panel/api?action=account.delete&key=panel-admin", { body: { id: createdId } });
  eq("删除 200", removed.status, 200);

  const unknown = await request(port, "/panel/api?action=no.such&key=panel-admin");
  /* ---- OAuth 授权登录：面板里那条「获取链接 -> 粘贴 code」的路 ---- */
  const start = await request(port, "/panel/api?action=oauth.start&key=panel-admin", { body: {} });
  eq("oauth.start 返回 200", start.status, 200);
  const started = (start.json as { data?: { state?: string; authorizeUrl?: string; redirectUri?: string; mode?: string } }).data;
  ok("给了 state", !!started?.state && started.state.length >= 16, String(started?.state));
  ok("给了授权链接", !!started?.authorizeUrl && started.authorizeUrl.startsWith("https://"), String(started?.authorizeUrl).slice(0, 60));
  /* 面板固定走 manual 回调：内网部署时浏览器与网关不在一台机器上，localhost 够不着 */
  eq("redirect_uri 是官方手动回调", started?.redirectUri, "https://platform.claude.com/oauth/code/callback");
  eq("模式是 manual", started?.mode, "manual");
  const au = new URL(String(started?.authorizeUrl));
  eq("链接里的 redirect_uri 与返回一致", au.searchParams.get("redirect_uri"), "https://platform.claude.com/oauth/code/callback");
  eq("带 PKCE challenge 方法", au.searchParams.get("code_challenge_method"), "S256");
  ok("带 code_challenge", (au.searchParams.get("code_challenge") ?? "").length > 20);
  eq("state 与返回一致", au.searchParams.get("state"), started?.state);
  eq("带 client_id", au.searchParams.get("client_id"), gw.cfg.oauthClientId);
  eq("response_type=code", au.searchParams.get("response_type"), "code");
  /* 订阅模式必须带 user:inference，否则拿不到额度 */
  ok("scope 含 user:inference", (au.searchParams.get("scope") ?? "").includes("user:inference"), au.searchParams.get("scope") ?? "");

  /* finish 的三条早退路径都不需要联网，可以离线验 */
  const noState = await request(port, "/panel/api?action=oauth.finish&key=panel-admin", { body: { state: "deadbeef", code: "x" } });
  eq("未知 state 被拒", noState.status, 400);
  ok("提示要重新获取链接", JSON.stringify(noState.json).includes("授权会话已过期"), JSON.stringify(noState.json).slice(0, 120));

  const s2 = await request(port, "/panel/api?action=oauth.start&key=panel-admin", { body: {} });
  const st2 = (s2.json as { data?: { state?: string } }).data?.state ?? "";
  const emptyCode = await request(port, "/panel/api?action=oauth.finish&key=panel-admin", { body: { state: st2, code: "   " } });
  /* 空白串在 API 层就被挡掉，消息说明缺了什么 */
  eq("空授权码被拒", emptyCode.status, 400);
  ok("提示缺 state 或授权码", JSON.stringify(emptyCode.json).includes("缺少 state 或授权码"), JSON.stringify(emptyCode.json).slice(0, 120));

  const s3 = await request(port, "/panel/api?action=oauth.start&key=panel-admin", { body: {} });
  const st3 = (s3.json as { data?: { state?: string } }).data?.state ?? "";
  const mismatch = await request(port, "/panel/api?action=oauth.finish&key=panel-admin", { body: { state: st3, code: "somecode#totally-different-state" } });
  eq("内联 state 不匹配被拒", mismatch.status, 400);
  ok("提示 state 不匹配", JSON.stringify(mismatch.json).includes("state 不匹配"), JSON.stringify(mismatch.json).slice(0, 120));

  /* 一次性的：上一步已经把这个 state 消费掉了 */
  const reuse = await request(port, "/panel/api?action=oauth.finish&key=panel-admin", { body: { state: st3, code: "somecode" } });
  eq("state 是一次性的，重放被拒", reuse.status, 400);

  /* /login 页面是同一份逻辑的 HTML 版，重构后不能坏 */
  const loginPage = await request(port, "/login", { headers: { host: "10.0.0.5:8899" } });
  eq("/login 在内网 host 下返回页面", loginPage.status, 200);
  ok("/login 页面有 code 输入框", loginPage.text.includes('name="code"'));
  ok("/login 页面有新标签页按钮", loginPage.text.includes('target="_blank"'));
  eq("未知 action 400", unknown.status, 400);

  await gw.close();
  cleanupDir(dataDir);
} catch (e) {
  ok("HTTP 层没抛异常", false, e instanceof Error ? e.message : String(e));
}
clearTimeout(watchdog);
console.log("\n================================");
console.log("  PASS " + pass + "   FAIL " + fail);
if (fail) { console.log("  失败项："); for (const f of failures) console.log("   - " + f); }
console.log("================================\n");
process.exit(fail ? 1 : 0);
