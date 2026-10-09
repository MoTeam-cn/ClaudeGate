#!/usr/bin/env node
/**
 * metadata.user_id 重写：一个号一个 device_id，上游看到的设备是稳定的。
 * 运行：node test/userid.test.ts
 */
import { rewriteUserId, newDeviceId } from "../src/userid.ts";

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

const DEV = "a".repeat(64);
const DEV2 = "b".repeat(64);

function mk(userId: string | undefined): Record<string, unknown> {
  return userId === undefined
    ? { model: "m" }
    : { model: "m", metadata: { user_id: userId } };
}
function uid(body: Record<string, unknown>): Record<string, unknown> {
  const m = body.metadata as Record<string, unknown> | undefined;
  return JSON.parse(String(m?.user_id ?? "{}")) as Record<string, unknown>;
}

console.log("\n=== A. newDeviceId ===");
{
  const d = newDeviceId();
  eq("长度 64", d.length, 64);
  ok("全是十六进制", /^[0-9a-f]{64}$/.test(d), d);
  ok("两次不一样", newDeviceId() !== newDeviceId());
}

console.log("\n=== B. device 模式：换 device_id，其余不动 ===");
{
  const body = mk(JSON.stringify({ device_id: "client-device", account_uuid: "", session_id: "sess-1" }));
  const r = rewriteUserId(body, { deviceId: DEV, mode: "device", createIfMissing: false, sessionId: "s" });
  ok("改了", r.changed, r.reason);
  eq("device_id 换成号的", uid(body).device_id, DEV);
  eq("account_uuid 保持原值", uid(body).account_uuid, "");
  eq("session_id 保持原值", uid(body).session_id, "sess-1");
  eq("键序 device_id 第一", Object.keys(uid(body))[0], "device_id");
  eq("model 没被动", body.model, "m");
}

console.log("\n=== C. 同一个号多次请求，device_id 恒定 ===");
{
  const a = mk(JSON.stringify({ device_id: "x", account_uuid: "", session_id: "s1" }));
  const b = mk(JSON.stringify({ device_id: "y", account_uuid: "", session_id: "s2" }));
  rewriteUserId(a, { deviceId: DEV, mode: "device", createIfMissing: false, sessionId: "s" });
  rewriteUserId(b, { deviceId: DEV, mode: "device", createIfMissing: false, sessionId: "s" });
  eq("两次 device_id 相同", uid(a).device_id, uid(b).device_id);
  ok("session_id 仍然各自不同", uid(a).session_id !== uid(b).session_id);
}

console.log("\n=== D. 不同号拿到不同 device_id ===");
{
  const a = mk(JSON.stringify({ device_id: "x", account_uuid: "", session_id: "s" }));
  const b = mk(JSON.stringify({ device_id: "x", account_uuid: "", session_id: "s" }));
  rewriteUserId(a, { deviceId: DEV, mode: "device", createIfMissing: false, sessionId: "s" });
  rewriteUserId(b, { deviceId: DEV2, mode: "device", createIfMissing: false, sessionId: "s" });
  ok("两个号不共用 device_id", uid(a).device_id !== uid(b).device_id);
}

console.log("\n=== E. full 模式连 account_uuid 一起 ===");
{
  const body = mk(JSON.stringify({ device_id: "x", account_uuid: "", session_id: "s" }));
  rewriteUserId(body, { deviceId: DEV, accountUuid: "uuid-1", mode: "full", createIfMissing: false, sessionId: "s" });
  eq("device_id", uid(body).device_id, DEV);
  eq("account_uuid 被写成号的", uid(body).account_uuid, "uuid-1");
}
{
  /* 号上没有 account_uuid 时不能瞎写 */
  const body = mk(JSON.stringify({ device_id: "x", account_uuid: "keep", session_id: "s" }));
  rewriteUserId(body, { deviceId: DEV, accountUuid: null, mode: "full", createIfMissing: false, sessionId: "s" });
  eq("号上没有 uuid 就保持客户端原值", uid(body).account_uuid, "keep");
}

console.log("\n=== F. 客户端没带 metadata 时补齐 ===");
{
  const body = mk(undefined);
  const r = rewriteUserId(body, { deviceId: DEV, mode: "device", createIfMissing: true, sessionId: "sess-9" });
  ok("补了", r.changed, r.reason);
  eq("device_id", uid(body).device_id, DEV);
  eq("account_uuid 空串", uid(body).account_uuid, "");
  eq("session_id 用请求头里的", uid(body).session_id, "sess-9");
}
{
  const body = mk(undefined);
  const r = rewriteUserId(body, { deviceId: DEV, mode: "device", createIfMissing: false, sessionId: "s" });
  ok("不允许补时就不补", !r.changed, r.reason);
  ok("metadata 仍然不存在", body.metadata === undefined);
}

console.log("\n=== G. 不该动的情况 ===");
{
  const body = mk(JSON.stringify({ device_id: DEV, account_uuid: "", session_id: "s" }));
  const r = rewriteUserId(body, { deviceId: DEV, mode: "device", createIfMissing: false, sessionId: "s" });
  ok("已经一致就不改", !r.changed, r.reason);
}
{
  const body = mk("这不是 JSON");
  const r = rewriteUserId(body, { deviceId: DEV, mode: "device", createIfMissing: false, sessionId: "s" });
  ok("user_id 不是 JSON 就不碰", !r.changed, r.reason);
  eq("原样保留", (body.metadata as Record<string, unknown>).user_id, "这不是 JSON");
}
{
  const body = mk(JSON.stringify({ device_id: "x", account_uuid: "", session_id: "s" }));
  const r = rewriteUserId(body, { deviceId: DEV, mode: "off", createIfMissing: true, sessionId: "s" });
  ok("off 模式什么都不做", !r.changed, r.reason);
  eq("device_id 保持客户端原值", uid(body).device_id, "x");
}
{
  const body = mk(JSON.stringify({ device_id: "x", account_uuid: "", session_id: "s" }));
  const r = rewriteUserId(body, { deviceId: null, mode: "device", createIfMissing: false, sessionId: "s" });
  ok("号上没 device_id 就不改", !r.changed, r.reason);
}

console.log("\n=== H. 额外键（ti / parent_session_id / tk）保留 ===");
{
  const body = mk(JSON.stringify({
    ti: "tok", device_id: "x", account_uuid: "u", session_id: "s",
    parent_session_id: "p", tk: "k"
  }));
  rewriteUserId(body, { deviceId: DEV, mode: "device", createIfMissing: false, sessionId: "s" });
  const u = uid(body);
  eq("ti 保留", u.ti, "tok");
  eq("parent_session_id 保留", u.parent_session_id, "p");
  eq("tk 保留", u.tk, "k");
  eq("device_id 在第一", Object.keys(u)[0], "device_id");
  eq("account_uuid 在第二", Object.keys(u)[1], "account_uuid");
  eq("session_id 在第三", Object.keys(u)[2], "session_id");
}

console.log("\n========================================");
console.log("  PASS " + pass + "   FAIL " + fail);
if (failures.length > 0) {
  console.log("  失败项：");
  for (const f of failures) console.log("   - " + f);
}
console.log("========================================");
process.exit(fail === 0 ? 0 : 1);
