/**
 * 模型解析与校验。
 *
 * 清单不再写死在这里 —— 改成由 model-catalog.ts 维护（远端拉取 + 内存缓存 + 磁盘兜底）。
 * 这里只负责：别名归一、请求里的模型 id 认不认。
 */
import { MODEL_ALIASES } from "./constants.ts";
import type { Config, GatewayContext } from "./types.ts";
import type { OpenAIModelEntry } from "./model-catalog.ts";

/**
 * 把客户端给的模型名归一成规范 id。
 * 认不出来（不是别名也不像 claude-*）就退回默认模型 —— 这是 OpenAI 兼容层的宽容策略，
 * 因为那边会收到 gpt-4o 这类名字。
 */
export function resolveModel(name: string | undefined, cfg: Config): string {
  const m = String(name ?? "").trim();
  if (!m) return cfg.defaultModel;
  const low = m.toLowerCase();
  const alias = MODEL_ALIASES[low];
  if (alias) return alias;
  if (low.startsWith("claude-")) return m;
  return cfg.defaultModel;
}

/** /v1/models 的清单。永远读内存快照，不会为了这个请求出网 */
export function listModels(ctx: GatewayContext): OpenAIModelEntry[] {
  ctx.modelCatalog.ensure();
  return ctx.modelCatalog.list();
}

export function catalogIds(ctx: GatewayContext): string[] {
  return ctx.modelCatalog.get().entries.map((e) => e.id);
}

/**
 * 消息接口的模型校验。
 *
 * 判据就是「这个 id 在不在 /v1/models 返回的那份清单里」—— 包括别名、
 * 带不带日期后缀、带不带 [1m] 后缀。不在就拒绝，免得把一个上游根本不认的
 * 名字发过去，换来一个语焉不详的 404。
 */
export function checkModelAllowed(
  ctx: GatewayContext,
  model: string | null
): { ok: true } | { ok: false; reason: string } {
  if (ctx.cfg.modelValidation === "off") return { ok: true };
  if (!model || !String(model).trim()) {
    return { ok: false, reason: "请求里没有 model 字段" };
  }
  if (ctx.modelCatalog.accepts(model)) return { ok: true };

  const ids = ctx.modelCatalog.get().entries
    .filter((e) => !ctx.modelCatalog.isHidden(e.id))
    .map((e) => e.id);
  const sample = ids.slice(0, 8).join(", ");
  return {
    ok: false,
    reason:
      "model \"" + String(model) + "\" 不在可用模型清单里。" +
      (ids.length ? "可用：" + sample + (ids.length > 8 ? " 等 " + ids.length + " 个" : "") + "。" : "") +
      "完整清单见 GET /v1/models。"
  };
}

/** 模型清单的状态，给面板看 */
export function catalogStatus(ctx: GatewayContext): Record<string, unknown> {
  const s = ctx.modelCatalog.get();
  return {
    source: s.source,
    /* count 是「对外」的条数，total 才是目录里一共多少个 */
    count: s.entries.filter((e) => !ctx.modelCatalog.isHidden(e.id)).length,
    total: s.entries.length,
    version: s.version,
    fetchedAt: s.fetchedAt,
    error: s.error,
    refreshing: ctx.modelCatalog.refreshing(),
    url: ctx.cfg.modelCatalogUrl,
    validation: ctx.cfg.modelValidation,
    ttlMs: ctx.cfg.modelCatalogTtlMs,
    envDisabled: ctx.cfg.modelDisabled,
    /* 全部模型 + 是否被隐藏，面板用它渲染勾选框 */
    models: s.entries.map((e) => ({
      id: e.id,
      label: e.label,
      family: e.family,
      firstParty: e.firstParty,
      hidden: ctx.modelCatalog.isHidden(e.id)
    }))
  };
}

/**
 * 把「部署级 MODEL_DISABLED + 面板里勾掉的」合并应用下去。
 * 两边取并集：env 是底座（改不了），面板是运行时开关。
 */
export function applyModelDisabled(ctx: GatewayContext): void {
  const fromPanel = parseDisabledSetting(ctx.settings.get("modelDisabled", "[]"));
  const merged = [...new Set([...ctx.cfg.modelDisabled, ...fromPanel])];
  ctx.modelCatalog.setDisabled(merged);
}

/** 面板存的是 JSON 数组；存坏了就当空，不能因为一个设置项把清单全清空 */
export function parseDisabledSetting(raw: string | undefined): string[] {
  try {
    const v = JSON.parse(String(raw ?? "[]")) as unknown;
    return Array.isArray(v) ? v.map((x) => String(x)).filter(Boolean) : [];
  } catch {
    return [];
  }
}
