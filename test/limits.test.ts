#!/usr/bin/env node
/**
 * 模型上下文限制测试。
 *
 * 覆盖四件事：
 *   1. MODEL_LIMITS 的语法解析（含各种尺寸写法与坏条目）
 *   2. 输入 token 估算
 *   3. 超限判定的边界（窗口本身放行、超出容差才拦）
 *   4. /v1/models 带窗口，且两个消息接口真的会拦
 *
 * 运行：node test/limits.test.ts
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import { createGateway } from "../src/server.ts";
import {
  parseModelLimits, parseSize, estimateInputTokens, checkContext, limitFor, normalizeLimitKey, IMAGE_TOKENS
} from "../src/model-limits.ts";
import { signGatewayToken } from "../src/tokens.ts";
import { cleanupDir } from "./helpers/tmp.ts";
import { request } from "./helpers/client.ts";
import type { AddressInfo } from "node:net";
import type { Config } from "../src/types.ts";

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

/* ================= A. 尺寸与语法 ================= */
console.log("\n=== A. 尺寸与语法 ===");
eq("裸数字按 token", parseSize("256000"), 256000);
eq("k 后缀", parseSize("256k"), 256000);
eq("m 后缀", parseSize("1m"), 1000000);
eq("100-1000 的裸数字当 k", parseSize("256"), 256000);
eq("1000 也当 k", parseSize("1000"), 1000000);
eq("小于 100 的裸数字按 token", parseSize("50"), 50);
eq("坏值返回 null", parseSize("abc"), null);

eq("归一化去 [1m]", normalizeLimitKey("claude-opus-5-5[1m]"), "claude-opus-5-5");
eq("归一化去日期后缀", normalizeLimitKey("claude-opus-5-5-20260101"), "claude-opus-5-5");
eq("归一化小写", normalizeLimitKey("Claude-Opus-5-5"), "claude-opus-5-5");

const m1 = parseModelLimits("*=256000,claude-opus-5-5=1000000/128000");
eq("兜底项", m1["*"]?.context, 256000);
eq("兜底项无输出限制", m1["*"]?.maxOutput, null);
eq("指定模型窗口", m1["claude-opus-5-5"]?.context, 1000000);
eq("指定模型输出", m1["claude-opus-5-5"]?.maxOutput, 128000);
eq("坏条目被跳过而不是整体失败", Object.keys(parseModelLimits("garbage,=1,ok=1000")).length, 1);
eq("空串得到空表", Object.keys(parseModelLimits("")).length, 0);
eq("带空格也认", parseModelLimits(" a = 256k ").a?.context, 256000);
eq("[1m] 后缀的模型名归一到同一个键", parseModelLimits("claude-opus-5-5[1m]=1000000")["claude-opus-5-5"]?.context, 1000000);

/* ================= B. token 估算 ================= */
console.log("\n=== B. token 估算 ===");
eq("纯 ASCII 四字符一 token", estimateInputTokens("a".repeat(400)), 100);
eq("中文约 1.5 字符一 token", estimateInputTokens("中".repeat(150)), 100);
eq("空串是 0", estimateInputTokens(""), 0);
ok("混合文本落在两者之间",
  estimateInputTokens("中".repeat(150) + "a".repeat(400)) > 100 &&
  estimateInputTokens("中".repeat(150) + "a".repeat(400)) < 250);

/* ================= C. 判定边界 ================= */
console.log("\n=== C. 判定边界 ===");
const cfg = { modelLimits: parseModelLimits("test=100000"), contextHeadroom: 0.1 } as unknown as Config;
eq("没配的模型不限制", limitFor(cfg, "whatever")?.context, undefined);
eq("配了的模型取到窗口", limitFor(cfg, "test")?.context, 100000);

const cfgImg = cfg;

/* 100000 × 1.1 = 110000 是上限 */
const atLimit = "a".repeat(100000 * 4);
eq("正好等于窗口放行", checkContext(cfg, "test", atLimit).ok, true);
const over = "a".repeat(120000 * 4);
eq("超出 20% 被拦", checkContext(cfg, "test", over).ok, false);
eq("拦下来时给的是 400 用的原因", checkContext(cfg, "test", over).reason.includes("上下文窗口"), true);
eq("上限算成窗口的 110%", checkContext(cfg, "test", over).ceiling, 110000);
eq("没配的模型无论多大都放行", checkContext(cfg, "other", "a".repeat(10000000)).ok, true);
const noLimit = { modelLimits: {}, contextHeadroom: 0.1 } as unknown as Config;
eq("完全没配时不限制", checkContext(noLimit, "test", "a".repeat(10000000)).ok, true);

/* 压缩请求必须放行 —— 拦它等于把用户锁死 */
const COMPACT_BODY = JSON.stringify({
  model: "test", max_tokens: 32000,
  system: "Your task is to create a detailed summary of the conversation so far, paying close attention to the user's explicit requests and your previous actions.",
  messages: [{ role: "user", content: "a".repeat(120000 * 4) }]
});
eq("压缩请求被识别", checkContext(cfg, "test", COMPACT_BODY).compaction, true);
eq("压缩请求即便远超窗口也放行", checkContext(cfg, "test", COMPACT_BODY).ok, true);
eq("普通大请求不会被误判成压缩", checkContext(cfg, "test", over).compaction, false);
eq("普通大请求仍然被拦", checkContext(cfg, "test", over).ok, false);

