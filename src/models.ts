import { MODEL_CATALOG, MODEL_ALIASES } from "./constants.ts";
import type { Config } from "./types.ts";

export interface OpenAIModelEntry {
  id: string;
  object: "model";
  created: number;
  owned_by: string;
}

export function resolveModel(name: string | undefined, cfg: Config): string {
  const m = String(name ?? "").trim();
  if (!m) return cfg.defaultModel;
  const low = m.toLowerCase();
  const alias = MODEL_ALIASES[low];
  if (alias) return alias;
  if (low.startsWith("claude-")) return m;
  return cfg.defaultModel;
}

export function listModels(): OpenAIModelEntry[] {
  return MODEL_CATALOG.map((m) => ({
    id: m.id,
    object: "model" as const,
    created: 1700000000,
    owned_by: "anthropic"
  }));
}

export function catalogIds(): string[] {
  return MODEL_CATALOG.map((m) => m.id);
}
