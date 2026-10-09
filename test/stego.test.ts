#!/usr/bin/env node
/**
 * 隐写检测与请求 ID 测试。
 * 运行：node test/stego.test.ts
 */

import os from "node:os";
import path from "node:path";
import fs from "node:fs";

import { scanStego, scanPayload, describeFindings } from "../src/security/stego.ts";
import { inspectPayload } from "../src/security/inspect.ts";
import { newRequestId, REQUEST_ID_RE, isRequestId } from "../src/ids.ts";
import { createGateway } from "../src/server.ts";
import { createMockUpstream } from "./helpers/mock-upstream.ts";
import { request, getText, asRecord } from "./helpers/client.ts";
import type { Config, StegoMode } from "../src/types.ts";

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

const APOS_OK = "'";
const APOS_2019 = "\u2019";
const APOS_02BC = "\u02bc";
const APOS_02B9 = "\u02b9";

function fakeCfg(stegoMode: StegoMode): Config {
  return { stegoMode } as Config;
}

const watchdog = setTimeout(() => {
  console.log("\n!! 测试超时（25s），已中断");
  process.exit(3);
}, 25000);

/* ============ A. scanStego ============ */
console.log("\n=== A. 单文本扫描 ===");

const normal = "Today's date is 2026-06-30.";
const rNormal = scanStego(normal);
eq("正常 ASCII 日期不命中", rNormal.hit, false);
eq("未命中时 cleaned 不变", rNormal.cleaned, normal);

const r2019 = scanStego("Today" + APOS_2019 + "s date is 2026-06-30.");
eq("U+2019 命中", r2019.hit, true);
eq("U+2019 类型", r2019.findings[0].kind, "apostrophe");
eq("U+2019 码位", r2019.findings[0].codepoint, 0x2019);
ok("U+2019 说明含域名名单", r2019.findings[0].meaning.includes("域名名单"), r2019.findings[0].meaning);

const r02bc = scanStego("Today" + APOS_02BC + "s date is 2026-06-30.");
eq("U+02BC 命中", r02bc.hit, true);
ok("U+02BC 说明含 AI 实验室", r02bc.findings[0].meaning.includes("AI 实验室"), r02bc.findings[0].meaning);

const r02b9 = scanStego("Today" + APOS_02B9 + "s date is 2026-06-30.");
eq("U+02B9 命中", r02b9.hit, true);
ok("U+02B9 说明含两者都命中", r02b9.findings[0].meaning.includes("两者都命中"), r02b9.findings[0].meaning);

const rSlash = scanStego("Today's date is 2026/06/30.");
eq("斜杠分隔符命中", rSlash.hit, true);
eq("斜杠类型", rSlash.findings[0].kind, "date_separator");

const rBoth = scanStego("Today" + APOS_2019 + "s date is 2026/06/30.");
ok("撇号加斜杠命中两条", rBoth.findings.length >= 2, String(rBoth.findings.length));

const rClean = scanStego("Today" + APOS_2019 + "s date is 2026/06/30.");
eq("清洗结果归一化为 ASCII", rClean.cleaned, normal);
eq("清洗后标记为已变更", rClean.changed, true);

const rStray = scanStego("prefix " + APOS_02BC + " suffix");
eq("游离 U+02BC 命中", rStray.hit, true);
eq("游离标记类型", rStray.findings[0].kind, "control_char");
eq("游离标记被清洗", rStray.cleaned, "prefix ' suffix");

const prose = "It" + APOS_2019 + "s a nice day, isn" + APOS_2019 + "t it?";
const rProse = scanStego(prose);
eq("普通英文撇号不误报", rProse.hit, false);

/* ============ B. scanPayload ============ */
console.log("\n=== B. 载荷扫描 ===");

const payload = {
  model: "claude-sonnet-4-5-20250929",
  system: "You are Claude Code.\nToday" + APOS_2019 + "s date is 2026/06/30.",
  messages: [{ role: "user", content: "hello" }]
};
const rp = scanPayload(payload);
eq("载荷命中", rp.hit, true);
const cleanedSystem = String((rp.payload as Record<string, unknown>).system);
ok("载荷已清洗", cleanedSystem.includes("Today's date is 2026-06-30."), cleanedSystem);
eq("未受影响字段保持原值", (rp.payload as Record<string, unknown>).model, payload.model);

const cleanPayload = { a: 1, b: "nothing here", c: [1, 2, "x"] };
const rpClean = scanPayload(cleanPayload);
eq("干净载荷不命中", rpClean.hit, false);
ok("干净载荷不做深拷贝", rpClean.payload === cleanPayload);

/* ============ C. describeFindings ============ */
console.log("\n=== C. 说明文本 ===");
const desc = describeFindings(rBoth.findings);
ok("说明非空", desc.length > 0);
ok("说明含撇号解释", desc.includes("撇号"), desc);
ok("说明含时区解释", desc.includes("时区"), desc);

/* ============ D. 请求 ID ============ */
console.log("\n=== D. 请求 ID ===");
const id1 = newRequestId();
ok("ID 形状合法", REQUEST_ID_RE.test(id1), id1);
ok("ID 前缀为 req_", id1.startsWith("req_"), id1);
eq("ID 长度为 30", id1.length, 30);
ok("isRequestId 接受合法值", isRequestId(id1));
ok("isRequestId 拒绝非法值", !isRequestId("abc"));
const ids = new Set<string>();
for (let i = 0; i < 2000; i++) ids.add(newRequestId());
eq("2000 次生成无重复", ids.size, 2000);

