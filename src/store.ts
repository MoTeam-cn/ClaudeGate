import fs from "node:fs";
import path from "node:path";
import { randHex } from "./utils.ts";
import type { Config, Credential, PendingAuth, Store } from "./types.ts";

const PENDING_TTL_MS = 15 * 60 * 1000;

/**
 * 凭据与临时授权态存储。
 *   data/secret          网关令牌签名密钥（0600，缺失自动生成）
 *   data/credential.json 上游凭据（0600）
 * 写盘走 tmp + rename，保证原子性，避免 worker/重启读到半截文件。
 */
export function createStore(cfg: Config): Store {
  fs.mkdirSync(cfg.dataDir, { recursive: true });

  const credPath = path.join(cfg.dataDir, "credential.json");
  const secretPath = path.join(cfg.dataDir, "secret");

  let secret = cfg.secret;
  if (!secret) {
    try {
      secret = fs.readFileSync(secretPath, "utf8").trim();
    } catch {
      /* 首次启动 */
    }
    if (!secret) {
      secret = randHex(32);
      fs.writeFileSync(secretPath, secret + "\n", { mode: 0o600 });
    }
  }
  cfg.secret = secret;

  let credential: Credential | null = null;
  try {
    credential = JSON.parse(fs.readFileSync(credPath, "utf8")) as Credential;
  } catch {
    credential = null;
  }

  const pending = new Map<string, PendingAuth>();
  let refreshInFlight: Promise<Credential | null> | null = null;

  function saveCredential(cred: Credential): void {
    credential = cred;
    const tmp = credPath + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(cred, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, credPath);
  }

  function clearCredential(): void {
    credential = null;
    try {
      fs.unlinkSync(credPath);
    } catch {
      /* 文件可能不存在 */
    }
  }

  function putPending(state: string, value: PendingAuth): void {
    const cutoff = Date.now() - PENDING_TTL_MS;
    for (const [k, v] of pending) if (v.createdAt < cutoff) pending.delete(k);
    pending.set(state, value);
  }

  function takePending(state: string): PendingAuth | undefined {
    const v = pending.get(state);
    pending.delete(state);
    return v;
  }

  return {
    get credential() {
      return credential;
    },
    saveCredential,
    clearCredential,
    putPending,
    takePending,
    get refreshInFlight() {
      return refreshInFlight;
    },
    set refreshInFlight(v: Promise<Credential | null> | null) {
      refreshInFlight = v;
    }
  };
}
