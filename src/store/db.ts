import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";

export type SqlValue = string | number | bigint | null | Uint8Array;

/** 统一把 undefined / boolean 归一化成 sqlite 能接受的取值 */
export function bind(values: unknown[]): SqlValue[] {
  return values.map((v) => {
    if (v === undefined || v === null) return null;
    if (typeof v === "boolean") return v ? 1 : 0;
    if (typeof v === "number" || typeof v === "bigint" || typeof v === "string") return v;
    if (v instanceof Uint8Array) return v;
    return String(v);
  });
}

const SCHEMA = [
  "CREATE TABLE IF NOT EXISTS accounts (",
  "  id TEXT PRIMARY KEY,",
  "  label TEXT NOT NULL,",
  "  kind TEXT NOT NULL,",
  "  access_token TEXT,",
  "  refresh_token TEXT,",
  "  api_key TEXT,",
  "  expires_at INTEGER,",
  "  scope TEXT,",
  "  client_id TEXT,",
  "  mode TEXT,",
  "  account_uuid TEXT,",
  "  email TEXT,",
  "  status TEXT NOT NULL DEFAULT 'active',",
  "  last_error TEXT,",
  "  error_count INTEGER NOT NULL DEFAULT 0,",
  "  request_count INTEGER NOT NULL DEFAULT 0,",
  "  weight INTEGER NOT NULL DEFAULT 1,",
  "  cooldown_until INTEGER,",
  "  exhausted_until INTEGER,",
  "  exhausted_reason TEXT,",
  "  usage_json TEXT,",
  "  usage_at INTEGER,",
  "  rate_limit_json TEXT,",
  "  created_at INTEGER NOT NULL,",
  "  updated_at INTEGER NOT NULL",
  ");",
  "",

  "CREATE TABLE IF NOT EXISTS api_keys (",
  "  id TEXT PRIMARY KEY,",
  "  name TEXT NOT NULL,",
  "  key_hash TEXT NOT NULL UNIQUE,",
  "  key_prefix TEXT NOT NULL,",
  "  enabled INTEGER NOT NULL DEFAULT 1,",
  "  fingerprint_mode TEXT NOT NULL DEFAULT 'claude_code',",
  "  allowed_models TEXT NOT NULL DEFAULT '',",
  "  allowed_protocols TEXT NOT NULL DEFAULT '',",
  "  quota_enabled INTEGER NOT NULL DEFAULT 0,",
  "  rate_limit_per_min INTEGER NOT NULL DEFAULT 0,",
  "  daily_request_limit INTEGER NOT NULL DEFAULT 0,",
  "  daily_token_limit INTEGER NOT NULL DEFAULT 0,",
  "  bound_account_id TEXT,",
  "  created_at INTEGER NOT NULL,",
  "  updated_at INTEGER NOT NULL",
  ");",
  "",

  "CREATE TABLE IF NOT EXISTS api_key_usage (",
  "  key_id TEXT NOT NULL,",
  "  day TEXT NOT NULL,",
  "  requests INTEGER NOT NULL DEFAULT 0,",
  "  prompt_tokens INTEGER NOT NULL DEFAULT 0,",
  "  completion_tokens INTEGER NOT NULL DEFAULT 0,",
  "  cache_tokens INTEGER NOT NULL DEFAULT 0,",
  "  PRIMARY KEY (key_id, day)",
  ");",
  "",

  "CREATE TABLE IF NOT EXISTS request_logs (",
  "  id TEXT PRIMARY KEY,",
  "  ts INTEGER NOT NULL,",
  "  client_ip TEXT,",
  "  api_key_id TEXT,",
  "  api_key_name TEXT,",
  "  protocol TEXT,",
  "  method TEXT,",
  "  path TEXT,",
  "  model TEXT,",
  "  upstream_model TEXT,",
  "  account_id TEXT,",
  "  account_label TEXT,",
  "  status INTEGER,",
  "  outcome TEXT NOT NULL,",
  "  block_reason TEXT,",
  "  block_detail TEXT,",
  "  duration_ms INTEGER,",
  "  stream INTEGER NOT NULL DEFAULT 0,",
  "  prompt_tokens INTEGER NOT NULL DEFAULT 0,",
  "  completion_tokens INTEGER NOT NULL DEFAULT 0,",
  "  cache_creation_tokens INTEGER NOT NULL DEFAULT 0,",
  "  cache_read_tokens INTEGER NOT NULL DEFAULT 0,",
  "  error_message TEXT,",
  "  user_agent TEXT",
  ");",
  "",

  "CREATE TABLE IF NOT EXISTS runtime_logs (",
  "  id INTEGER PRIMARY KEY AUTOINCREMENT,",
  "  ts INTEGER NOT NULL,",
  "  level TEXT NOT NULL,",
  "  scope TEXT,",
  "  message TEXT NOT NULL,",
  "  detail TEXT",
  ");",
  "",

  "CREATE TABLE IF NOT EXISTS settings (",
  "  key TEXT PRIMARY KEY,",
  "  value TEXT NOT NULL,",
  "  updated_at INTEGER NOT NULL",
  ");",
  "",

  "CREATE INDEX IF NOT EXISTS idx_request_logs_ts ON request_logs (ts DESC);",
  "",
  "CREATE INDEX IF NOT EXISTS idx_request_logs_outcome ON request_logs (outcome);",
  "",
  "CREATE INDEX IF NOT EXISTS idx_request_logs_key ON request_logs (api_key_id);",
  "",
  "CREATE INDEX IF NOT EXISTS idx_request_logs_account ON request_logs (account_id);",
  "",
  "CREATE INDEX IF NOT EXISTS idx_runtime_logs_ts ON runtime_logs (ts DESC);"
].join("\n");

