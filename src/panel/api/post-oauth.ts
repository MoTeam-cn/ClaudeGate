import { sendJson } from "../../http/respond.ts";
import { startOAuth, finishOAuth, reloginOAuth } from "../../oauth-flow.ts";
import type { UsageSnapshot } from "../../types.ts";
import type { IncomingMessage, ServerResponse } from "node:http";
import { publicAccount, str } from "./views.ts";
import type { PanelDeps } from "./types.ts";

/**
 * oauth.* 的 POST 动作。处理了返回 true，没处理返回 false。
 *
 * 从 post-account.ts 拆出来的：账号那半边是号池增删改查，这半边是授权与重新授权，
 * 两块共用同一个 PanelDeps 但没有互相调用，分开之后各自都好读。
 */
export async function postOauth(
  deps: PanelDeps,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  action: string,
  body: Record<string, unknown>
): Promise<boolean> {
  const { cfg, accounts } = deps.ctx;

  switch (action) {
    /* 授权登录第一步：生成 PKCE、记下 pending、把链接给前端让用户去登录。
       面板固定走 manual 回调（platform.claude.com/oauth/code/callback），
       因为面板可能在内网、浏览器与网关不在一台机器上，localhost 回调够不着。 */
    case "oauth.start": {
      const started = startOAuth(deps.ctx, { redirectUri: cfg.oauthManualRedirect, mode: "manual" });
      deps.ctx.log.info("panel: oauth start state=" + started.state.slice(0, 8));
      sendJson(res, 200, { ok: true, data: { state: started.state, authorizeUrl: started.authorizeUrl, redirectUri: started.redirectUri, mode: started.mode } });
      return true;
    }

    /* 授权登录第二步：拿回调码换令牌并建号。授权页给的是 code 或 code#state，两种都认 */
    case "oauth.finish": {
      const state = str(body.state).trim();
      const code = str(body.code).trim();
      if (!state || !code) {
        sendJson(res, 400, { error: { message: "缺少 state 或授权码", code: "invalid_input" } });
        return true;
      }
      try {
        const done = await finishOAuth(deps.ctx, state, code);
        deps.ctx.log.info("panel: oauth finish account=" + done.account.id + " email=" + String(done.email ?? "-"));

        /* 建完号顺手查一次额度，省得再手点「查用量」。
           订阅号才有这个接口；超时压到 8 秒，别把面板拖住。
           账号此时已经建好了，这里失败也不影响它 */
        let usage: UsageSnapshot | null = null;
        if (done.account.kind === "oauth") {
          const r = await deps.refreshUsage(done.account, 8000);
          usage = r.snap;
          deps.ctx.log.info("panel: oauth usage for " + done.account.id + " ok=" + r.snap.ok + (r.snap.ok ? "" : " err=" + String(r.snap.error ?? "")));
        }
        /* 把档案一并带回去：面板可以顺手显示套餐档位，不用再单开一个接口 */
        sendJson(res, 200, {
          ok: true,
          data: { ...publicAccount(done.account), usage, displayName: done.displayName, profile: done.profile }
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        deps.ctx.log.warn("panel: oauth finish failed: " + msg);
        sendJson(res, 400, { error: { message: msg, code: "oauth_failed" } });
      }
      return true;
    }

    /*
     * 重新授权第一步：给已有账号生成一条授权链接。
     * 生成的 pending 里记着目标账号 id，第二步据此把令牌**写回同一个号**。
     * 用途是 refresh_token 失效（上游回 invalid_grant）时原地救回来 ——
     * 比「删号 + 重新添加」强的地方在于 deviceId 这类指纹绑定不会跟着丢。
     */
    case "oauth.relogin.start": {
      const id = str(body.id).trim();
      if (!id) {
        sendJson(res, 400, { error: { message: "缺少账号 id", code: "invalid_input" } });
        return true;
      }
      const acc = accounts.get(id);
      if (!acc) {
        sendJson(res, 404, { error: { message: "账号不存在", code: "not_found" } });
        return true;
      }
      if (acc.kind !== "oauth") {
        sendJson(res, 400, { error: { message: "Console Key 账号没有可重新授权的令牌，直接改 Key 即可", code: "invalid_kind" } });
        return true;
      }
      const started = startOAuth(deps.ctx, {
        redirectUri: cfg.oauthManualRedirect,
        mode: "manual",
        accountId: id
      });
      deps.ctx.log.info("panel: oauth relogin start account=" + id + " state=" + started.state.slice(0, 8));
      sendJson(res, 200, {
        ok: true,
        data: {
          state: started.state,
          authorizeUrl: started.authorizeUrl,
          redirectUri: started.redirectUri,
          mode: started.mode,
          label: acc.label,
          email: acc.email
        }
      });
      return true;
    }

    /* 重新授权第二步：换令牌并覆盖到已有账号上。授权页给的是 code 或 code#state，两种都认 */
    case "oauth.relogin.finish": {
      const state = str(body.state).trim();
      const code = str(body.code).trim();
      if (!state || !code) {
        sendJson(res, 400, { error: { message: "缺少 state 或授权码", code: "invalid_input" } });
        return true;
      }
      try {
        const done = await reloginOAuth(deps.ctx, state, code);

        /* 新令牌下旧额度状态没意义，顺手查一次，和 oauth.finish 保持一致 */
        let usage: UsageSnapshot | null = null;
        if (done.account.kind === "oauth") {
          const r = await deps.refreshUsage(done.account, 8000);
          usage = r.snap;
        }
        sendJson(res, 200, {
          ok: true,
          data: {
            ...publicAccount(done.account),
            usage,
            displayName: done.displayName,
            profile: done.profile,
            previousEmail: done.previousEmail,
            /* 授权到的是另一个号 —— 前端要提醒用户，不然会以为还是原来那个 */
            switched: done.previousEmail !== done.email
          }
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        deps.ctx.log.warn("panel: oauth relogin failed: " + msg);
        sendJson(res, 400, { error: { message: msg, code: "relogin_failed" } });
      }
      return true;
    }

    default:
      return false;
  }
}
