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
import { builtinEntries, normalizeModelId, parseCatalog, stripDate } from "./model-catalog/builtin.ts";
import type { CatalogEntry, ModelCatalogHandle, ModelCatalogState } from "./model-catalog/types.ts";
export * from "./model-catalog/types.ts";
export * from "./model-catalog/builtin.ts";

/**
 * 模型目录的句柄与刷新逻辑。
 *
 * 形状与纯函数拆在 model-catalog/ 下（types / builtin），
 * 这里留需要状态的 createModelCatalog —— 单文件曾达 337 行。
 */

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
  let hidden = new Set<string>();
  let busy = false;

  /** 归一成一个可比的 key：小写、去 [1m]、去日期后缀 */
  function keyOf(v: string): string {
    return stripDate(normalizeModelId(v));
  }

  /** 目录里没被隐藏的模型 —— 对外只认这些 */
  function visible(): CatalogEntry[] {
    return state.entries.filter((e) => !hidden.has(keyOf(e.id)) && !hidden.has(keyOf(e.firstParty)));
  }

  function reindex(): void {
    const s = new Set<string>();
    for (const e of visible()) {
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
      return visible().map((e) => ({
        id: e.id,
        object: "model" as const,
        created,
        owned_by: "anthropic",
        display_name: e.label,
        family: e.family
      }));
    },
    setDisabled(ids) {
      hidden = new Set((ids ?? []).map((x) => keyOf(String(x))).filter(Boolean));
      reindex();
    },
    disabled: () => [...hidden],
    all: () => state.entries,
    isHidden(id) {
      return hidden.has(keyOf(id));
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
      for (const e of visible()) {
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

