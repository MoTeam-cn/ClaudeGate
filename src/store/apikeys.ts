import crypto from "node:crypto";
import { bind } from "./db.ts";
import type { Database } from "./db.ts";
import { randHex } from "../utils.ts";
import type { ApiKeyInput, ApiKeyRecord, ApiKeyUsage, FingerprintMode } from "../types.ts";

const KEY_PREFIX = "sk-gw-";
const KEY_BODY_BYTES = 24;

interface Row {
  id: string;
  name: string;
  key_hash: string;
  key_prefix: string;
  enabled: number;
  fingerprint_mode: string;
  allowed_models: string;
  allowed_protocols: string;
  quota_enabled: number;
  rate_limit_per_min: number;
  daily_request_limit: number;
  daily_token_limit: number;
  bound_account_id: string | null;
  created_at: number;
  updated_at: number;
}

function splitList(v: string): string[] {
  return String(v || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function joinList(v: string[] | undefined): string {
  return (v ?? []).map((s) => String(s).trim()).filter(Boolean).join(",");
}

function toRecord(r: Row): ApiKeyRecord {
  return {
    id: r.id,
    name: r.name,
    keyHash: r.key_hash,
    keyPrefix: r.key_prefix,
    enabled: r.enabled === 1,
    fingerprintMode: (r.fingerprint_mode === "passthrough" ? "passthrough" : "claude_code") as FingerprintMode,
    allowedModels: splitList(r.allowed_models),
    allowedProtocols: splitList(r.allowed_protocols),
    quotaEnabled: r.quota_enabled === 1,
    rateLimitPerMin: r.rate_limit_per_min,
    dailyRequestLimit: r.daily_request_limit,
    dailyTokenLimit: r.daily_token_limit,
    boundAccountId: r.bound_account_id,
    createdAt: r.created_at,
    updatedAt: r.updated_at
  };
}

export function hashApiKey(plaintext: string): string {
  return crypto.createHash("sha256").update(plaintext).digest("hex");
}

export function newApiKeyPlaintext(): string {
  return KEY_PREFIX + crypto.randomBytes(KEY_BODY_BYTES).toString("base64url");
}

export function apiKeyPrefix(plaintext: string): string {
  if (plaintext.length <= 18) return plaintext;
  return plaintext.slice(0, 14) + "..." + plaintext.slice(-4);
}

export function isApiKeyPlaintext(v: string): boolean {
  return typeof v === "string" && v.startsWith(KEY_PREFIX);
}

export interface ApiKeyStore {
  list(): ApiKeyRecord[];
  get(id: string): ApiKeyRecord | null;
  create(input: ApiKeyInput): { record: ApiKeyRecord; plaintext: string };
  importKey(input: ApiKeyInput, plaintext: string): ApiKeyRecord;
  update(id: string, patch: Partial<ApiKeyInput> & { enabled?: boolean }): ApiKeyRecord | null;
  remove(id: string): boolean;
  findByPlaintext(plaintext: string): ApiKeyRecord | null;
  usage(keyId: string, day: string): ApiKeyUsage;
  bumpUsage(keyId: string, day: string, delta: { requests?: number; promptTokens?: number; completionTokens?: number }): void;
  usageDays(keyId: string, days: number): ApiKeyUsage[];
  todayTotals(day: string): { requests: number; tokens: number };
}

function dayString(ts = Date.now()): string {
  return new Date(ts).toISOString().slice(0, 10);
}

export function createApiKeyStore(db: Database): ApiKeyStore {
  const raw = db.raw;

  function get(id: string): ApiKeyRecord | null {
    const row = raw.prepare("SELECT * FROM api_keys WHERE id = ?").get(...bind([id])) as Row | undefined;
    return row ? toRecord(row) : null;
  }

  function list(): ApiKeyRecord[] {
    const rows = raw.prepare("SELECT * FROM api_keys ORDER BY created_at ASC").all() as unknown as Row[];
    return rows.map(toRecord);
  }

  function insert(input: ApiKeyInput, plaintext: string): ApiKeyRecord {
    const now = Math.floor(Date.now() / 1000);
    const id = "key_" + randHex(8);
    raw
      .prepare(
        "INSERT INTO api_keys (id, name, key_hash, key_prefix, enabled, fingerprint_mode, allowed_models, allowed_protocols, quota_enabled, rate_limit_per_min, daily_request_limit, daily_token_limit, bound_account_id, created_at, updated_at) " +
          "VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
      )
      .run(
        ...bind([
          id,
          input.name,
          hashApiKey(plaintext),
          apiKeyPrefix(plaintext),
          input.fingerprintMode ?? "claude_code",
          joinList(input.allowedModels),
          joinList(input.allowedProtocols),
          input.quotaEnabled ? 1 : 0,
          input.rateLimitPerMin ?? 0,
          input.dailyRequestLimit ?? 0,
          input.dailyTokenLimit ?? 0,
          input.boundAccountId ?? null,
          now,
          now
        ])
      );
    const created = get(id);
    if (!created) throw new Error("api key insert failed");
    return created;
  }

  function create(input: ApiKeyInput): { record: ApiKeyRecord; plaintext: string } {
    const plaintext = newApiKeyPlaintext();
    return { record: insert(input, plaintext), plaintext };
  }

  function importKey(input: ApiKeyInput, plaintext: string): ApiKeyRecord {
    return insert(input, plaintext);
  }

  function update(id: string, patch: Partial<ApiKeyInput> & { enabled?: boolean }): ApiKeyRecord | null {
    const cur = get(id);
    if (!cur) return null;
    const now = Math.floor(Date.now() / 1000);
    raw
      .prepare(
        "UPDATE api_keys SET name = ?, enabled = ?, fingerprint_mode = ?, allowed_models = ?, allowed_protocols = ?, quota_enabled = ?, rate_limit_per_min = ?, daily_request_limit = ?, daily_token_limit = ?, bound_account_id = ?, updated_at = ? WHERE id = ?"
      )
      .run(
        ...bind([
          patch.name ?? cur.name,
          (patch.enabled !== undefined ? patch.enabled : cur.enabled) ? 1 : 0,
          patch.fingerprintMode ?? cur.fingerprintMode,
          patch.allowedModels !== undefined ? joinList(patch.allowedModels) : cur.allowedModels.join(","),
          patch.allowedProtocols !== undefined ? joinList(patch.allowedProtocols) : cur.allowedProtocols.join(","),
          (patch.quotaEnabled !== undefined ? patch.quotaEnabled : cur.quotaEnabled) ? 1 : 0,
          patch.rateLimitPerMin !== undefined ? patch.rateLimitPerMin : cur.rateLimitPerMin,
          patch.dailyRequestLimit !== undefined ? patch.dailyRequestLimit : cur.dailyRequestLimit,
          patch.dailyTokenLimit !== undefined ? patch.dailyTokenLimit : cur.dailyTokenLimit,
          patch.boundAccountId !== undefined ? patch.boundAccountId : cur.boundAccountId,
          now,
          id
        ])
      );
    return get(id);
  }

  function remove(id: string): boolean {
    raw.prepare("DELETE FROM api_key_usage WHERE key_id = ?").run(...bind([id]));
    const r = raw.prepare("DELETE FROM api_keys WHERE id = ?").run(...bind([id]));
    return Number(r.changes) > 0;
  }

  function findByPlaintext(plaintext: string): ApiKeyRecord | null {
    const hash = hashApiKey(plaintext);
    const row = raw.prepare("SELECT * FROM api_keys WHERE key_hash = ?").get(...bind([hash])) as Row | undefined;
    return row ? toRecord(row) : null;
  }

  function usage(keyId: string, day: string): ApiKeyUsage {
    const row = raw
      .prepare("SELECT * FROM api_key_usage WHERE key_id = ? AND day = ?")
      .get(...bind([keyId, day])) as
      | { key_id: string; day: string; requests: number; prompt_tokens: number; completion_tokens: number; cache_tokens: number }
      | undefined;
    if (!row) return { keyId, day, requests: 0, promptTokens: 0, completionTokens: 0, cacheTokens: 0 };
    return {
      keyId: row.key_id,
      day: row.day,
      requests: row.requests,
      promptTokens: row.prompt_tokens,
      completionTokens: row.completion_tokens,
      cacheTokens: row.cache_tokens
    };
  }

  function bumpUsage(
    keyId: string,
    day: string,
    delta: { requests?: number; promptTokens?: number; completionTokens?: number; cacheTokens?: number }
  ): void {
    raw
      .prepare(
        "INSERT INTO api_key_usage (key_id, day, requests, prompt_tokens, completion_tokens, cache_tokens) VALUES (?, ?, ?, ?, ?, ?) " +
          "ON CONFLICT(key_id, day) DO UPDATE SET requests = requests + excluded.requests, prompt_tokens = prompt_tokens + excluded.prompt_tokens, completion_tokens = completion_tokens + excluded.completion_tokens, cache_tokens = cache_tokens + excluded.cache_tokens"
      )
      .run(
        ...bind([
          keyId,
          day,
          delta.requests ?? 0,
          delta.promptTokens ?? 0,
          delta.completionTokens ?? 0,
          delta.cacheTokens ?? 0
        ])
      );
  }

  function usageDays(keyId: string, days: number): ApiKeyUsage[] {
    const rows = raw
      .prepare("SELECT * FROM api_key_usage WHERE key_id = ? ORDER BY day DESC LIMIT ?")
      .all(...bind([keyId, days])) as unknown as Array<{
      key_id: string;
      day: string;
      requests: number;
      prompt_tokens: number;
      completion_tokens: number;
      cache_tokens: number;
    }>;
    return rows.map((r) => ({
      keyId: r.key_id,
      day: r.day,
      requests: r.requests,
      promptTokens: r.prompt_tokens,
      completionTokens: r.completion_tokens,
      cacheTokens: r.cache_tokens
    }));
  }

  function todayTotals(day: string): { requests: number; tokens: number } {
    const row = raw
      .prepare("SELECT COALESCE(SUM(requests),0) AS r, COALESCE(SUM(prompt_tokens + completion_tokens + cache_tokens),0) AS t FROM api_key_usage WHERE day = ?")
      .get(...bind([day])) as { r: number; t: number } | undefined;
    return { requests: row?.r ?? 0, tokens: row?.t ?? 0 };
  }

  return {
    list,
    get,
    create,
    importKey,
    update,
    remove,
    findByPlaintext,
    usage,
    bumpUsage,
    usageDays,
    todayTotals
  };
}

export { dayString };
