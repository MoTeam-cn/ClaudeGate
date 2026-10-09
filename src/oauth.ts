import { OAUTH_BETA, ANTHROPIC_VERSION, CC_UA, PROD } from "./constants.ts";
import { nowSec, toStr } from "./utils.ts";
import { requestRaw, requestJson } from "./net/request.ts";
import type { Account, Config, Credential, TokenResponse } from "./types.ts";

export interface AuthorizeOptions {
  redirectUri: string;
  codeChallenge: string;
  state: string;
}

export interface ExchangeOptions {
  code: string;
  state: string;
  codeVerifier: string;
  redirectUri: string;
}

export function buildAuthorizeUrl(cfg: Config, opts: AuthorizeOptions): string {
  const u = new URL(cfg.oauthAuthorizeUrl);
  u.searchParams.append("code", "true");
  u.searchParams.append("client_id", cfg.oauthClientId);
  u.searchParams.append("response_type", "code");
  u.searchParams.append("redirect_uri", opts.redirectUri);
  u.searchParams.append("scope", cfg.oauthScopes.join(" "));
  u.searchParams.append("code_challenge", opts.codeChallenge);
  u.searchParams.append("code_challenge_method", "S256");
  u.searchParams.append("state", opts.state);
  return u.toString();
}

interface JsonResult {
  status: number;
  ok: boolean;
  data: Record<string, unknown> | null;
  text: string;
}

async function postJson(
  cfg: Config,
  url: string,
  body: Record<string, unknown>,
  headers?: Record<string, string>
): Promise<JsonResult> {
  /* 走 requestRaw 而不是 fetch：fetch 用 undici，不认我们的 Agent，也就绕过了代理 */
  const res = await requestRaw(url, {
    cfg,
    method: "POST",
    headers: { "content-type": "application/json", ...(headers ?? {}) },
    body: JSON.stringify(body),
    timeoutMs: 30000
  });
  let data: Record<string, unknown> | null = null;
  try {
    data = JSON.parse(res.text) as Record<string, unknown>;
  } catch {
    data = null;
  }
  return { status: res.status, ok: res.ok, data, text: res.text };
}

/**
 * 把令牌端点的失败讲清楚。
 * 403 forbidden / "Request not allowed" 不是授权码的问题 —— 实测把请求换成
 * GET、空 body、form 编码、完整浏览器头、甚至真 Claude Code 逐字的头，一律 403。
 * 这是出口 IP 在 Cloudflare 那边被判了，继续重试只会让封锁范围变大。
 */
function tokenError(action: string, status: number, text: string): string {
  const body = text.slice(0, 300);
  if (status === 403) {
    return action + "失败：HTTP 403 " + body + "\n" +
      "这是出口 IP 被挡了，不是授权码的问题。请求形态已被排除：换 GET、空 body、" +
      "浏览器头、Claude Code 逐字的头都是同样的 403。\n" +
      "不要再重试 —— 实测重复请求会让封锁从单个路径扩大到整个 /oauth/*。\n" +
      "要查就换成被信任的出口（浏览器能打开 claude.ai 的那条路径），或改用" +
      "「粘贴 refresh_token」的方式加号。";
  }
  return action + "失败：HTTP " + status + " " + body;
}

export async function exchangeCode(cfg: Config, opts: ExchangeOptions): Promise<TokenResponse> {
  const body: Record<string, unknown> = {
    grant_type: "authorization_code",
    code: opts.code,
    redirect_uri: opts.redirectUri,
    client_id: cfg.oauthClientId,
    code_verifier: opts.codeVerifier,
    state: opts.state
  };
  /* 头跟真 Claude Code 逐字一致：只发 Content-Type，不额外加 UA。
     对照过二进制里那句 Et.post(TOKEN_URL, E, {headers:{"Content-Type":"application/json"}}) */
  const r = await postJson(cfg, cfg.oauthTokenUrl, body);
  if (!r.ok || !r.data || typeof r.data.access_token !== "string") {
    throw new Error(tokenError("兑换授权码", r.status, r.text));
  }
  return r.data as unknown as TokenResponse;
}

