#!/usr/bin/env node
/**
 * 面板登录密钥的派发、派生、校验与重置。
 *
 * 验的核心承诺：
 *   1. 首次启动自动派发，明文只在日志里出现一次
 *   2. 盘上只有 scrypt 哈希，没有明文
 *   3. 登录密钥单向派生自主密钥 —— 主密钥换了才跟着换
 *   4. 面板能重置（自定义或随机），重置后旧密钥立刻失效
 *   5. 显式 ADMIN_TOKEN 时完全接管，不生成不打印
 *
 * 运行：node test/admin-key.test.ts 或 bun test/admin-key.test.ts
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createAdminKey, deriveLoginKey, LOGIN_KEY_PREFIX } from "../src/admin-key.ts";
import { parseEnvFile, upsertEnvVar, loadEnvFile } from "../src/env-file.ts";
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
function throws(name: string, fn: () => unknown, contains: string): void {
  try { fn(); ok(name, false, "本该抛错"); }
  catch (e) {
    const m = e instanceof Error ? e.message : String(e);
    ok(name, m.includes(contains), m);
  }
}

const watchdog = setTimeout(() => { console.log("\n!! 超时"); process.exit(3); }, 90000);
const dirs: string[] = [];
const quiet = { info: () => {}, warn: () => {} };
function tmpDir(tag: string): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "cg-ak-" + tag + "-"));
  dirs.push(d);
  return d;
}

/* ================= A. 单向派生 ================= */
console.log("\n=== A. 登录密钥的派生 ===");
{
  const m1 = "a".repeat(64);
  const m2 = "b".repeat(64);
  const k1 = deriveLoginKey(m1);
  const k1b = deriveLoginKey(m1);
  const k2 = deriveLoginKey(m2);
  eq("同一个主密钥派生出同一个密钥", k1, k1b);
  ok("不同主密钥派生出不同密钥", k1 !== k2);
  ok("带 cgk_ 前缀", k1.startsWith(LOGIN_KEY_PREFIX), k1.slice(0, 8));
  eq("正文 32 位", k1.length - LOGIN_KEY_PREFIX.length, 32);
  ok("只用小写字母与数字", /^cgk_[a-z2-7]{32}$/.test(k1), k1);
  /* 雪崩：改一个字符，输出应当完全不同（不是只差一位） */
  const m1x = "a".repeat(63) + "c";
  const kx = deriveLoginKey(m1x);
  let same = 0;
  for (let i = 0; i < k1.length; i++) if (k1[i] === kx[i]) same += 1;
  ok("改一个字符后几乎全变（雪崩）", same <= k1.length / 3, "相同位数=" + same);
  /* 单向：输出里不该出现主密钥的任何片段 */
  ok("输出不含主密钥片段", !k1.includes(m1.slice(0, 16)), k1);
}

/* ================= B. 首次派发 ================= */
console.log("\n=== B. 首次派发 ===");
let firstKey = "";
let firstMaster = "";
{
  const dataDir = tmpDir("first");
  const envFile = path.join(tmpDir("firstenv"), ".env");
  /* 真实部署里 .env 是用户从 .env.example 抄的；没有它时不会凭空创建（见 I 段） */
  fs.writeFileSync(envFile, "# 测试用\n", "utf8");
  const ak = createAdminKey({ dataDir, adminToken: "", adminSecret: "", envFile, envFileExplicit: true, log: quiet });
  ok("有要打印的明文", !!ak.announce, String(ak.announce));
  firstKey = String(ak.announce ?? "");
  ok("明文是 cgk_ 开头", firstKey.startsWith(LOGIN_KEY_PREFIX), firstKey.slice(0, 10));

  const raw = fs.readFileSync(path.join(dataDir, "admin.json"), "utf8");
  const saved = JSON.parse(raw) as Record<string, unknown>;
  eq("模式是 derived", saved.mode, "derived");
  ok("存了 salt", typeof saved.salt === "string" && (saved.salt as string).length >= 16);
  ok("存了 hash", typeof saved.hash === "string" && (saved.hash as string).length === 64);
  firstMaster = String(saved.master ?? "");
  ok("主密钥是 64 位 hex", /^[0-9a-f]{64}$/.test(firstMaster), firstMaster.slice(0, 12));
  /* 这是整个设计的核心承诺 */
  ok("盘上没有登录密钥明文", !raw.includes(firstKey), raw.slice(0, 80));
  ok("盘上也没有主密钥的派生结果", !raw.includes(deriveLoginKey(firstMaster)));

  const envText = fs.readFileSync(envFile, "utf8");
  ok(".env 里镜像了 ADMIN_SECRET", envText.includes("ADMIN_SECRET=" + firstMaster), envText.slice(0, 120));
  ok(".env 里没有登录密钥明文", !envText.includes(firstKey));
  eq("info 报告已镜像", ak.info().envMirrored, true);

  eq("密钥能通过校验", ak.verify(firstKey), true);
  eq("错密钥不通过", ak.verify("cgk_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"), false);
  eq("空串不通过", ak.verify(""), false);
  eq("派生出的值等于派发值", deriveLoginKey(firstMaster), firstKey);
}