/* ============ E. inspectPayload ============ */
console.log("\n=== E. 体检裁决 ===");
const vBlock = inspectPayload(payload, fakeCfg("block"));
eq("block 模式动作", vBlock.action, "block");
eq("block 错误码", vBlock.code, "stego_marker_detected");
ok("block 说明含隐写", (vBlock.message ?? "").includes("隐写"), vBlock.message);

const vOff = inspectPayload(payload, fakeCfg("off"));
eq("off 模式放行", vOff.action, "allow");
ok("off 模式返回原载荷", vOff.payload === payload);

const vStrip = inspectPayload(payload, fakeCfg("strip"));
eq("strip 模式放行", vStrip.action, "allow");
eq("strip 错误码", vStrip.code, "stego_marker_cleaned");
ok("strip 模式返回清洗载荷", String((vStrip.payload as Record<string, unknown>).system).includes("Today's date is 2026-06-30."));

/* ============ F. 端到端 ============ */
console.log("\n=== F. 端到端 ===");

const cleanup: Array<() => Promise<void>> = [];
const dataDirs: string[] = [];

function newDir(tag: string): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "cg-stego-" + tag + "-"));
  dataDirs.push(d);
  return d;
}

const upstream = createMockUpstream();
const upPort = await upstream.listen();
cleanup.push(() => upstream.close());

const gw = createGateway({
  PORT: "0",
  HOST: "127.0.0.1",
  DATA_DIR: newDir("main"),
  SECRET: "stego-secret",
  UPSTREAM_BASE: "http://127.0.0.1:" + upPort,
  GUARD_MODE: "strict",
  STEGO_MODE: "block",
  LOG_LEVEL: "error"
});
const addr = await gw.listen(0, "127.0.0.1");
cleanup.push(() => gw.close());
gw.accounts.create({
  label: "stego-main",
  kind: "oauth",
  accessToken: "t",
  refreshToken: "r",
  expiresAt: Math.floor(Date.now() / 1000) + 3600,
  scope: "user:inference"
});

const TOKEN = (await getText(addr.port, "/token")).text.trim();
const CC: Record<string, string> = {
  authorization: "Bearer " + TOKEN,
  "content-type": "application/json",
  "user-agent": "claude-cli/2.1.293 (external, cli)",
  "x-app": "cli",
  "anthropic-version": "2023-06-01",
  "x-claude-code-session-id": "0f8fad5b-d9cb-469f-a165-70867728950e"
};

const before = upstream.calls;
const blocked = await request(addr.port, "/v1/messages", {
  headers: CC,
  body: {
    model: "claude-sonnet-4-5-20250929",
    max_tokens: 32,
    system: "Today" + APOS_2019 + "s date is 2026/06/30.",
    messages: [{ role: "user", content: "hi" }]
  }
});
eq("隐写请求被拦截 400", blocked.status, 400);
eq("拦截未触达上游", upstream.calls, before);
const blockedJson = asRecord(blocked.json);
ok("响应体含顶层 request_id", typeof blockedJson.request_id === "string", JSON.stringify(blockedJson).slice(0, 200));
const blockedErr = asRecord(blockedJson.error);
ok("响应体含 error.request_id", typeof blockedErr.request_id === "string");
eq("顶层与 error 内 ID 一致", blockedJson.request_id, blockedErr.request_id);
eq("错误码正确", blockedErr.code, "stego_marker_detected");
ok("响应体说明原因", String(blockedErr.message).includes("隐写"), String(blockedErr.message).slice(0, 120));
const headerKeys = Object.keys(blocked.headers).map((k) => k.toLowerCase());
ok("响应头不含 request id", !headerKeys.some((k) => k.includes("request-id") || k.includes("request_id")), headerKeys.join(","));

const okRes = await request(addr.port, "/v1/messages", {
  headers: CC,
  body: { model: "claude-sonnet-4-5-20250929", max_tokens: 32, messages: [{ role: "user", content: "hi" }] }
});
eq("干净请求正常 200", okRes.status, 200);
ok("干净请求触达上游", upstream.calls > before);

const unauth = await request(addr.port, "/v1/messages", { headers: { "content-type": "application/json" }, body: { messages: [] } });
eq("未鉴权 401", unauth.status, 401);
ok("401 响应体也带 request_id", typeof asRecord(unauth.json).request_id === "string");

const oaiBlocked = await request(addr.port, "/v1/chat/completions", {
  headers: CC,
  body: {
    model: "gpt-4o",
    messages: [
      { role: "system", content: "Today" + APOS_02BC + "s date is 2026-06-30." },
      { role: "user", content: "hi" }
    ]
  }
});
eq("OpenAI 路径同样拦截", oaiBlocked.status, 400);
const oaiErr = asRecord(asRecord(oaiBlocked.json).error);
ok("OpenAI 错误体带 request_id", typeof oaiErr.request_id === "string");
eq("OpenAI 错误码", oaiErr.code, "stego_marker_detected");

for (const fn of cleanup) {
  try {
    await fn();
  } catch {
    /* 忽略 */
  }
}
for (const d of dataDirs) {
  try {
    fs.rmSync(d, { recursive: true, force: true });
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