export async function refreshUpstream(cfg: Config, cred: Credential): Promise<TokenResponse> {
  const scope = String(cred.scope ?? cfg.oauthScopes.join(" "))
    .split(/[ ,]+/)
    .filter(Boolean)
    .join(" ");
  const body: Record<string, unknown> = {
    grant_type: "refresh_token",
    refresh_token: cred.refresh_token ?? "",
    client_id: cred.client_id ?? cfg.oauthClientId,
    scope
  };
  const r = await postJson(cfg, cfg.oauthTokenUrl, body);
  if (!r.ok || !r.data || typeof r.data.access_token !== "string") {
    throw new Error(tokenError("刷新令牌", r.status, r.text));
  }
  return r.data as unknown as TokenResponse;
}

export async function fetchProfile(cfg: Config, accessToken: string): Promise<unknown | null> {
  try {
    const res = await requestRaw(cfg.oauthRolesUrl, {
      cfg,
      headers: {
        authorization: "Bearer " + accessToken,
        "anthropic-version": ANTHROPIC_VERSION,
        "user-agent": CC_UA
      },
      timeoutMs: 20000
    });
    if (!res.ok) return null;
    return JSON.parse(res.text) as unknown;
  } catch {
    return null;
  }
}

/** Console 模式：把 OAuth 令牌兑换成 API Key */
export async function createApiKey(cfg: Config, accessToken: string): Promise<string | null> {
  try {
    const res = await requestJson<Record<string, unknown>>(cfg.apiKeyUrl, {
      cfg,
      method: "POST",
      headers: {
        authorization: "Bearer " + accessToken,
        "anthropic-version": ANTHROPIC_VERSION,
        "content-type": "application/json",
        "user-agent": CC_UA
      },
      body: JSON.stringify({ name: "claude-gateway" }),
      timeoutMs: 20000
    });
    if (!res.ok || !res.data) return null;
    const key = res.data.raw_key ?? res.data.api_key ?? res.data.key;
    return typeof key === "string" && key ? key : null;
  } catch {
    return null;
  }
}

export function credentialFromToken(cfg: Config, tok: TokenResponse): Credential {
  const scopes = String(tok.scope ?? "").split(/[ ,]+/).filter(Boolean);
  return {
    kind: "oauth",
    access_token: tok.access_token,
    refresh_token: tok.refresh_token ?? null,
    expires_at: nowSec() + (Number(tok.expires_in) || 3600),
    scope: scopes.join(" "),
    client_id: cfg.oauthClientId,
    mode: cfg.oauthMode,
    created_at: new Date().toISOString()
  };
}

/** 上游认证头：Console API Key 用 x-api-key；订阅 OAuth 用 Bearer + oauth beta */
/**
 * anthropic-beta 是逗号分隔的能力集合，只能求并集。
 * 覆盖掉 Claude Code 自己带的 claude-code-20250219 / interleaved-thinking / tool-search-tool
 * 会让请求既不像 Claude Code，又会因为请求体里的 thinking 与 tool search 缺声明而被上游拒。
 */
export function mergeBeta(existing: string | string[] | undefined, add: string): string {
  const seen = new Set<string>();
  const out: string[] = [];
  const push = (raw: string): void => {
    for (const part of raw.split(",")) {
      const v = part.trim();
      if (!v || seen.has(v)) continue;
      seen.add(v);
      out.push(v);
    }
  };
  if (Array.isArray(existing)) {
    for (const e of existing) push(String(e));
  } else if (existing) {
    push(String(existing));
  }
  push(add);
  return out.join(",");
}

export function upstreamAuthHeaders(account: Account | null): Record<string, string> {
  if (account && account.kind === "apikey") {
    return { "x-api-key": toStr(account.apiKey), "anthropic-version": ANTHROPIC_VERSION };
  }
  return {
    authorization: "Bearer " + toStr(account?.accessToken),
    "anthropic-version": ANTHROPIC_VERSION,
    "anthropic-beta": OAUTH_BETA
  };
}

export function manualRedirectDefault(): string {
  return PROD.MANUAL_REDIRECT_URL;
}
