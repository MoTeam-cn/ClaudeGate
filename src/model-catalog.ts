/**
 * 模型目录。
 *
 * 之前 /v1/models 返回的是一份写死在 constants.ts 里的清单，早就过时了。
 * Claude Code 自己是从远端拉的（二进制里还原出来的地址）：
 *
 *   https://downloads.claude.ai/model-catalog/v1/catalog.json   真正的目录数据
 *   https://downloads.claude.ai/model-catalog/v1/schema.json    形状定义
 *   + raw-sig.json  detached 签名（RSASSA-PKCS1-v1_5 / SHA-512，网关不做验签）
 *
 * 目录里每个模型长这样（从二进制里还原）：
 *   { id: "claude-haiku-4-5", family: "haiku", display_name: "Haiku 4.5",
 *     provider_ids: { first_party: "claude-haiku-4-5-20251001", ... },
 *     context: { window: 200000 }, max_output_tokens: { default: 32000 }, ... }
 *
 * 注意 id 是家族名，provider_ids.first_party 才是真正发给上游的 id。
 * 另外 Claude Code 匹配模型时会去掉日期后缀（二进制里那句：
 *   uf(e).replace(/-\d{8}$/, "")  ），我们照做。
 *
 * 拉取策略：
 *   - 启动时先从磁盘缓存装上，进程内只留一份，/v1/models 永远读内存，绝不按请求出网
 *   - 过期（默认 6 小时）时后台悄悄刷一次，当前请求照旧用旧数据返回
 *   - 拉不到就退回内置清单，并如实记下原因
 */
import fs from "node:fs";
import path from "node:path";

import { MODEL_ALIASES, MODEL_CATALOG, PROD } from "./constants.ts";
import { requestRaw } from "./net/request.ts";
import type { Config, Logger } from "./types.ts";

export interface CatalogEntry {
  /** 家族 id，比如 claude-opus-5 */
  id: string;
  label: string;
  family: string;
  /** 发给上游的规范 id；老模型带日期后缀 */
  firstParty: string;
}

export type CatalogSource = "builtin" | "remote" | "cache";

export interface ModelCatalogState {
  entries: CatalogEntry[];
  source: CatalogSource;
  /** 远端拉取成功的时间；从内置清单起步时为 null */
  fetchedAt: number | null;
  /** 目录自带的版本号（远端文档里有 version 字段） */
  version: number | null;
  error: string | null;
}

export interface OpenAIModelEntry {
  id: string;
  object: "model";
  created: number;
  owned_by: string;
  /** 非标准字段，方便面板/客户端看出这是什么档位 */
  display_name?: string;
  family?: string;
}

export interface ModelCatalogHandle {
  /** 当前快照。永远同步返回，不出网 */
  get(): ModelCatalogState;
  /** 懒加载：过期就在后台刷，立即返回当前快照 */
  ensure(): ModelCatalogState;
  /** 强制刷新，等结果 */
  refresh(): Promise<ModelCatalogState>;
  list(): OpenAIModelEntry[];
  /** 这个模型 id 认不认（别名、日期后缀、[1m] 后缀都算过） */
  accepts(model: string | undefined | null): boolean;
  /** 解析成目录里的条目；认不出来返回 null */
  resolve(model: string | undefined | null): CatalogEntry | null;
  /** 正在刷新？ */
  refreshing(): boolean;
}

