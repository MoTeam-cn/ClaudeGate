import { bind } from "./db.ts";
import type { Database } from "./db.ts";

export interface SettingsStore {
  all(): Record<string, string>;
  get(key: string, fallback?: string): string | undefined;
  set(key: string, value: string): void;
  setMany(patch: Record<string, string>): void;
  remove(key: string): void;
}

export function createSettingsStore(db: Database): SettingsStore {
  const raw = db.raw;

  function all(): Record<string, string> {
    const rows = raw.prepare("SELECT key, value FROM settings").all() as unknown as Array<{
      key: string;
      value: string;
    }>;
    const out: Record<string, string> = {};
    for (const r of rows) out[r.key] = r.value;
    return out;
  }

  function get(key: string, fallback?: string): string | undefined {
    const row = raw.prepare("SELECT value FROM settings WHERE key = ?").get(...bind([key])) as
      | { value: string }
      | undefined;
    return row ? row.value : fallback;
  }

  function set(key: string, value: string): void {
    raw
      .prepare(
        "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at"
      )
      .run(...bind([key, value, Math.floor(Date.now() / 1000)]));
  }

  function setMany(patch: Record<string, string>): void {
    raw.exec("BEGIN");
    try {
      for (const k of Object.keys(patch)) set(k, patch[k]);
      raw.exec("COMMIT");
    } catch (e) {
      try {
        raw.exec("ROLLBACK");
      } catch {
        /* 忽略 */
      }
      throw e;
    }
  }

  function remove(key: string): void {
    raw.prepare("DELETE FROM settings WHERE key = ?").run(...bind([key]));
  }

  return { all, get, set, setMany, remove };
}