/* ================= C. 二次启动不打印 ================= */
console.log("\n=== C. 二次启动不再打印 ===");
{
  const dataDir = tmpDir("second");
  const envFile = path.join(tmpDir("secondenv"), ".env");
  const a1 = createAdminKey({ dataDir, adminToken: "", adminSecret: "", envFile, log: quiet });
  const k = String(a1.announce ?? "");
  const a2 = createAdminKey({ dataDir, adminToken: "", adminSecret: "", envFile, log: quiet });
  eq("第二次启动没有要打印的明文", a2.announce, null);
  eq("同一个密钥仍然有效", a2.verify(k), true);
  eq("模式仍是 derived", a2.info().mode, "derived");
  /* 第三次也一样 */
  const a3 = createAdminKey({ dataDir, adminToken: "", adminSecret: "", envFile, log: quiet });
  eq("第三次启动也不打印", a3.announce, null);
}

/* ================= D. 主密钥换了才重新派发 ================= */
console.log("\n=== D. 主密钥换了要重新派生 ===");
{
  const dataDir = tmpDir("rot");
  const envFile = path.join(tmpDir("rotenv"), ".env");
  const a1 = createAdminKey({ dataDir, adminToken: "", adminSecret: "", envFile, log: quiet });
  const k1 = String(a1.announce ?? "");
  const newMaster = "f".repeat(64);
  const a2 = createAdminKey({ dataDir, adminToken: "", adminSecret: newMaster, envFile, log: quiet });
  ok("换了主密钥就重新派发", !!a2.announce, String(a2.announce));
  const k2 = String(a2.announce ?? "");
  ok("新密钥与旧的不同", k1 !== k2);
  eq("新密钥有效", a2.verify(k2), true);
  eq("旧密钥立刻失效", a2.verify(k1), false);
  eq("新密钥等于新主密钥的派生", k2, deriveLoginKey(newMaster));
  /* 主密钥换成同一个值不该重新派发 */
  const a3 = createAdminKey({ dataDir, adminToken: "", adminSecret: newMaster, envFile, log: quiet });
  eq("主密钥没变就不重新派发", a3.announce, null);
}

/* ================= E. 重置 ================= */
console.log("\n=== E. 面板重置 ===");
{
  const dataDir = tmpDir("reset");
  const envFile = path.join(tmpDir("reseten"), ".env");
  const ak = createAdminKey({ dataDir, adminToken: "", adminSecret: "", envFile, log: quiet });
  const original = String(ak.announce ?? "");

  const custom = "my-own-panel-key-2026";
  eq("reset 返回自定义值", ak.reset(custom), custom);
  eq("自定义密钥有效", ak.verify(custom), true);
  eq("原密钥立刻失效", ak.verify(original), false);
  eq("模式变成 custom", ak.info().mode, "custom");
  const raw = fs.readFileSync(path.join(dataDir, "admin.json"), "utf8");
  ok("自定义密钥也没落明文", !raw.includes(custom), raw.slice(0, 80));

  /* 重启后自定义密钥仍然有效，且不再打印 */
  const again = createAdminKey({ dataDir, adminToken: "", adminSecret: "", envFile, log: quiet });
  eq("重启后不打印", again.announce, null);
  eq("重启后自定义密钥仍有效", again.verify(custom), true);
  eq("重启后模式仍是 custom", again.info().mode, "custom");

  /* 随机重置 */
  const rnd = again.reset();
  ok("随机重置给 cgk_ 前缀", rnd.startsWith(LOGIN_KEY_PREFIX), rnd.slice(0, 10));
  eq("随机重置后有效", again.verify(rnd), true);
  eq("自定义密钥失效", again.verify(custom), false);

  throws("太短的自定义密钥被拒", () => again.reset("short"), "至少");
  eq("被拒之后原密钥仍然有效", again.verify(rnd), true);
}

