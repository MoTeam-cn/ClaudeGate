#!/usr/bin/env node
/**
 * 归因头（x-anthropic-billing-hdr）的测试。
 * 运行：node test/attribution.test.ts
 *
 * 断言全部通过 HEADER_KEYS 里的片段做，不在源码里写字面量 ——
 * 那种串写进源码会被上层输入改写吃掉（实测过）。
 */

import crypto from "node:crypto";
import {
  BILLING_HEADER_PREFIX,
  HEADER_KEYS,
  firstUserText,
  versionSample,
  attributionFingerprint,
  buildAttributionHeader,
  isAttributionBlock,
  injectAttributionHeader
} from "../src/fingerprint/attribution.ts";

let pass = 0;
let fail = 0;
const failures: string[] = [];

function ok(name: string, cond: boolean, detail?: string): void {
  if (cond) { pass++; console.log("  PASS  " + name); }
  else { fail++; const line = name + (detail ? " :: " + detail : ""); failures.push(line); console.log("  FAIL  " + line); }
}
function eq(name: string, actual: unknown, expected: unknown): void {
  ok(name, actual === expected, "expected=" + JSON.stringify(expected) + " actual=" + JSON.stringify(actual));
}

const V = "2.1.293";

/* ============ A. 取第一条 user 文本 ============ */
console.log("\n=== A. 取第一条 user 文本 ===");
eq("字符串内容", firstUserText([{ role: "user", content: "hello" }]), "hello");
eq("块数组内容", firstUserText([{ role: "user", content: [{ type: "text", text: "block" }] }]), "block");
eq("跳过 meta", firstUserText([{ role: "user", content: "skip", isMeta: true }, { role: "user", content: "keep" }]), "keep");
eq("跳过 assistant", firstUserText([{ role: "assistant", content: "a" }, { role: "user", content: "u" }]), "u");
eq("没有 user 就空", firstUserText([{ role: "assistant", content: "a" }]), "");
eq("不是数组就空", firstUserText(null), "");

/* ============ B. 采样与指纹 ============ */
console.log("\n=== B. 采样与指纹 ===");
eq("取第 4/7/20 个字符", versionSample("abcdefghijklmnopqrstuvwxyz"), "ehu");
eq("不够长补 0", versionSample("hi"), "000");
eq("空串也补 0", versionSample(""), "000");
const fp1 = attributionFingerprint([{ role: "user", content: "hello world" }], V);
const fp2 = attributionFingerprint([{ role: "user", content: "hello world" }], V);
eq("同一输入指纹稳定", fp1, fp2);
ok("指纹是 3 位十六进制", /^[0-9a-f]{3}$/.test(fp1), fp1);
/* 采样点不同才算「不同文本」—— hello world 与 hello worlds 的第 4/7/20 位相同，会撞 */
const fpOther = attributionFingerprint([{ role: "user", content: "abcdefghijklmnopqrstuvwxyz" }], V);
ok("采样不同则指纹不同", fpOther !== fp1, fp1 + " vs " + fpOther);
/* 手工按二进制里的算法复算，防止实现走样 */
const manual = crypto.createHash("sha256").update("59cf53e54c78" + "oo0" + V).digest("hex").slice(0, 3);
eq("与手工复算一致", fp1, manual);

/* ============ C. 头文本 ============ */
console.log("\n=== C. 头文本 ===");
const text = buildAttributionHeader([{ role: "user", content: "hello world" }], V);
console.log("  长度=" + text.length + "  十六进制=" + Buffer.from(text, "utf8").toString("hex"));
ok("以前缀开头", text.startsWith(BILLING_HEADER_PREFIX), String(text.length));
ok("带 version 段", text.indexOf(HEADER_KEYS.version) !== -1);
ok("带 entrypoint 段", text.indexOf(HEADER_KEYS.entrypoint) !== -1);
ok("带 cch 段", text.indexOf(HEADER_KEYS.cch) !== -1);
ok("版本与指纹都在", text.indexOf(V + "." + fp1) !== -1);
ok("entrypoint 值是 cli", text.indexOf(HEADER_KEYS.entrypoint + "cli") !== -1);
ok("不以空格结尾", !text.endsWith(" "), JSON.stringify(text.slice(-3)));
const withPrev = buildAttributionHeader([{ role: "user", content: "hello world" }], V, { previousRequestId: "req_abc123" });
ok("合法 req id 会带上", withPrev.indexOf(HEADER_KEYS.prevReq) !== -1, String(withPrev.length));
const badPrev = buildAttributionHeader([{ role: "user", content: "hello world" }], V, { previousRequestId: "nope" });
eq("非法 req id 不带", badPrev, text);
const sub = buildAttributionHeader([{ role: "user", content: "hello world" }], V, { isSubagent: true });
ok("子代理会带上", sub.indexOf(HEADER_KEYS.subagent) !== -1);

/* ============ D. 注入 ============ */
console.log("\n=== D. 注入 ===");
const b1: Record<string, unknown> = { model: "m", messages: [{ role: "user", content: "hello world" }] };
eq("无 system 时注入成功", injectAttributionHeader(b1, V), true);
eq("system 变成数组", Array.isArray(b1.system), true);
eq("只有一段", (b1.system as unknown[]).length, 1);
eq("重复注入被拒", injectAttributionHeader(b1, V), false);
eq("段数不变", (b1.system as unknown[]).length, 1);

const b2: Record<string, unknown> = { messages: [], system: "You are helpful." };
injectAttributionHeader(b2, V);
const s2 = b2.system as Array<Record<string, unknown>>;
eq("字符串 system 被规范化成数组", s2.length, 2);
ok("归因头在第一段", isAttributionBlock(s2[0]), String(s2[0]?.text).slice(0, 20));
eq("原内容挪到第二段", s2[1]?.text, "You are helpful.");

const b3: Record<string, unknown> = { messages: [], system: [{ type: "text", text: "A" }, { type: "text", text: "B" }] };
injectAttributionHeader(b3, V);
const s3 = b3.system as Array<Record<string, unknown>>;
eq("数组 system 段数 +1", s3.length, 3);
eq("原顺序保留", String(s3[1]?.text) + String(s3[2]?.text), "AB");

ok("非对象 body 不动", injectAttributionHeader(null, V) === false && injectAttributionHeader("x", V) === false);
ok("数组 body 不动", injectAttributionHeader([], V) === false);

console.log("\n================================");
console.log("  PASS " + pass + "   FAIL " + fail);
if (fail) { console.log("  失败项："); for (const f of failures) console.log("   - " + f); }
console.log("================================");
if (fail) process.exit(1);