/** 老库缺列时补列；SQLite 没有 ADD COLUMN IF NOT EXISTS，只能先查表结构 */
const ADDITIONS: ReadonlyArray<readonly [string, string, string]> = [
  ["accounts", "exhausted_until", "INTEGER"],
  ["accounts", "exhausted_reason", "TEXT"],
  ["accounts", "usage_json", "TEXT"],
  ["accounts", "usage_at", "INTEGER"],
  ["accounts", "rate_limit_json", "TEXT"],
  ["request_logs", "cache_creation_tokens", "INTEGER NOT NULL DEFAULT 0"],
  ["request_logs", "cache_read_tokens", "INTEGER NOT NULL DEFAULT 0"],
  ["api_key_usage", "cache_tokens", "INTEGER NOT NULL DEFAULT 0"]
];

function migrateAdditions(raw: DatabaseSync): void {
  const seen = new Map<string, Set<string>>();
  for (const [table, column, decl] of ADDITIONS) {
    let cols = seen.get(table);
    if (!cols) {
      cols = new Set<string>();
      const rows = raw.prepare("PRAGMA table_info(" + table + ")").all() as unknown as Array<{ name: string }>;
      for (const r of rows) cols.add(r.name);
      seen.set(table, cols);
    }
    if (cols.has(column)) continue;
    raw.exec("ALTER TABLE " + table + " ADD COLUMN " + column + " " + decl);
  }
}

export interface Database {
  raw: DatabaseSync;
  close(): void;
}

export function openDatabase(dataDir: string): Database {
  fs.mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, "gateway.db");
  const raw = new DatabaseSync(file);

  /* WAL + NORMAL：读多写少场景下兼顾吞吐与安全 */
  raw.exec("PRAGMA journal_mode = WAL");
  raw.exec("PRAGMA synchronous = NORMAL");
  raw.exec("PRAGMA busy_timeout = 5000");
  raw.exec(SCHEMA);
  migrateAdditions(raw);

  return {
    raw,
    close(): void {
      try {
        raw.close();
      } catch {
        /* 已关闭 */
      }
    }
  };
}