/** Claude Code 就是这么比的：去掉尾部 -YYYYMMDD */
function stripDate(v: string): string {
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

export function createModelCatalog(cfg: Config, log: Logger): ModelCatalogHandle {
  const cacheFile = path.join(cfg.dataDir, "model-catalog.json");
  let state: ModelCatalogState = {
    entries: builtinEntries(),
    source: "builtin",
    fetchedAt: null,
    version: null,
    error: null
  };
  /* 索引：家族 id、first_party、去日期后的形态，全部进同一个集合 */
  let accepted = new Set<string>();
  let busy = false;

  function reindex(): void {
    const s = new Set<string>();
    for (const e of state.entries) {
      for (const v of [e.id, e.firstParty]) {
        const n = normalizeModelId(v);
        s.add(n);
        s.add(stripDate(n));
      }
    }
    accepted = s;
  }
  reindex();

  function loadCache(): void {
    try {
      if (!fs.existsSync(cacheFile)) return;
      const doc = JSON.parse(fs.readFileSync(cacheFile, "utf8")) as {
        entries?: CatalogEntry[];
        fetchedAt?: number;
        version?: number | null;
      };
      const entries = Array.isArray(doc.entries) ? doc.entries.filter((e) => e && typeof e.id === "string") : [];
      if (!entries.length) return;
      state = {
        entries,
        source: "cache",
        fetchedAt: typeof doc.fetchedAt === "number" ? doc.fetchedAt : null,
        version: typeof doc.version === "number" ? doc.version : null,
        error: null
      };
      reindex();
      log.info("model catalog: 从磁盘缓存装入 " + entries.length + " 个模型");
    } catch (e) {
      log.warn("model catalog: 缓存读取失败（忽略）：" + (e instanceof Error ? e.message : String(e)));
    }
  }

  function saveCache(): void {
    try {
      fs.writeFileSync(
        cacheFile,
        JSON.stringify({ entries: state.entries, fetchedAt: state.fetchedAt, version: state.version }),
        { mode: 0o600 }
      );
    } catch (e) {
      log.warn("model catalog: 缓存写入失败（忽略）：" + (e instanceof Error ? e.message : String(e)));
    }
  }

  function stale(): boolean {
    if (state.fetchedAt === null) return true;
    return Date.now() - state.fetchedAt > cfg.modelCatalogTtlMs;
  }

  async function doRefresh(): Promise<ModelCatalogState> {
    if (busy) return state;
    busy = true;
    try {
      const res = await requestRaw(cfg.modelCatalogUrl, {
        cfg,
        method: "GET",
        headers: { accept: "application/json" },
        timeoutMs: 15000
      });
      if (!res.ok) {
        state = { ...state, error: "HTTP " + res.status + " " + res.text.slice(0, 160) };
        log.warn("model catalog: 拉取失败 " + state.error);
        return state;
      }
      const parsed = parseCatalog(JSON.parse(res.text));
      if (!parsed.entries.length) {
        state = { ...state, error: "响应里没有任何 claude-* 模型" };
        log.warn("model catalog: " + state.error + "，继续用旧数据");
        return state;
      }
      state = {
        entries: parsed.entries,
        source: "remote",
        fetchedAt: Date.now(),
        version: parsed.version,
        error: null
      };
      reindex();
      saveCache();
      log.info("model catalog: 拉到 " + parsed.entries.length + " 个模型" +
        (parsed.version === null ? "" : "（version " + parsed.version + "）"));
      return state;
    } catch (e) {
      state = { ...state, error: e instanceof Error ? e.message : String(e) };
      log.warn("model catalog: 拉取出错：" + state.error);
      return state;
    } finally {
      busy = false;
    }
  }

  loadCache();

  return {
    get: () => state,
    refreshing: () => busy,
    ensure() {
      /* 过期就后台刷，绝不阻塞当前请求 —— /v1/models 必须秒回 */
      if (stale() && !busy) void doRefresh();
      return state;
    },
    refresh: doRefresh,
    list() {
      const created = Math.floor((state.fetchedAt ?? Date.now()) / 1000);
      return state.entries.map((e) => ({
        id: e.id,
        object: "model" as const,
        created,
        owned_by: "anthropic",
        display_name: e.label,
        family: e.family
      }));
    },
    accepts(model) {
      const raw = String(model ?? "").trim();
      if (!raw) return false;
      const n = normalizeModelId(raw);
      if (accepted.has(n) || accepted.has(stripDate(n))) return true;
      const alias = MODEL_ALIASES[n];
      if (alias) {
        const a = normalizeModelId(alias);
        return accepted.has(a) || accepted.has(stripDate(a));
      }
      return false;
    },
    resolve(model) {
      const raw = String(model ?? "").trim();
      if (!raw) return null;
      let n = normalizeModelId(raw);
      const alias = MODEL_ALIASES[n];
      if (alias) n = normalizeModelId(alias);
      const bare = stripDate(n);
      for (const e of state.entries) {
        for (const v of [e.id, e.firstParty]) {
          const en = normalizeModelId(v);
          if (en === n || stripDate(en) === bare) return e;
        }
      }
      return null;
    }
  };
}

/** 默认目录地址（PROD 里那份，测试可以覆盖） */
export const DEFAULT_CATALOG_URL = PROD.MODEL_CATALOG_URL;
