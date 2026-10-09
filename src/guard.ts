import { CC_UA, CC_BETA, ANTHROPIC_VERSION } from "./constants.ts";
import { lowerHeaders, uuidFrom, toStr } from "./utils.ts";
import type { AuthState, Config, Logger } from "./types.ts";
import type { IncomingMessage } from "node:http";

const UA_RE = /^claude-(cli|code)\//i;
const XAPP_RE = /^cli(-bg)?$/i;

/**
 * 不守卫的只读元数据端点。
 *
 * 守卫的目的是让上游看到的「客户端身份」稳定，那是推理请求的事。
 * /v1/models 只是拉个模型清单，没有推理、没有账号风险，
 * 却因为要求客户端带 Claude Code 身份头而把 curl / 探活 / 监控全挡在外面 —— 得不偿失。
 * 这里改成「缺什么就自己补上」，指纹照样是 Claude Code 的，只是不再拒绝。
 */
const GUARD_EXEMPT: readonly RegExp[] = [/^\/v1\/models(\/|$)/];

/** 这个方法 + 路径要不要跳过守卫（只读元数据端点） */
export function isGuardExempt(method: string, url: string): boolean {
  const m = method.toUpperCase();
  if (m !== "GET" && m !== "HEAD") return false;
  const path = (url.split("?")[0] ?? "");
  return GUARD_EXEMPT.some((re) => re.test(path));
}

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

/**
 * 只补「指纹类」头。这些是网关的职责，不是客户端的：
 *   - x-claude-code-session-id 由种子（Key id / 网关令牌）派生，保证同一调用方跨请求稳定。
 *     要求客户端提供它反而有害 —— 第三方客户端只会塞个随机值，稳定性直接没了。
 *   - anthropic-version / anthropic-beta 是协议常量，客户端给不给都能补成规范值。
 *
 * 所以这三个头在任何模式下都注入（只补缺失项，客户端自己给了就用它的）。
 * 真正要「拒绝」的是看起来不像 Claude Code 的身份头，那由 guardRequire 管。
 */
export function injectFingerprintHeaders(
  headers: Record<string, string | string[] | undefined>,
  cfg: Config,
  seed?: string
): Record<string, string | string[] | undefined> {
  const lh = lowerHeaders(headers);
  const out: Record<string, string | string[] | undefined> = { ...headers };
  if (!lh["anthropic-version"]) out["anthropic-version"] = ANTHROPIC_VERSION;
  if (!lh["anthropic-beta"]) out["anthropic-beta"] = CC_BETA;
  if (!lh["x-claude-code-session-id"]) out["x-claude-code-session-id"] = uuidFrom(seed || cfg.secret);
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
  const seed = fingerprintSeed(auth);

  /* 只读元数据端点：不守卫，缺头就自己补全成 Claude Code 的样子 */
  if (isGuardExempt(req.method ?? "GET", req.url ?? "")) {
    log?.debug("header guard skipped (metadata endpoint): " + String(req.url));
    return { ok: true, headers: injectCanonicalHeaders(req.headers, cfg, seed), missing: [] };
  }

  const enforce = auth.useClaudeFingerprint !== false;

  if (!enforce) {
    const headers = injectCanonicalHeaders(req.headers, cfg, seed);
    return { ok: true, headers, missing: [] };
  }

  if (cfg.guardMode === "off") return { ok: true, headers: req.headers, missing: [] };

  /* 指纹头无条件补：它们是网关的职责，不该让客户端操心 */
  const withFp = injectFingerprintHeaders(req.headers, cfg, seed);
  /* 身份头（user-agent / x-app）只在开了 injectMissing 时才补 —— 否则就等于放宽了守卫 */
  const headers = cfg.injectMissing ? injectCanonicalHeaders(withFp, cfg, seed) : withFp;

  const r = checkClaudeCodeHeaders(headers as Record<string, unknown>, cfg);
  if (r.ok) return { ok: true, headers, missing: [] };

  if (cfg.guardMode === "lenient") {
    log?.warn("header guard (lenient) missing: " + r.missing.join(", "));
    return { ok: true, headers, missing: r.missing };
  }
  return { ok: false, headers, missing: r.missing };
}