/* ================= F. ADMIN_TOKEN 接管 ================= */
console.log("\n=== F. ADMIN_TOKEN 接管（逃生口）===");
{
  const dataDir = tmpDir("override");
  const envFile = path.join(tmpDir("overen"), ".env");
  const ak = createAdminKey({ dataDir, adminToken: "letmein", adminSecret: "", envFile, log: quiet });
  eq("接管时不打印", ak.announce, null);
  eq("模式是 env", ak.info().mode, "env");
  eq("ADMIN_TOKEN 本身有效", ak.verify("letmein"), true);
  eq("别的无效", ak.verify("cgk_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"), false);
  ok("不写 admin.json", !fs.existsSync(path.join(dataDir, "admin.json")));
  throws("接管时不允许面板重置", () => ak.reset("whatever-long-enough"), "ADMIN_TOKEN");
}

/* ================= G. .env 读写 ================= */
console.log("\n=== G. .env 读写 ===");
{
  const parsed = parseEnvFile([
    "# 注释",
    "PORT=8080",
    "export SECRET=abc",
    'QUOTED="a b c"',
    "HASH=va#lue",
    "EMPTY=",
    "not a kv line",
    ""
  ].join("\n"));
  eq("普通键", parsed.get("PORT"), "8080");
  eq("export 也认", parsed.get("SECRET"), "abc");
  eq("剥引号", parsed.get("QUOTED"), "a b c");
  eq("值里的 # 不截断", parsed.get("HASH"), "va#lue");
  eq("空值", parsed.get("EMPTY"), "");
  eq("非键值行被忽略", parsed.has("not a kv line"), false);

  const f = path.join(tmpDir("env"), ".env");
  fs.writeFileSync(f, "# 头部注释\nPORT=1\nSECRET=old\n", "utf8");
  eq("更新已有键", upsertEnvVar(f, "SECRET", "new"), true);
  const after = fs.readFileSync(f, "utf8");
  ok("注释保留", after.includes("# 头部注释"));
  ok("其它行保留", after.includes("PORT=1"));
  ok("值被替换", after.includes("SECRET=new") && !after.includes("SECRET=old"), after);
  ok("没有重复行", (after.match(/^SECRET=/gm) ?? []).length === 1);

  eq("追加新键", upsertEnvVar(f, "ADMIN_SECRET", "deadbeef"), true);
  const after2 = fs.readFileSync(f, "utf8");
  ok("新键已写入", after2.includes("ADMIN_SECRET=deadbeef"), after2);

  /* 真实环境变量优先：loadEnvFile 不覆盖已存在的键 */
  const env: Record<string, string | undefined> = { PORT: "9999" };
  const res = loadEnvFile(f, env);
  eq("已存在的键不被覆盖", env.PORT, "9999");
  eq("空缺的键被补上", env.ADMIN_SECRET, "deadbeef");
  eq("报告补了几项", res.applied, 2);
  eq("文件不存在时不算错", loadEnvFile(path.join(tmpDir("noenv"), "nope.env"), {}).exists, false);
}

