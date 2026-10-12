import { ANTHROPIC_VERSION, CC_UA, OAUTH_BETA, USAGE_PATH, USAGE_PATH_ALT } from "../../constants.ts";
import { requestRaw } from "../../net/request.ts";
import { normalizeOauthUsage } from "./parse.ts";
import type { Account, Config, UsageSnapshot } from "../../types.ts";

/** 真正去上游拉一次用量（订阅号才有这个接口） */

export async function fetchOauthUsage(cfg: Config, account: Account, timeoutMs = 15000): Promise<UsageSnapshot> {
  const base = cfg.upstreamBase.replace(/\/+$/, "");
  const fail = (msg: string, raw?: string): UsageSnapshot => ({
    ok: false,
    source: "oauth",
    windows: {},
    error: msg,
    ...(raw ? { raw: raw.slice(0, 4000) } : {}),
    fetchedAt: Date.now()
  });

  if (account.kind !== "oauth") return fail("只有订阅 OAuth 账号才有用量接口");
  if (!account.accessToken) return fail("账号没有 access_token");

  /** 打一次用量接口，把原文与解析结果一起交出来 */
  async function fetchOnce(path: string): Promise<{ text: string; snap: UsageSnapshot | null; err: string | null }> {
    const res = await requestRaw(base + path, {
      cfg,
      method: "GET",
      headers: {
        authorization: "Bearer " + account.accessToken,
        "anthropic-version": ANTHROPIC_VERSION,
        "anthropic-beta": OAUTH_BETA,
        "user-agent": CC_UA,
        accept: "application/json"
      },
      timeoutMs
    });
    const text = res.text;
    if (!res.ok) return { text, snap: null, err: "HTTP " + res.status + " " + text.slice(0, 200) };
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return { text, snap: null, err: "响应不是合法 JSON：" + text.slice(0, 120) };
    }
    return { text, snap: normalizeOauthUsage(parsed), err: null };
  }

  /** 一行百分比都没解析出来 —— 说明拿到的形状不对，值得换一套参数再试 */
  function noNumbers(snap: UsageSnapshot): boolean {
    const ws = Object.values(snap.windows);
    if (!ws.length) return true;
    return ws.every((w) => w.utilization === null);
  }

  try {
    /* 官方客户端两套参数都用过（二进制里的原文引用）：
         /api/oauth/usage?at_wall=1&skip_spend=1
         /api/oauth/usage?cedar_ember=1&skip_spend=1
       先试第一套；如果窗口认出来了却一个百分比都没有，说明服务端给的是另一份形状，
       换第二套再试一次。两次都空就把原文带回去，别再让人对着一片 null 猜。 */
    let r = await fetchOnce(USAGE_PATH);
    if (!r.err && r.snap && noNumbers(r.snap)) {
      const alt = await fetchOnce(USAGE_PATH_ALT).catch(() => null);
      if (alt && !alt.err && alt.snap && !noNumbers(alt.snap)) r = alt;
    }
    if (r.err) return fail(r.err, r.text);
    const snap = r.snap as UsageSnapshot;
    snap.raw = r.text.slice(0, 4000);

    /* 二进制里对应这句（原文引用）：
         "Usage fetch returned a fieldless or non-object body (in-band error)"
       上游会回一个什么字段都没有的 body。以前这里直接返回 ok:true + windows:{}，
       面板看起来像「查到了但没有额度」，其实是没解析到。 */
    if (Object.keys(snap.windows).length === 0 && !snap.subscriptionType) {
      return fail("上游返回的用量里没有任何可识别字段（既没有 rate_limits 也没有 limits）。原始响应：" + r.text.slice(0, 300), r.text);
    }
    /* 顺手把额度已耗尽这件事反映到窗口状态上 */
    for (const w of Object.values(snap.windows)) {
      if (w.status === undefined && w.utilization !== null && w.utilization >= 1) w.status = "rejected";
    }
    return snap;
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
}

/**
 * 从上游响应头抽取限流观测。
 * 订阅账号会带 anthropic-ratelimit-unified-*；Console Key 只有各维度的 limit/remaining/reset。
 */

