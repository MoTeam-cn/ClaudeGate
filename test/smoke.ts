#!/usr/bin/env node
/**
 * claude-gateway 冒烟测试
 *   守卫 / Anthropic 透传 / OpenAI 互转 / 流式 / 令牌 / OAuth 刷新 / 纯函数
 *   运行：npm test  或  node test/smoke.ts
 */

import os from "node:os";
import { cleanupDir } from "./helpers/tmp.ts";
import path from "node:path";
import fs from "node:fs";

import { createGateway } from "../src/server.ts";
import { openaiToAnthropic } from "../src/translate/openai-in.ts";
import { anthropicToOpenai } from "../src/translate/openai-out.ts";
import { resolveModel } from "../src/models.ts";
import { checkClaudeCodeHeaders } from "../src/guard.ts";
import { createMockUpstream } from "./helpers/mock-upstream.ts";
import { request, requestForm, getText, asRecord } from "./helpers/client.ts";

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

const watchdog = setTimeout(() => {
  console.log("\n!! 测试超时（25s），已中断");
  process.exit(3);
}, 25000);

const cleanup: Array<() => Promise<void>> = [];
const dataDirs: string[] = [];

function newDir(tag: string): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "cg-" + tag + "-"));
  dataDirs.push(d);
  return d;
}

