/**
 * 面板管理员密钥的派发与校验。
 *
 * 要解决的问题：原来 ADMIN_TOKEN 得自己编一个填进环境变量，忘了就进不去面板。
 * 现在的规则：
 *
 *   1. 主密钥（master）不存在就自动生成，落到 data/admin.json（0600），
 *      并尽力镜像一份到工作目录的 .env，方便人查看与备份。
 *   2. **登录密钥 = 单向派生自 master**（HMAC-SHA256）。不可逆：
 *      拿到登录密钥推不出 master；master 换了登录密钥才会跟着换。
 *   3. 盘上只存登录密钥的 scrypt 哈希，不存明文。明文只在首次派发时打印一次。
 *   4. 面板可以重置：自定义一个，或让系统随机生成。重置后的明文只在面板里显示一次，
 *      不再进日志。
 *
 * 优先级（主密钥从哪来）：
 *   ADMIN_SECRET 环境变量（含 .env 里读进来的） > data/admin.json 里的 master > 新生成
 *
 * 逃生口：显式设 ADMIN_TOKEN 时完全走旧行为 —— 直接拿它比对，不生成、不派生、不打印。
 * 忘了登录密钥又进不去面板时用它救。
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { randHex, nowSec } from "./utils.ts";
import { upsertEnvVar } from "./env-file.ts";

const DERIVE_LABEL = "claude-gateway/panel-login-key/v1";
export const LOGIN_KEY_PREFIX = "cgk_";
const B32 = "abcdefghijklmnopqrstuvwxyz234567";
const MIN_CUSTOM_LEN = 12;

export interface AdminKeyState {
  version: 1;
  mode: "derived" | "custom";
  salt: string;
  hash: string;
  /** 仅 derived 模式：主密钥的指纹，用来判断 master 换没换 */
  masterFingerprint: string;
  /** 仅 derived 模式：主密钥本体。放这里是为了 .env 丢了也能起来 */
  master: string;
  createdAt: number;
  rotatedAt: number;
}

export interface AdminKeyInfo {
  mode: "derived" | "custom" | "env";
  envOverride: boolean;
  createdAt: number;
  rotatedAt: number;
  /** 主密钥指纹前 12 位，用来肉眼确认 master 是哪一个 */
  masterFingerprint: string;
  keyFile: string;
  envFile: string;
  /** .env 镜像写成功了没 */
  envMirrored: boolean;
}

/** base32 小写无填充：比 hex 短，比 base64 好念好抄 */
function base32(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const b of buf) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

function sha256Hex(s: string): string {
  return crypto.createHash("sha256").update(s).digest("hex");
}

function fingerprint(master: string): string {
  return sha256Hex("fp:" + master).slice(0, 12);
}

/**
 * 登录密钥的单向派生。
 * HMAC-SHA256 以主密钥为键、固定标签为消息 —— 单向：已知输出无法还原主密钥。
 */
export function deriveLoginKey(master: string): string {
  const h = crypto.createHmac("sha256", master).update(DERIVE_LABEL).digest();
  return LOGIN_KEY_PREFIX + base32(h.subarray(0, 20));
}

function randomLoginKey(): string {
  return LOGIN_KEY_PREFIX + base32(crypto.randomBytes(20));
}

function hashKey(key: string, salt: string): string {
  return crypto.scryptSync(key, salt, 32).toString("hex");
}

function safeEqualHex(a: string, b: string): boolean {
  const x = Buffer.from(a, "hex");
  const y = Buffer.from(b, "hex");
  if (x.length !== y.length || x.length === 0) return false;
  return crypto.timingSafeEqual(x, y);
}

export interface AdminKey {
  info(): AdminKeyInfo;
  verify(presented: string): boolean;
  reset(custom?: string): string;
  /** 首次派发时要打印一次的明文；没有要打印的就返回 null */
  readonly announce: string | null;
}

export interface CreateAdminKeyOptions {
  dataDir: string;
  /** 显式 ADMIN_TOKEN，设了就完全接管 */
  adminToken: string;
  /** 主密钥，来自 ADMIN_SECRET（可能来自 .env） */
  adminSecret: string;
  /** .env 路径；空串表示不镜像 */
  envFile: string;
  /** CG_ENV_FILE 是不是用户显式指定的。显式指定就一定按它写，不受下面那条守卫限制 */
  envFileExplicit?: boolean;
  log: { info(m: string): void; warn(m: string): void };
}

