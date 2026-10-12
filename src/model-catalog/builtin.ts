/** 内置兜底清单与远端目录的解析。与网关上下文无关，纯函数。 */

import { MODEL_ALIASES, MODEL_CATALOG } from "../constants.ts";
import type { CatalogEntry } from "./types.ts";

export function stripDate(v: string): string {
  return v.replace(/-\d{8}$/, "");
}

/** 去掉 1M 上下文标记（Claude Code 的 claude-opus-5[1m] 这种写法），再统一小写 */
export function normalizeModelId(raw: string): string {
  return String(raw ?? "").trim().toLowerCase().replace(/\[1m\]$/, "");
}

function entryOf(id: string, label: string, family: string, firstParty: string): CatalogEntry {
  return { id, label, family, firstParty };
}

/** 内置兜底清单：跟 Claude Code 2.1.293 里编译进去的那份对齐 */
export function builtinEntries(): CatalogEntry[] {
  return MODEL_CATALOG.map((m) => entryOf(m.id, m.label, m.family, m.firstParty));
}

/**
 * 从远端文档里把模型抠出来。
 * 目录的形状可能变，所以不写死路径 —— 深挖任何带 claude-* id 的对象。
 */
export function parseCatalog(raw: unknown): { entries: CatalogEntry[]; version: number | null } {
  const found = new Map<string, CatalogEntry>();
  let version: number | null = null;

  const visit = (v: unknown, depth: number): void => {
    if (depth > 8 || v === null || typeof v !== "object") return;
    if (Array.isArray(v)) {
      for (const item of v) visit(item, depth + 1);
      return;
    }
    const o = v as Record<string, unknown>;
    if (typeof o.version === "number" && version === null) version = o.version;

    const id = typeof o.id === "string" ? o.id : null;
    if (id && /^claude-[a-z0-9-]+$/i.test(id)) {
      const providers = o.provider_ids && typeof o.provider_ids === "object"
        ? (o.provider_ids as Record<string, unknown>)
        : null;
      const firstParty = providers && typeof providers.first_party === "string"
        ? providers.first_party
        : (typeof o.first_party === "string" ? o.first_party : id);
      const label =
        (typeof o.display_name === "string" && o.display_name) ||
        (typeof o.displayName === "string" && o.displayName) ||
        (typeof o.name === "string" && o.name) ||
        id;
      const family = typeof o.family === "string" && o.family ? o.family : id.split("-")[1] ?? "other";
      if (!found.has(id)) found.set(id, entryOf(id, label, family, firstParty));
    }
    for (const k of Object.keys(o)) visit(o[k], depth + 1);
  };

  visit(raw, 0);
  return { entries: [...found.values()], version };
}