/* ================= H. 端到端：HTTP 鉴权与重置 ================= */
console.log("\n=== H. 端到端 ===");
{
  const dataDir = tmpDir("e2e");
  const envFile = path.join(tmpDir("e2eenv"), ".env");
  fs.writeFileSync(envFile, "# 测试用\n", "utf8");
  const gw = createGateway({
    PORT: "0", HOST: "127.0.0.1", DATA_DIR: dataDir, SECRET: "ak-secret",
    LOG_LEVEL: "error", UPSTREAM_BASE: "http://127.0.0.1:1",
    /* 指到临时 .env，别碰仓库里那个 */
    CG_ENV_FILE: envFile
  } as never);
  const port = await new Promise<number>((r) => gw.server.listen(0, "127.0.0.1", () => r((gw.server.address() as AddressInfo).port)));

  const issued = String(gw.adminKey.announce ?? "");
  ok("网关首次启动派发了密钥", issued.startsWith(LOGIN_KEY_PREFIX), issued.slice(0, 10));
  ok("自动写了 .env", fs.existsSync(envFile));

  const anon = await request(port, "/panel/api?action=overview");
  eq("无密钥 401", anon.status, 401);
  const wrong = await request(port, "/panel/api?action=overview", { headers: { "x-admin-token": "nope" } });
  eq("错密钥 401", wrong.status, 401);
  const good = await request(port, "/panel/api?action=overview", { headers: { "x-admin-token": issued } });
  eq("派发的密钥 200", good.status, 200);

  const info = await request(port, "/panel/api?action=admin.keyinfo", { headers: { "x-admin-token": issued } });
  eq("keyinfo 200", info.status, 200);
  const d = (info.json as { data?: Record<string, unknown> }).data ?? {};
  eq("keyinfo 报告 derived", d.mode, "derived");
  ok("keyinfo 带主密钥指纹", typeof d.masterFingerprint === "string" && (d.masterFingerprint as string).length === 12, String(d.masterFingerprint));
  ok("keyinfo 不回传任何密钥材料", !JSON.stringify(d).includes(issued));

  const custom = "panel-key-i-choose-2026";
  const reset = await request(port, "/panel/api?action=admin.keyreset", {
    headers: { "x-admin-token": issued }, body: { key: custom }
  });
  eq("重置 200", reset.status, 200);
  eq("重置返回自定义值", (reset.json as { data?: { key?: string } }).data?.key, custom);

  const oldNow = await request(port, "/panel/api?action=overview", { headers: { "x-admin-token": issued } });
  eq("重置后旧密钥立刻 401", oldNow.status, 401);
  const newNow = await request(port, "/panel/api?action=overview", { headers: { "x-admin-token": custom } });
  eq("重置后新密钥 200", newNow.status, 200);

  const tooShort = await request(port, "/panel/api?action=admin.keyreset", {
    headers: { "x-admin-token": custom }, body: { key: "abc" }
  });
  eq("太短的被拒 400", tooShort.status, 400);

  await gw.close();
}

/* ================= I. 不该凭空创建 .env ================= */
console.log("\n=== I. 不往陌生目录里创建 .env ===");
{
  /* 数据目录是临时的（不是默认的 ./data），且 .env 不存在 -> 不创建。
     这条守的是「测试跑完在仓库里留一个 .env，被 Bun 自动加载污染后续运行」 */
  const dataDir = tmpDir("nofile");
  const envFile = path.join(tmpDir("nofileen"), ".env");
  const ak = createAdminKey({ dataDir, adminToken: "", adminSecret: "", envFile, log: quiet });
  ok("照样派发了密钥", String(ak.announce ?? "").startsWith(LOGIN_KEY_PREFIX), String(ak.announce).slice(0, 10));
  eq("但没有创建 .env", fs.existsSync(envFile), false);
  eq("info 如实报告没镜像", ak.info().envMirrored, false);
  ok("主密钥仍然落在 data 里", fs.existsSync(path.join(dataDir, "admin.json")));
}

clearTimeout(watchdog);
for (const d of dirs) cleanupDir(d);

console.log("\n================================");
console.log("  PASS " + pass + "   FAIL " + fail);
if (fail) { console.log("  失败项："); for (const f of failures) console.log("   - " + f); }
console.log("================================\n");
process.exit(fail ? 1 : 0);