export function createAdminKey(opts: CreateAdminKeyOptions): AdminKey {
  const keyFile = path.join(opts.dataDir, "admin.json");
  fs.mkdirSync(opts.dataDir, { recursive: true });

  let state: AdminKeyState | null = null;
  try {
    const parsed = JSON.parse(fs.readFileSync(keyFile, "utf8")) as AdminKeyState;
    if (parsed && parsed.version === 1 && parsed.hash && parsed.salt) state = parsed;
  } catch {
    state = null;
  }

  const envOverride = !!opts.adminToken;
  let announce: string | null = null;
  let envMirrored = false;
  const verified = new Set<string>();

  function save(): void {
    const tmp = keyFile + ".tmp-" + process.pid;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });
    fs.renameSync(tmp, keyFile);
  }

  if (envOverride) {
    /* 逃生口：不生成、不派生、不打印 */
  } else {
    const fromEnv = String(opts.adminSecret ?? "").trim();
    const fromDisk = state && state.mode === "derived" ? String(state.master ?? "") : "";
    const hadState = !!state;
    let master = fromEnv || fromDisk;
    let generated = false;
    if (!master) {
      master = randHex(32);
      generated = true;
    }

    const fp = fingerprint(master);
    /* 没状态、或主密钥换了，都要重新派生 */
    const mustDerive = !hadState || (state!.mode === "derived" && state!.masterFingerprint !== fp);

    if (mustDerive) {
      const key = deriveLoginKey(master);
      const salt = randHex(16);
      state = {
        version: 1,
        mode: "derived",
        salt,
        hash: hashKey(key, salt),
        masterFingerprint: fp,
        master,
        createdAt: state ? state.createdAt : nowSec(),
        rotatedAt: nowSec()
      };
      save();
      announce = key;
      if (generated) opts.log.info("admin-key: 首次派发主密钥 -> " + keyFile);
      else if (!hadState) opts.log.info("admin-key: 沿用 ADMIN_SECRET 派发登录密钥");
      else opts.log.warn("admin-key: 主密钥变了（指纹 " + fp + "），登录密钥已重新派生");
    }

    /* 尽力把主密钥镜像进 .env，方便查看与备份。写不进去不影响运行。
       但**只在看起来是真实部署时才动手**：.env 已经存在，或数据目录还是默认的 ./data。
       原因是 Bun 会自动加载工作目录的 .env —— 测试往仓库里写一个，后续所有运行都会读到它 */
    const defaultDataDir = path.resolve(process.cwd(), "data");
    const mayWriteEnv = !!opts.envFile && (
      !!opts.envFileExplicit ||
      fs.existsSync(opts.envFile) ||
      path.resolve(opts.dataDir) === defaultDataDir
    );
    if (mayWriteEnv && mustDerive) {
      envMirrored = upsertEnvVar(opts.envFile, "ADMIN_SECRET", master);
      if (!envMirrored) {
        opts.log.warn("admin-key: 写不进 " + opts.envFile + "，主密钥只在 " + keyFile);
      }
    }
  }

  function info(): AdminKeyInfo {
    return {
      mode: envOverride ? "env" : (state ? state.mode : "derived"),
      envOverride,
      createdAt: state ? state.createdAt : 0,
      rotatedAt: state ? state.rotatedAt : 0,
      masterFingerprint: state ? state.masterFingerprint : "",
      keyFile,
      envFile: opts.envFile,
      envMirrored
    };
  }

  function verify(presented: string): boolean {
    const v = String(presented ?? "");
    if (!v) return false;
    if (envOverride) return v === opts.adminToken;
    if (!state) return false;
    /* scrypt 一次几十毫秒，面板每 15 秒刷一次；校验过的摘要缓存在内存里 */
    const d = sha256Hex(v);
    if (verified.has(d)) return true;
    if (!safeEqualHex(hashKey(v, state.salt), state.hash)) return false;
    verified.add(d);
    return true;
  }

  function reset(custom?: string): string {
    const trimmed = String(custom ?? "").trim();
    if (trimmed && trimmed.length < MIN_CUSTOM_LEN) {
      throw new Error("自定义密钥至少 " + MIN_CUSTOM_LEN + " 个字符");
    }
    if (envOverride) throw new Error("当前由 ADMIN_TOKEN 接管，改它请改环境变量");
    const key = trimmed || randomLoginKey();
    const salt = randHex(16);
    state = {
      version: 1,
      mode: "custom",
      salt,
      hash: hashKey(key, salt),
      masterFingerprint: state ? state.masterFingerprint : "",
      master: state ? state.master : "",
      createdAt: state ? state.createdAt : nowSec(),
      rotatedAt: nowSec()
    };
    save();
    /* 旧密钥立刻失效 */
    verified.clear();
    return key;
  }

  return { info, verify, reset, announce };
}
