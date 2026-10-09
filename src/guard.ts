import { CC_UA, CC_BETA, ANTHROPIC_VERSION } from "./constants.ts";
import { lowerHeaders, uuidFrom, toStr } from "./utils.ts";
import type { AuthState, Config, Logger } from "./types.ts";
import type { IncomingMessage } from "node:http";

const UA_RE = /^claude-(cli|code)\//i;
const XAPP_RE = /^cli(-bg)?$/i;

export interface GuardResult {
  ok: boolean;
  headers: Record<string, string | string[] | undefined>;
  missing: string[];
}

export function checkClaudeCodeHeaders(
  headers: Record<string, unknown>,
  cfg: Pick<Config, "guardRequire">
): { ok: boolean; missing: string[] } {
  const lh = lowerHeaders(headers);
  const missing: string[] = [];
  const require = cfg.guardRequire ?? [];

  for (const name of require) {
    const val = lh[name];
    if (val === undefined || val === null || String(val).trim() === "") {
      missing.push(name);
      continue;
    }
    if (name === "user-agent" && !UA_RE.test(String(val))) missing.push("user-agent(claude-cli/*)");
    if (name === "x-app" && !XAPP_RE.test(String(val).trim())) missing.push("x-app(cli)");
  }

  if (!require.includes("user-agent")) {
    const ua = lh["user-agent"];
    if (ua && !UA_RE.test(String(ua))) missing.push("user-agent(claude-cli/*)");
  }
  if (!require.includes("x-app")) {
    const xa = lh["x-app"];
    if (xa && !XAPP_RE.test(String(xa).trim())) missing.push("x-app(cli)");
  }

  return { ok: missing.length === 0, missing };
}

/**
 * 指纹稳定化：把缺失或不规范的 Claude Code 头改成规范值。
 * session-id 由种子（API Key id 或网关令牌）派生，保证同一调用方跨请求稳定。
 */
export function injectCanonicalHeaders(
  headers: Record<string, string | string[] | undefined>,
  cfg: Config,
  seed?: string
): Record<string, string | string[] | undefined> {
  const lh = lowerHeaders(headers);
  const out: Record<string, string | string[] | undefined> = { ...headers };

  if (!lh["user-agent"] || !UA_RE.test(toStr(lh["user-agent"]))) out["user-agent"] = CC_UA;
  if (!lh["x-app"] || !XAPP_RE.test(toStr(lh["x-app"]).trim())) out["x-app"] = "cli";
  if (!lh["anthropic-version"]) out["anthropic-version"] = ANTHROPIC_VERSION;
  if (!lh["anthropic-beta"]) out["anthropic-beta"] = CC_BETA;
  if (!lh["x-claude-code-session-id"]) {
    out["x-claude-code-session-id"] = uuidFrom(seed || cfg.secret);
  }
  return out;
}

/** 指纹种子：优先用 API Key 主键，避免把明文密钥参与派生 */
export function fingerprintSeed(auth: AuthState): string {
  return auth.apiKey?.id ?? auth.token ?? "";
}

/**
 * 按守卫模式决定放行 / 注入 / 拒绝。
 * 按 Key 区分的核心：绑定了 claude_code 指纹的 Key 走守卫；
 * 其它 Key 不守卫，但强制注入规范指纹，免得上游把请求看成第三方客户端。
 */
export function applyGuard(req: IncomingMessage, auth: AuthState, cfg: Config, log?: Logger): GuardResult {
  const enforce = auth.useClaudeFingerprint !== false;
  const seed = fingerprintSeed(auth);

  if (!enforce) {
    const headers = injectCanonicalHeaders(req.headers, cfg, seed);
    return { ok: true, headers, missing: [] };
  }

  if (cfg.guardMode === "off") return { ok: true, headers: req.headers, missing: [] };

  const headers = cfg.injectMissing
    ? injectCanonicalHeaders(req.headers, cfg, seed)
    : req.headers;

  const r = checkClaudeCodeHeaders(headers as Record<string, unknown>, cfg);
  if (r.ok) return { ok: true, headers, missing: [] };

  if (cfg.guardMode === "lenient") {
    log?.warn("header guard (lenient) missing: " + r.missing.join(", "));
    return { ok: true, headers, missing: r.missing };
  }
  return { ok: false, headers, missing: r.missing };
}
