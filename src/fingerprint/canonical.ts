import { lowerHeaders } from "../utils.ts";

/**
 * 官方客户端请求头的「规范集合」。
 *
 * 依据：docs/anthropic-detection.md 里抓到的真客户端原样头
 * （Claude Code 2.1.293，一次 POST /v1/messages?beta=true，21 个头，未经中间层）。
 *
 * 为什么需要它：
 *
 * 1. **beta 列表短了 10 个值。** 真客户端发 11 个 anthropic-beta 值，
 *    而 constants.ts 的 CC_BETA 只有其中 1 个。网关以前只在「客户端没带 beta」时
 *    注入那 1 个 —— 比真客户端短一大截，是可观测差异。
 * 2. **不同版本带不同的 beta 列表。** 原样转发的话，同一个 device_id 上会出现
 *    beta 列表的回退 —— 跟版本号回退一样，真机不可能（自动更新只会加不会减）。
 * 3. **X-Stainless-* 与 anthropic-dangerous-direct-browser-access 真客户端恒发。**
 *    第三方客户端不带，漏掉就是差异。
 *
 * 所以这里把「所有客户端都该长成什么样」写死一份：缺的补上，beta 统一。
 */

/** 真客户端发的 11 个 beta 值，顺序照抓包原样 */
export const CANONICAL_BETA_VALUES: readonly string[] = [
  "claude-code-20250219",
  "interleaved-thinking-2025-05-14",
  "thinking-token-count-2026-05-13",
  "context-management-2025-06-27",
  "prompt-caching-scope-2026-01-05",
  "mid-conversation-system-2026-04-07",
  "mid-conversation-tool-changes-2026-07-01",
  "advanced-tool-use-2025-11-20",
  "effort-2025-11-24",
  "dangerous-tool-use-2026-09-03",
  "afk-mode-2026-01-31"
];

export const CANONICAL_BETA = CANONICAL_BETA_VALUES.join(",");

/**
 * 真客户端恒发的固定值头。**只在客户端没带时补**，带了就用客户端的
 * —— 客户端的真实值比网关编的更可信。
 *
 * 注意 x-stainless-arch / os / runtime-version 是**机器相关**的：
 * 客户端自己报什么就是什么（Windows 用户报 Windows，Mac 用户报 Darwin），
 * 网关只在完全缺失时才用抓包时那台机器的值兜底。
 */
export const CANONICAL_HEADERS: ReadonlyArray<readonly [string, string]> = [
  ["x-app", "cli"],
  ["anthropic-version", "2023-06-01"],
  ["anthropic-dangerous-direct-browser-access", "true"],
  ["x-stainless-lang", "js"],
  ["x-stainless-runtime", "node"],
  ["x-stainless-retry-count", "0"],
  ["x-stainless-package-version", "0.128.0"],
  ["x-stainless-timeout", "600"],
  ["x-stainless-arch", "x64"],
  ["x-stainless-os", "Windows"],
  ["x-stainless-runtime-version", "v26.3.0"]
];

/** beta 是逗号分隔的能力集合，去重保序 */
export function mergeBetaList(a: unknown, b: unknown): string {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const src of [a, b]) {
    const s = Array.isArray(src) ? src.join(",") : typeof src === "string" ? src : "";
    for (const raw of s.split(",")) {
      const v = raw.trim();
      if (!v || seen.has(v)) continue;
      seen.add(v);
      out.push(v);
    }
  }
  return out.join(",");
}

/** 从 beta 串里挑出满足谓词的项，重新拼回逗号串 */
function keepBetas(src: unknown, want: (v: string) => boolean): string {
  const s = Array.isArray(src) ? src.join(",") : typeof src === "string" ? src : "";
  return s
    .split(",")
    .map((x) => x.trim())
    .filter((x) => x !== "" && want(x))
    .join(",");
}

/**
 * `union` 是默认值：规范集合当**地板**（所有请求都至少有那 11 个值，
 * 「比真客户端短 10 个值」的破绽消失），同时不丢客户端与网关自己带的能力。
 *
 * `canonical` 追求完全统一，代价是**会丢掉客户端自己的能力 beta**
 * —— 除非你确定所有客户端都只发规范集合里那些，否则别用。
 */
export type HeaderMode = "union" | "canonical" | "off";

export interface CanonicalOptions {
  mode: HeaderMode;
}

/**
 * 把请求头补齐成规范集合。
 *
 * - `canonical`：beta **统一**成规范集合（客户端带什么都换掉），其余固定头缺了就补。
 *   所有客户端对上游长得完全一样 —— 最稳。代价：比规范集合新的客户端，
 *   它新增的 beta 会被丢掉。
 * - `union`：beta 取「规范集合 ∪ 客户端带的」，其余同上。不丢功能，
 *   但集合仍随客户端版本变（回退问题还在）。
 * - `off`：完全不碰。
 */
export function applyCanonicalHeaders(
  headers: Record<string, string | string[] | undefined>,
  opts: CanonicalOptions
): Record<string, string | string[] | undefined> {
  if (opts.mode === "off") return headers;
  const lh = lowerHeaders(headers);
  const out: Record<string, string | string[] | undefined> = { ...headers };

  const betaKey = Object.keys(out).find((k) => k.toLowerCase() === "anthropic-beta");
  const existing = betaKey ? out[betaKey] : undefined;
  /*
   * canonical 模式也不能把「网关自己要用的 beta」丢掉 ——
   * oauth-2025-04-20 是订阅 OAuth 凭据的必需项，丢了账号直接报错
   * （实测：这一条把测试打红过）。所以只丢客户端的能力 beta，保留 oauth-*。
   */
  const keep = opts.mode === "canonical" ? keepBetas(existing, (v) => v.startsWith("oauth-")) : "";
  /* 规范集合放前面：客户端的顺序（含 oauth 追加在尾部）原样保留 */
  const next =
    opts.mode === "canonical"
      ? mergeBetaList(CANONICAL_BETA, keep)
      : mergeBetaList(CANONICAL_BETA, existing);
  if (betaKey) out[betaKey] = next;
  else out["anthropic-beta"] = next;

  for (const [name, value] of CANONICAL_HEADERS) {
    /* anthropic-version 由指纹头那条路负责，这里不重复 */
    if (name === "anthropic-version") continue;
    const cur = lh[name];
    if (cur === undefined || cur === null || String(cur).trim() === "") out[name] = value;
  }
  return out;
}