/* ================= C2. 图片不能按文本算 ================= */
console.log("\n=== C2. 图片计价（线上误报的回归）===");
/* 线上那次：Read 了一张 1.5MB 的 PNG，base64 约 140 万字符，
   网关按「4 字符一 token」估出 35 万 token，把 43% 的正常请求打成了超限。 */
const bigB64 = "A".repeat(1400000);
const imgBody = {
  model: "test",
  messages: [{ role: "user", content: [
    { type: "image", source: { type: "base64", media_type: "image/png", data: bigB64 } },
    { type: "text", text: "看看这张图" }
  ] }]
};
const imgEst = estimateInputTokens(imgBody);
ok("1.4M 字符的图不再算成 35 万 token", imgEst < 5000, "estimated=" + imgEst);
ok("图片按固定成本计", imgEst >= IMAGE_TOKENS, "estimated=" + imgEst);
eq("带大图的请求不再被误判超限", checkContext(cfgImg, "test", imgBody).ok, true);
ok("OpenAI 形状的 image_url 也按图片算",
  estimateInputTokens({ type: "image_url", image_url: { url: "data:image/png;base64," + bigB64 } }) < 5000);
ok("普通 base64 字段仍按文本算（不是所有 data 都是图片）",
  estimateInputTokens({ type: "text", data: bigB64 }) > 100000);
ok("文本块照旧按字符估", estimateInputTokens({ type: "text", text: "a".repeat(400) }) >= 100);
eq("字符串入参仍按文本处理（老调用方式不破）",
  estimateInputTokens("a".repeat(400)), 100);

/* ================= D. 接口 ================= */
console.log("\n=== D. /v1/models 与拦截 ===");
let upHits = 0;
const upstream = http.createServer((req, res) => {
  upHits += 1;
  req.resume();
  req.on("end", () => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ id: "m", type: "message", role: "assistant", model: "x",
      content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 } }));
  });
});
const upPort = await new Promise<number>((r) => upstream.listen(0, "127.0.0.1", () => r((upstream.address() as AddressInfo).port)));

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cg-lim-"));
const gw = createGateway({
  PORT: "0", HOST: "127.0.0.1", DATA_DIR: dataDir, SECRET: "lim-secret", CG_ENV_FILE: "",
  UPSTREAM_BASE: "http://127.0.0.1:" + upPort,
  MODEL_VALIDATION: "off", GUARD_MODE: "off", STEGO_MODE: "off",
  LOG_LEVEL: "error", TRANSPORT: "https",
  MODEL_LIMITS: "*=100000/32000"
});
gw.accounts.create({ label: "c", kind: "oauth", accessToken: "oauth-access",
  refreshToken: "r", expiresAt: Math.floor(Date.now() / 1000) + 7200, scope: "user:inference" });
const port = await new Promise<number>((r) => gw.server.listen(0, "127.0.0.1", () => r((gw.server.address() as AddressInfo).port)));
const gwToken = signGatewayToken(gw.cfg, "default");
const h = { "content-type": "application/json", authorization: "Bearer " + gwToken };

const models = await request(port, "/v1/models", { headers: h });
const list = ((models.json as Record<string, unknown>).data ?? []) as Array<Record<string, unknown>>;
ok("/v1/models 带 context_window", list.some((m) => m.context_window === 100000), JSON.stringify(list[0] ?? {}));
ok("/v1/models 带 max_output_tokens", list.some((m) => m.max_output_tokens === 32000));

const small = await request(port, "/v1/messages", { headers: h,
  body: { model: "claude-opus-5-5", max_tokens: 16, messages: [{ role: "user", content: "hi" }] } });
eq("小请求放行", small.status, 200);

const hitsBefore = upHits;
const big = await request(port, "/v1/messages", { headers: h,
  body: { model: "claude-opus-5-5", max_tokens: 16, messages: [{ role: "user", content: "a".repeat(120000 * 4) }] } });
eq("超限请求 400", big.status, 400);
const errCode = ((big.json as Record<string, unknown>).error as Record<string, unknown> | undefined)?.type;
eq("错误类型是 invalid_request_error", errCode, "invalid_request_error");
ok("超限请求没有打到上游", upHits === hitsBefore, "upHits=" + upHits + " before=" + hitsBefore);

/* 容差内要放行：窗口的 105% */
const near = await request(port, "/v1/messages", { headers: h,
  body: { model: "claude-opus-5-5", max_tokens: 16, messages: [{ role: "user", content: "a".repeat(105000 * 4) }] } });
eq("容差内（105%）放行", near.status, 200);

/* 压缩请求走接口也要能过 */
const compactReq = await request(port, "/v1/messages", { headers: h,
  body: { model: "claude-opus-5-5", max_tokens: 16,
    system: "Your task is to create a detailed summary of the conversation so far, paying close attention to the user's explicit requests and your previous actions.",
    messages: [{ role: "user", content: "a".repeat(120000 * 4) }] } });
eq("/compact 请求不被拦（能自救）", compactReq.status, 200);

/* 没配的模型不限制 */
const other = await request(port, "/v1/messages", { headers: h,
  body: { model: "some-other", max_tokens: 16, messages: [{ role: "user", content: "a".repeat(500000 * 4) }] } });
eq("兜底项也生效（*=100000 覆盖所有）", other.status, 400);

clearTimeout(watchdog);
console.log("\n" + (fail === 0 ? "全部通过" : failures.join("\n")));
console.log("PASS " + pass + "   FAIL " + fail);
cleanupDir(dataDir);
process.exit(fail === 0 ? 0 : 1);
