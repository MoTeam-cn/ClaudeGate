import crypto from "node:crypto";

import { buildAuthorizeUrl, exchangeCode, fetchProfile, credentialFromToken, createApiKey } from "./oauth.ts";
import { b64url, randHex } from "./utils.ts";
import type { Account, GatewayContext } from "./types.ts";

/**
 * OAuth 授权的两段式流程，从 routes/auth.ts 抽出来，让 HTML 流程与面板 JSON 接口共用同一份逻辑。
 *
 * 分两段是因为浏览器要跳出去登录：
 *   startOAuth()  —— 生成 PKCE、记下 pending、返回要用户去打开的授权链接
 *   finishOAuth() —— 拿回调码换令牌、建号
 *
 * 面板走的是 manual 模式（redirect_uri = platform.claude.com/oauth/code/callback），
 * 因为面板可能在内网、浏览器与网关不在一台机器上，localhost 回调够不着。
 */

export interface StartedOAuth {
  state: string;
  authorizeUrl: string;
  redirectUri: string;
  mode: "auto" | "manual";
}

export function startOAuth(
  ctx: GatewayContext,
  opts: { redirectUri: string; mode: "auto" | "manual" }
): StartedOAuth {
  const state = randHex(16);
  const codeVerifier = b64url(crypto.randomBytes(32));
  const codeChallenge = b64url(crypto.createHash("sha256").update(codeVerifier).digest());

  ctx.store.putPending(state, {
    codeVerifier,
    redirectUri: opts.redirectUri,
    createdAt: Date.now(),
    mode: opts.mode
  });

  return {
    state,
    authorizeUrl: buildAuthorizeUrl(ctx.cfg, { redirectUri: opts.redirectUri, codeChallenge, state }),
    redirectUri: opts.redirectUri,
    mode: opts.mode
  };
}

export interface FinishedOAuth {
  account: Account;
  email: string | null;
  scope: string | null;
  apiKey: string | null;
}

/** 从 profile 里尽量挖出邮箱，挖不到就返回 null */
export function emailFromProfile(prof: unknown): string | null {
  if (!prof || typeof prof !== "object") return null;
  const o = prof as Record<string, unknown>;
  for (const k of ["email", "email_address", "account_email"]) {
    const v = o[k];
    if (typeof v === "string" && v.includes("@")) return v;
  }
  for (const k of ["account", "organization", "user"]) {
    const nested = emailFromProfile(o[k]);
    if (nested) return nested;
  }
  return null;
}

/**
 * 用回调码完成授权。授权页给的是 code 或 code#state，两种都认。
 * 失败一律抛错，由调用方决定是渲染 HTML 还是回 JSON。
 */
export async function finishOAuth(
  ctx: GatewayContext,
  rawState: string,
  rawCode: string
): Promise<FinishedOAuth> {
  const state = String(rawState ?? "").trim();
  const pend = ctx.store.takePending(state);
  if (!pend) throw new Error("授权会话已过期，请重新获取授权链接");

  let code = String(rawCode ?? "").trim();
  let inlineState: string | null = null;
  const hashAt = code.indexOf("#");
  if (hashAt !== -1) {
    inlineState = code.slice(hashAt + 1).trim();
    code = code.slice(0, hashAt).trim();
  }
  if (!code) throw new Error("授权码为空");
  if (inlineState && inlineState !== state) throw new Error("state 不匹配，授权码与本次会话对不上");

  const tok = await exchangeCode(ctx.cfg, {
    code,
    state,
    codeVerifier: pend.codeVerifier,
    redirectUri: pend.redirectUri
  });

  const cred = credentialFromToken(ctx.cfg, tok);
  const prof = await fetchProfile(ctx.cfg, tok.access_token);
  const email = emailFromProfile(prof);

  /* 只有 Console 模式才把 OAuth 令牌换成 API Key；订阅模式保留 OAuth 令牌，
     这样才能用 OAuth 的用量接口查订阅额度 */
  let apiKey: string | null = null;
  if (ctx.cfg.oauthMode === "console") {
    apiKey = await createApiKey(ctx.cfg, tok.access_token);
    /* console 模式的唯一目的是拿 API Key。拿不到就报错，绝不能悄悄降级成订阅号 ——
       那样用户以为手里是 Console Key，实际是另一种东西，账单与额度都对不上。 */
    if (!apiKey) {
      throw new Error(
        "Console 模式需要把 OAuth 令牌兑换成 API Key，但兑换失败（上游没返回 key）。" +
          "检查网络与出站代理，或改用 OAUTH_MODE=claude_ai 建订阅账号。"
      );
    }
  }

  const account = ctx.accounts.create({
    label: email ?? ("账号 " + (ctx.accounts.list().length + 1)),
    kind: apiKey ? "apikey" : "oauth",
    accessToken: cred.access_token ?? null,
    refreshToken: cred.refresh_token ?? null,
    apiKey,
    expiresAt: cred.expires_at ?? null,
    scope: cred.scope ?? null,
    clientId: cred.client_id ?? null,
    mode: cred.mode ?? null,
    email
  });

  return { account, email, scope: cred.scope ?? null, apiKey };
}
