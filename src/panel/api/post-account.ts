import { sendJson } from "../../http/respond.ts";
import { clampInt } from "../../utils.ts";
import { fetchOauthProfile, profileLabel } from "../../pool/profile.ts";
import { startOAuth, finishOAuth } from "../../oauth-flow.ts";
import type { Account, UsageSnapshot } from "../../types.ts";
import type { IncomingMessage, ServerResponse } from "node:http";
import { asBool, publicAccount, str } from "./views.ts";
import type { PanelDeps } from "./types.ts";

/** account.* 与 oauth.* 的 POST 动作。处理了返回 true，没处理返回 false */
export async function postAccount(
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

    case "account.create": {
      const kind = str(body.kind, "apikey") === "oauth" ? "oauth" : "apikey";
      const secret = str(body.secret).trim();
      if (!secret) {
        sendJson(res, 400, { error: { message: "secret 不能为空", code: "invalid_input" } });
        return true;
      }
      const label = str(body.label).trim() || (kind === "apikey" ? "Console Key" : "OAuth 账号");
      const acc = accounts.create(
        kind === "apikey"
          ? { label, kind, apiKey: secret }
          : { label, kind, refreshToken: secret, clientId: cfg.oauthClientId }
      );
      deps.ctx.log.info("panel: account created " + acc.id + " kind=" + kind);
      sendJson(res, 200, { ok: true, data: publicAccount(acc) });
      return true;
    }

    /*
     * 刷新账号信息：拉档案（真名 / 邮箱 / 套餐）+ 查一次额度。
     * 跟「查用量」的区别是这里**强制**拉档案 —— 老号的备注名是建号时瞎填的默认值，
     * 那些值不一定长得像占位符，靠 refreshUsage 里的启发式补不全，得手动刷一次。
     */
    case "account.refresh": {
      const one = str(body.id).trim();
      const all = accounts.list();
      const targets = one ? all.filter((x) => x.id === one) : all;
      if (one && !targets.length) {
        sendJson(res, 404, { error: { message: "账号不存在", code: "not_found" } });
        return true;
      }
      const out: Array<Record<string, unknown>> = [];
      for (const acc of targets) {
        let name: string | null = null;
        let email: string | null = null;
        let plan: string | null = null;
        let profileError: string | null = null;
        if (acc.kind === "oauth") {
          if (!acc.accessToken) {
            profileError = "这个号还没有 access_token（先去查一次用量让它刷新）";
          } else {
            const prof = await fetchOauthProfile(cfg, acc.accessToken, 10000);
            if (!prof) {
              profileError = "档案接口没返回可用数据";
            } else {
              name = profileLabel(prof);
              email = prof.email;
              plan = prof.planDisplayName ?? prof.subscriptionType;
              const patch: Record<string, unknown> = {};
              if (name) patch.label = name;
              if (email) patch.email = email;
              if (Object.keys(patch).length) accounts.update(acc.id, patch as never);
            }
          }
        } else {
          profileError = "Console Key 没有档案接口，只能查额度";
        }
        const fresh = accounts.get(acc.id) ?? acc;
        let usageOk: boolean | null = null;
        let usageError: string | null = null;
        try {
          const r = await deps.refreshUsage(fresh, 15000);
          usageOk = r.snap.ok;
          usageError = r.snap.ok ? null : (r.snap.error ?? "查询失败");
        } catch (e) {
          usageError = e instanceof Error ? e.message : String(e);
        }
        const after = accounts.get(acc.id) ?? fresh;
        out.push({
          id: acc.id,
          before: acc.label,
          label: after.label,
          email: after.email,
          plan: after.usage?.subscriptionType ?? plan,
          profileError,
          usageOk,
          usageError
        });
      }
      deps.ctx.log.info("panel: 刷新账号信息 " + out.length + " 个");
      sendJson(res, 200, { ok: true, data: { refreshed: out.length, results: out } });
      return true;
    }

    case "account.batch": {
      const kind = str(body.kind, "apikey") === "oauth" ? "oauth" : "apikey";
      const raw = str(body.lines);
      const lines = raw
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter((s) => s && !s.startsWith("#"));
      let created = 0;
      const errors: string[] = [];
      for (const line of lines) {
        const parts = line.split("|").map((s) => s.trim());
        const label = parts.length > 1 ? parts[0] : "";
        const secret = parts.length > 1 ? parts[1] : parts[0];
        if (!secret) continue;
        try {
          accounts.create(
            kind === "apikey"
              ? { label: label || "Console Key", kind, apiKey: secret }
              : { label: label || "OAuth 账号", kind, refreshToken: secret, clientId: cfg.oauthClientId }
          );
          created += 1;
        } catch (e) {
          errors.push(secret.slice(0, 10) + "...: " + (e instanceof Error ? e.message : String(e)));
        }
      }
      deps.ctx.log.info("panel: batch import created=" + created + " failed=" + errors.length);
      sendJson(res, 200, { ok: true, data: { created, failed: errors.length, errors: errors.slice(0, 20) } });
      return true;
    }

    case "account.update": {
      const id = str(body.id);
      const patch: Record<string, unknown> = {};
      if (body.label !== undefined) patch.label = str(body.label);
      if (body.weight !== undefined) patch.weight = clampInt(body.weight, 1, 1, 10);
      if (body.status !== undefined) {
        const s = str(body.status);
        if (s === "active" || s === "disabled" || s === "error") patch.status = s;
      }
      const next = accounts.update(id, patch as never);
      /* 手动启用要把「额度耗尽」的封印一并解除 */
      if (body.status === "active") accounts.clearExhausted(id);
      if (!next) {
        sendJson(res, 404, { error: { message: "账号不存在", code: "not_found" } });
        return true;
      }
      sendJson(res, 200, { ok: true, data: publicAccount(next) });
      return true;
    }

    case "account.delete": {
      const id = str(body.id);
      const ok = accounts.remove(id);
      deps.ctx.log.info("panel: account deleted " + id);
      sendJson(res, ok ? 200 : 404, ok ? { ok: true } : { error: { message: "账号不存在", code: "not_found" } });
      return true;
    }

    case "account.revive": {
      const id = str(body.id);
      const all = asBool(body.all);
      if (all) {
        const list = accounts.list().filter((a) => a.status === "exhausted");
        for (const a of list) accounts.clearExhausted(a.id);
        deps.ctx.log.info("panel: revived " + list.length + " exhausted account(s)");
        sendJson(res, 200, { ok: true, data: { revived: list.length } });
        return true;
      }
      const before = accounts.get(id);
      if (!before) {
        sendJson(res, 404, { error: { message: "账号不存在", code: "not_found" } });
        return true;
      }
      accounts.clearExhausted(id);
      deps.ctx.log.info("panel: revived exhausted account " + id);
      sendJson(res, 200, { ok: true, data: { revived: 1 } });
      return true;
    }

    case "account.usage": {
      const all = asBool(body.all);
      const id = str(body.id);
      const targets: Account[] = all ? accounts.list() : accounts.list().filter((a) => a.id === id);
      if (!targets.length) {
        sendJson(res, 404, { error: { message: "账号不存在", code: "not_found" } });
        return true;
      }
      const results: Array<Record<string, unknown>> = [];
      for (const acc of targets) {
        const { snap, sealedUntil } = await deps.refreshUsage(acc);
        results.push({ id: acc.id, label: acc.label, sealedUntil, ...snap });
      }
      deps.ctx.log.info("panel: usage queried for " + results.length + " account(s)");
      sendJson(res, 200, { ok: true, data: results });
      return true;
    }

    case "account.reset": {
      const id = str(body.id);
      const all = asBool(body.all);
      if (all) {
        accounts.clearCooldowns();
        sendJson(res, 200, { ok: true, data: { cleared: "all" } });
        return true;
      }
      accounts.markOk(id);
      sendJson(res, 200, { ok: true, data: { cleared: id } });
      return true;
    }

    default:
      return false;
  }
}