async function main(): Promise<void> {
  const upstream = createMockUpstream();
  const upPort = await upstream.listen();
  cleanup.push(() => upstream.close());

  const gw = createGateway({
    PORT: "0",
    HOST: "127.0.0.1",
    DATA_DIR: newDir("main"),
    SECRET: "test-secret",
    /* 面板鉴权现在是常开的；测试显式给一个，别依赖自动派发的密钥 */
    ADMIN_TOKEN: "smoke-admin",
    UPSTREAM_BASE: "http://127.0.0.1:" + upPort,
    GUARD_MODE: "strict",
    INJECT_MISSING: "false",
    PUBLIC_URL: "http://gw.test",
    LOG_LEVEL: "error"
  });
  const addr = await gw.listen(0, "127.0.0.1");
  const port = addr.port;
  cleanup.push(() => gw.close());

  gw.accounts.create({
    label: "test-main",
    kind: "oauth",
    accessToken: "upstream-access-token",
    refreshToken: "upstream-refresh-token",
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
    scope: "user:inference user:profile",
    clientId: "test-client",
    mode: "claude_ai"
  });

  const TOKEN = (await getText(port, "/token?key=smoke-admin")).text.trim();

  const CC: Record<string, string> = {
    "content-type": "application/json",
    "user-agent": "claude-cli/2.1.293 (external, cli)",
    "x-app": "cli",
    "anthropic-version": "2023-06-01",
    "x-claude-code-session-id": "0f8fad5b-d9cb-469f-a165-70867728950e",
    "x-stainless-lang": "js"
  };
  const ccHeaders = (extra?: Record<string, string>): Record<string, string> => ({
    authorization: "Bearer " + TOKEN,
    ...CC,
    ...(extra ?? {})
  });
  const MSG = { model: "claude-sonnet-4-5-20250929", max_tokens: 64, messages: [{ role: "user", content: "hi" }] };

  console.log("\n=== 1. 健康检查与令牌 ===");
  const h = await request(port, "/healthz");
  const hj = asRecord(h.json);
  eq("healthz 200", h.status, 200);
  eq("healthz 账号数", hj.accounts, 1);
  eq("healthz 可用账号数", hj.activeAccounts, 1);
  eq("healthz guardMode", hj.guardMode, "strict");
  ok("网关令牌已签发", /^gw1\./.test(TOKEN), TOKEN);

  const noAuth = await request(port, "/v1/messages", { headers: CC, body: MSG });
  eq("无令牌 401", noAuth.status, 401);
  eq("无令牌错误类型", asRecord(asRecord(noAuth.json).error).type, "authentication_error");

  const badToken = await request(port, "/v1/messages", { headers: { authorization: "Bearer nope", ...CC }, body: MSG });
  eq("错令牌 401", badToken.status, 401);

  console.log("\n=== 2. Claude Code 请求头守卫 ===");
  const bare = await request(port, "/v1/messages", {
    headers: { authorization: "Bearer " + TOKEN, "content-type": "application/json" },
    body: MSG
  });
  eq("缺 CC 头 403", bare.status, 403);
  ok("403 指明缺失头", bare.text.includes("user-agent") && bare.text.includes("x-app"), bare.text.slice(0, 160));
  eq("403 为 anthropic 错误形态", asRecord(bare.json).type, "error");

  const badUa = await request(port, "/v1/messages", { headers: ccHeaders({ "user-agent": "curl/8.0" }), body: MSG });
  eq("UA 非 claude 403", badUa.status, 403);

  const badApp = await request(port, "/v1/messages", { headers: ccHeaders({ "x-app": "web" }), body: MSG });
  eq("x-app 非 cli 403", badApp.status, 403);

  const oaiBare = await request(port, "/v1/chat/completions", {
    headers: { authorization: "Bearer " + TOKEN },
    body: { model: "gpt-4o", messages: [{ role: "user", content: "hi" }] }
  });
  eq("OpenAI 缺头 403", oaiBare.status, 403);
  eq("OpenAI 403 形态", asRecord(asRecord(oaiBare.json).error).type, "permission_error");

  console.log("\n=== 3. Anthropic 原生透传 ===");
  const ant = await request(port, "/v1/messages", { headers: ccHeaders(), body: MSG });
  const antContent = asRecord(ant.json).content as Array<Record<string, unknown>>;
  eq("透传 200", ant.status, 200);
  eq("透传内容", antContent[0].text, "Hello from mock");
  eq("上游收到 UA", upstream.last?.headers["user-agent"], "claude-cli/2.1.293 (external, cli)");
  eq("上游收到 x-app", upstream.last?.headers["x-app"], "cli");
  eq("上游收到 session-id", upstream.last?.headers["x-claude-code-session-id"], "0f8fad5b-d9cb-469f-a165-70867728950e");
  eq("上游收到 anthropic-version", upstream.last?.headers["anthropic-version"], "2023-06-01");
  eq("上游带上 oauth beta", upstream.last?.headers["anthropic-beta"], "oauth-2025-04-20");
  eq("上游 Authorization 已替换", upstream.last?.headers["authorization"], "Bearer upstream-access-token");
  ok("上游无 x-api-key", upstream.last?.headers["x-api-key"] === undefined);
  ok("网关令牌未外泄", !String(upstream.last?.headers["authorization"]).includes(TOKEN));
  eq("上游收到 stainless 头", upstream.last?.headers["x-stainless-lang"], "js");

  console.log("\n=== 4. OpenAI 非流式互转 ===");
  const oai = await request(port, "/v1/chat/completions", {
    headers: ccHeaders(),
    body: {
      model: "gpt-4o",
      messages: [
        { role: "system", content: "be brief" },
        { role: "user", content: [{ type: "text", text: "weather in SF?" }] }
      ],
      tools: [{
        type: "function",
        function: { name: "get_weather", description: "w", parameters: { type: "object", properties: { city: { type: "string" } } } }
      }]
    }
  });
  const oaiJson = asRecord(oai.json);
  const choice0 = asRecord((oaiJson.choices as unknown[])[0]);
  const choiceMsg = asRecord(choice0.message);
  const upstreamBody = JSON.parse(upstream.last?.body ?? "{}") as Record<string, unknown>;
  eq("OpenAI 200", oai.status, 200);
  eq("OpenAI object", oaiJson.object, "chat.completion");
  eq("gpt-4o 映射", oaiJson.model, "claude-sonnet-4-5-20250929");
  eq("上游 model 已映射", upstreamBody.model, "claude-sonnet-4-5-20250929");
  eq("system 已提取", upstreamBody.system, "be brief");
  eq("tools 已转换", (upstreamBody.tools as Array<Record<string, unknown>>)[0].name, "get_weather");
  eq("finish_reason 映射", choice0.finish_reason, "tool_calls");
  eq(
    "tool_calls arguments",
    asRecord(asRecord((choiceMsg.tool_calls as unknown[])[0]).function).arguments,
    "{\"city\":\"SF\"}"
  );
  eq(
    "tool_calls 名称",
    asRecord(asRecord((choiceMsg.tool_calls as unknown[])[0]).function).name,
    "get_weather"
  );
  eq("usage 转换", asRecord(oaiJson.usage).total_tokens, 18);

  console.log("\n=== 5. OpenAI 流式互转 ===");
  const sse = await request(port, "/v1/chat/completions", {
    headers: ccHeaders(),
    body: { model: "sonnet", stream: true, messages: [{ role: "user", content: "hi" }] }
  });
  eq("流式 200", sse.status, 200);
  ok("流式 content-type", String(sse.headers["content-type"]).startsWith("text/event-stream"), String(sse.headers["content-type"]));
  ok("含 role 首块", sse.text.includes("\"role\":\"assistant\""));
  ok("含文本增量", sse.text.includes("Hello") && sse.text.includes(" world"));
  ok("含 finish_reason=stop", sse.text.includes("\"finish_reason\":\"stop\""));
  ok("含 [DONE]", sse.text.includes("[DONE]"));
  ok("对象名为 chunk", sse.text.includes("chat.completion.chunk"));
  eq("DONE 只出现一次", (sse.text.match(/\[DONE\]/g) ?? []).length, 1);
  ok("流式行格式正确", sse.text.split("\n").filter((l) => l.startsWith("data: ")).length > 4);

  console.log("\n=== 6. count_tokens / models / 404 ===");
  const ct = await request(port, "/v1/messages/count_tokens", {
    headers: ccHeaders(),
    body: { model: "claude-sonnet-4-5-20250929", messages: [{ role: "user", content: "hi" }] }
  });
  eq("count_tokens 200", ct.status, 200);
  eq("count_tokens 值", asRecord(ct.json).input_tokens, 42);

  const models = await request(port, "/v1/models", { headers: ccHeaders() });
  eq("models 200", models.status, 200);
  eq("models object", asRecord(models.json).object, "list");
  ok("models 含 opus", models.text.includes("claude-opus-4-5-20251101"));

  const nf = await request(port, "/v1/nope", { headers: ccHeaders(), body: {} });
  eq("未知 v1 端点 404", nf.status, 404);
  eq("404 为 anthropic 形态", asRecord(nf.json).type, "error");

  const nf2 = await request(port, "/v1/chat/nope", { headers: ccHeaders(), body: {} });
  eq("未知 openai 端点 404", nf2.status, 404);
  eq("404 为 openai 形态", asRecord(asRecord(nf2.json).error).type, "invalid_request_error");

  console.log("\n=== 7. 网关 OAuth 刷新端点 ===");
  const refresh = await requestForm(port, "/oauth/token", "grant_type=refresh_token&refresh_token=" + TOKEN);
  eq("oauth/token 200", refresh.status, 200);
  ok("返回 access_token", /^gw1\./.test(String(asRecord(refresh.json).access_token)));
  eq("token_type", asRecord(refresh.json).token_type, "Bearer");
  ok("含 expires_in", typeof asRecord(refresh.json).expires_in === "number");
  const badGrant = await requestForm(port, "/oauth/token", "grant_type=authorization_code");
  eq("不支持的 grant 400", badGrant.status, 400);

  console.log("\n=== 8. 纯函数 ===");
  eq("resolveModel sonnet", resolveModel("sonnet", { defaultModel: "d" } as never), "claude-sonnet-4-5-20250929");
  eq("resolveModel 透传", resolveModel("claude-opus-4-5-20251101", { defaultModel: "d" } as never), "claude-opus-4-5-20251101");
  eq("resolveModel 未知回落", resolveModel("zzz", { defaultModel: "d" } as never), "d");

  const g1 = checkClaudeCodeHeaders(
    {
      "user-agent": "claude-cli/2.1.293 (external, cli)",
      "x-app": "cli",
      "anthropic-version": "2023-06-01",
      "x-claude-code-session-id": "u"
    },
    { guardRequire: ["user-agent", "x-app", "anthropic-version", "x-claude-code-session-id"] }
  );
  eq("合法头通过", g1.ok, true);

  const g2 = checkClaudeCodeHeaders(
    { "user-agent": "python-requests/2", "x-app": "cli" },
    { guardRequire: ["user-agent", "x-app", "anthropic-version"] }
  );
  eq("非法头拦截", g2.ok, false);
  eq("缺失项数量", g2.missing.length, 2);

  const conv = openaiToAnthropic(
    { model: "gpt-4o-mini", messages: [{ role: "user", content: "x" }] },
    { defaultModel: "d", maxTokensDefault: 4096 } as never
  );
  eq("max_tokens 默认", conv.max_tokens, 4096);
  eq("gpt-4o-mini 映射", conv.model, "claude-haiku-4-5-20251001");

  const toolMsg = openaiToAnthropic(
    {
      model: "sonnet",
      messages: [
        { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "f", arguments: "{\"a\":1}" } }] },
        { role: "tool", tool_call_id: "call_1", content: "result" }
      ]
    },
    { defaultModel: "d", maxTokensDefault: 100 } as never
  );
  const m0 = toolMsg.messages[0].content as Array<Record<string, unknown>>;
  const m1 = toolMsg.messages[1].content as Array<Record<string, unknown>>;
  eq("tool_calls -> tool_use", m0[0].type, "tool_use");
  eq("tool_use input 解析", asRecord(m0[0].input).a, 1);
  eq("tool -> tool_result", m1[0].type, "tool_result");

  const img = openaiToAnthropic(
    { model: "sonnet", messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }] }] },
    { defaultModel: "d", maxTokensDefault: 10 } as never
  );
  const imgBlock = (img.messages[0].content as Array<Record<string, unknown>>)[0];
  eq("data url -> base64", asRecord(imgBlock.source).type, "base64");
  eq("media_type 正确", asRecord(imgBlock.source).media_type, "image/png");

  const back = anthropicToOpenai(
    { id: "msg_1", content: [{ type: "text", text: "hi" }], stop_reason: "end_turn", usage: { input_tokens: 3, output_tokens: 4 } },
    "claude-x"
  );
  eq("响应 finish 映射", back.choices[0].finish_reason, "stop");
  eq("响应 usage", back.usage.total_tokens, 7);
  eq("响应 model 透传", back.model, "claude-x");

  console.log("\n=== 9. lenient + 注入（指纹稳定化） ===");
  const gw2 = createGateway({
    PORT: "0",
    HOST: "127.0.0.1",
    DATA_DIR: newDir("lenient"),
    SECRET: "secret-2",
    ADMIN_TOKEN: "smoke-admin",
    UPSTREAM_BASE: "http://127.0.0.1:" + upPort,
    GUARD_MODE: "lenient",
    INJECT_MISSING: "true",
    LOG_LEVEL: "error"
  });
  const addr2 = await gw2.listen(0, "127.0.0.1");
  cleanup.push(() => gw2.close());
  gw2.accounts.create({
    label: "test-lenient",
    kind: "oauth",
    accessToken: "t2",
    refreshToken: "r2",
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
    scope: "user:inference"
  });

  const t2 = (await getText(addr2.port, "/token?key=smoke-admin")).text.trim();
  const inj = await request(addr2.port, "/v1/messages", {
    headers: { authorization: "Bearer " + t2 },
    body: { model: "sonnet", max_tokens: 8, messages: [{ role: "user", content: "hi" }] }
  });
  eq("lenient 无头放行", inj.status, 200);
  eq("注入 UA", upstream.last?.headers["user-agent"], "claude-cli/2.1.293 (external, cli)");
  eq("注入 x-app", upstream.last?.headers["x-app"], "cli");
  eq("注入 anthropic-version", upstream.last?.headers["anthropic-version"], "2023-06-01");
  const sid1 = String(upstream.last?.headers["x-claude-code-session-id"]);
  ok("注入稳定 session-id", /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(sid1), sid1);

  await request(addr2.port, "/v1/messages", {
    headers: { authorization: "Bearer " + t2 },
    body: { model: "sonnet", max_tokens: 8, messages: [{ role: "user", content: "again" }] }
  });
  eq("session-id 跨请求稳定", String(upstream.last?.headers["x-claude-code-session-id"]), sid1);

  console.log("\n=== 10. ADMIN_TOKEN 保护 ===");
  const gw3 = createGateway({
    PORT: "0",
    HOST: "127.0.0.1",
    DATA_DIR: newDir("admin"),
    SECRET: "secret-3",
    UPSTREAM_BASE: "http://127.0.0.1:" + upPort,
    ADMIN_TOKEN: "letmein",
    LOG_LEVEL: "error"
  });
  const addr3 = await gw3.listen(0, "127.0.0.1");
  cleanup.push(() => gw3.close());
  const denied = await getText(addr3.port, "/token");
  eq("无 key 401", denied.status, 401);
  const allowed = await getText(addr3.port, "/token?key=letmein");
  eq("带 key 200", allowed.status, 200);
  ok("返回令牌", /^gw1\./.test(allowed.text.trim()));
}

try {
  await main();
} catch (e) {
  fail++;
  const msg = e instanceof Error && e.stack ? e.stack : String(e);
  failures.push("未捕获异常: " + msg);
  console.log("\n!! 异常: " + msg);
}

for (const fn of cleanup) {
  try {
    await fn();
  } catch {
    /* 清理失败不影响结论 */
  }
}
for (const d of dataDirs) {
  try {
    cleanupDir(d);
  } catch {
    /* 忽略 */
  }
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
