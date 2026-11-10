import crypto from "node:crypto";

import { buildAuthorizeUrl, exchangeCode, credentialFromToken, createApiKey } from "./oauth.ts";
import { fetchOauthProfile, profileLabel } from "./pool/profile.ts";
import { b64url, randHex } from "./utils.ts";
import type { Account, GatewayContext } from "./types.ts";

/**
 * OAuth 授权的两段式流程，从 routes/auth.ts 抽出来，让 HTML 流程与面板 JSON 接口共用同一份逻辑。
 *
 * 分两段是因为浏览器要跳出去登录：
 *   startOAuth()  —— 生成 PKCE、记下 pending、返回要用户去打开的授权链接
 *   finishOAuth() —— 拿回调码换令牌、建号
 *   reloginOAuth()—— 同一套换码逻辑，但把结果**写回已有账号**
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
  opts: { redirectUri: string; mode: "auto" | "manual"; accountId?: string }
): StartedOAuth {
  const state = randHex(16);
  const codeVerifier = b64url(crypto.randomBytes(32));
  const codeChallenge = b64url(crypto.createHash("sha256").update(codeVerifier).digest());

  ctx.store.putPending(state, {
    codeVerifier,
    redirectUri: opts.redirectUri,
    createdAt: Date.now(),
    mode: opts.mode,
    accountId: opts.accountId
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
  /** 档案里拿到的展示名，没有就是 null */
  displayName: string | null;
  /** 原始档案，给面板显示订阅档位用 */
  profile: unknown;
  scope: string | null;
  apiKey: string | null;
}

/** 换码之后拿到的全部东西，建号与重新授权共用 */
interface RedeemedCode {
  /** pending 里记下的目标账号；添加新号时是 undefined */
  accountId: string | undefined;
  accessToken: string | null;
  refreshToken: string | null;
  expiresAt: number | null;
  scope: string | null;
  clientId: string | null;
  mode: string | null;
  apiKey: string | null;
  email: string | null;
  displayName: string | null;
  profile: unknown;
}

/**
 * 用回调码换令牌 + 查档案 +（Console 模式）兑换 API Key。
 * 建号与重新授权两边的差别只在最后写库那一步，前面这一段完全一样。
 * 失败一律抛错，由调用方决定是渲染 HTML 还是回 JSON。
 */
async function redeemCode(ctx: GatewayContext, rawState: string, rawCode: string): Promise<RedeemedCode> {
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
  /* 查档案拿真名字。/api/oauth/profile 是订阅号才有的接口，Console 模式查不到就退回占位名 */
  const prof = await fetchOauthProfile(ctx.cfg, tok.access_token);
  const email = prof?.email ?? null;
  const displayName = prof ? profileLabel(prof) : null;

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

  return {
    accountId: pend.accountId,
    accessToken: cred.access_token ?? null,
    refreshToken: cred.refresh_token ?? null,
    expiresAt: cred.expires_at ?? null,
    scope: cred.scope ?? null,
    clientId: cred.client_id ?? null,
    mode: cred.mode ?? null,
    apiKey,
    email,
    displayName,
    profile: prof
  };
}

/**
 * 用回调码完成授权并**建号**。
 */
export async function finishOAuth(
  ctx: GatewayContext,
  rawState: string,
  rawCode: string
): Promise<FinishedOAuth> {
  const r = await redeemCode(ctx, rawState, rawCode);

  const account = ctx.accounts.create({
    label: r.displayName ?? r.email ?? ("账号 " + (ctx.accounts.list().length + 1)),
    kind: r.apiKey ? "apikey" : "oauth",
    accessToken: r.accessToken,
    refreshToken: r.refreshToken,
    apiKey: r.apiKey,
    expiresAt: r.expiresAt,
    scope: r.scope,
    clientId: r.clientId,
    mode: r.mode,
    email: r.email
  });

  return {
    account,
    email: r.email,
    displayName: r.displayName,
    profile: r.profile,
    scope: r.scope,
    apiKey: r.apiKey
  };
}

export interface ReloggedOAuth {
  account: Account;
  email: string | null;
  displayName: string | null;
  profile: unknown;
  scope: string | null;
  apiKey: string | null;
  /** 覆盖前用的邮箱，用来让面板提示「换成了另一个号」 */
  previousEmail: string | null;
}

/**
 * 重新授权：同一套换码逻辑，但把结果**写回已有账号**，不新建。
 *
 * 这个入口存在的原因是 refresh_token 会轮换、会失效 —— 一旦上游回 invalid_grant，
 * 那个号就再也刷不出来了，唯一的出路是重新走一次授权。以前只能「删号 + 重新添加」，
 * 号一删，deviceId 之类的指纹绑定也跟着没了；这里原地覆盖，指纹保持不变。
 *
 * 刻意**不动 label**：那是用户自己起的名字，重新授权不该把它冲掉。
 * 但 email 会更新（那是事实），并且把 error / 冷却 / 耗尽状态全部清掉 ——
 * 旧令牌下观察到的额度状态对新令牌没有意义。
 */
export async function reloginOAuth(
  ctx: GatewayContext,
  rawState: string,
  rawCode: string
): Promise<ReloggedOAuth> {
  const r = await redeemCode(ctx, rawState, rawCode);
  if (!r.accountId) throw new Error("这次授权不是针对已有账号的，请用「添加账号」");

  const before = ctx.accounts.get(r.accountId);
  if (!before) throw new Error("要重新授权的账号已经不在了（可能已被删除），请用「添加账号」重新建");

  const account = ctx.accounts.update(r.accountId, {
    kind: r.apiKey ? "apikey" : "oauth",
    accessToken: r.accessToken,
    refreshToken: r.refreshToken,
    apiKey: r.apiKey,
    expiresAt: r.expiresAt,
    scope: r.scope,
    clientId: r.clientId,
    mode: r.mode,
    email: r.email ?? before.email
  });
  if (!account) throw new Error("写回账号失败");

  /* 一把清干净：status 回到 active，清 exhausted / error_count / last_error */
  ctx.accounts.clearExhausted(r.accountId);

  ctx.log.info("account re-authorized", {
    account: r.accountId,
    email: r.email,
    replaced: before.email !== r.email
  });

  return {
    account: ctx.accounts.get(r.accountId) ?? account,
    email: r.email,
    displayName: r.displayName,
    profile: r.profile,
    scope: r.scope,
    apiKey: r.apiKey,
    previousEmail: before.email
  };
}
