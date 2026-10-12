import type { Account, GatewayContext } from "../../types.ts";
import { fetchOauthUsage } from "../../pool/usage.ts";
import { fetchOauthProfile, profileLabel } from "../../pool/profile.ts";
import type { UsageRefresh } from "./types.ts";

/** 名字还是系统给的占位符？（这种才值得去上游补真名） */
export function isPlaceholderLabel(label: string): boolean {
  const t = label.trim();
  return (
    /^账号\s*\d+$/.test(t) ||
    t === "OAuth 账号" ||
    t === "Console Key" ||
    t === "从 credential.json 迁移" ||
    /^[0-9a-f]{8}$/.test(t)
  );
}

/**
 * 查一次额度并落库；用量接口明说窗口 rejected 就封印到重置时刻。
 * account.usage 与 oauth.finish（加号后自动查）共用这一份，别让封印逻辑长成两套。
 *
 * 做成工厂是因为它要被 PanelDeps 传出去 —— 处理器从闭包里搬走后拿不到 ctx 了。
 */
export function createRefreshUsage(ctx: GatewayContext) {
  const { cfg, accounts } = ctx;

  return async function refreshUsage(acc: Account, timeoutMs = 15000): Promise<UsageRefresh> {
    const snap = await fetchOauthUsage(cfg, acc, timeoutMs);
    accounts.saveUsage(acc.id, snap);

    /* 名字还是占位的话顺手把档案拉回来。
       粘贴 refresh_token 建的号在创建时没有 access_token，只有走到这里才拿得到真名 */
    if (acc.kind === "oauth" && acc.accessToken && isPlaceholderLabel(acc.label)) {
      const prof = await fetchOauthProfile(cfg, acc.accessToken, 8000);
      const name = prof ? profileLabel(prof) : null;
      if (name) {
        const patch: Record<string, unknown> = { label: name };
        if (prof && prof.email && !acc.email) patch.email = prof.email;
        accounts.update(acc.id, patch as never);
        ctx.log.info("panel: 账号 " + acc.id + " 名称补全为 " + name);
      }
    }

    let sealed: number | null = null;
    if (snap.ok) {
      for (const w of Object.values(snap.windows)) {
        if (w.status !== "rejected") continue;
        const nowSec = Math.floor(Date.now() / 1000);
        const at = w.resetsAt && w.resetsAt > nowSec ? w.resetsAt : nowSec + 5 * 3600;
        sealed = sealed === null ? at : Math.min(sealed, at);
      }
      if (sealed !== null) {
        const capped = Math.min(sealed, Math.floor(Date.now() / 1000) + 6 * 3600);
        accounts.markExhausted(acc.id, "用量接口显示窗口已 rejected", capped);
      }
    }
    return { snap, sealedUntil: sealed };
  };
}
