/**
 * 出口自检。
 *
 * 要防的坑：配置里写着代理，实际请求却没走代理（代理挂了被静默忽略、环境变量没生效、
 * 容器里网络策略绕开等）。这时候流量从本机直出，对 Anthropic 来说是完全不同的来源，
 * 既容易被风控，也让「固定出口」这个前提失效。
 *
 * 判据很直接：
 *   带代理查一次 IP，不带代理查一次 IP。
 *   两次一样 -> 说明代理根本没生效 -> 报错。
 *
 * 拿不到结论的情况（比如内网机器压根没有直连出口，不带代理那次直接失败）不算失败，
 * 只如实报告「无法判定」，不能因为查不出来就拦着不让启动。
 *
 * 还有一类最容易被忽略的：**压根没解析出代理**。这时候也谈不上「代理失效」，
 * 但直连出去的后果一样严重 —— 所以结论里会点明「这次是直连出去的」，
 * 并把该设哪些环境变量、以及「Docker 不会自动传宿主环境变量」这条写清楚。
 */
import { requestRaw } from "./request.ts";
import { describeProxy } from "./proxy.ts";
import type { Config } from "../types.ts";

export interface EgressProbe {
  ip: string | null;
  error: string | null;
  ms: number;
}

export interface EgressCheck {
  /** 检查本身是否跑成功（两条都拿到了 IP 才算有结论） */
  conclusive: boolean;
  /** 判定结果：true = 代理没生效 */
  proxyIgnored: boolean;
  /** 配置里到底有没有解析出代理 */
  proxyConfigured: boolean;
  /** 解析出来的代理（已抹掉密码），没配就是 null */
  proxy: string | null;
  direct: EgressProbe;
  proxied: EgressProbe;
  url: string;
  summary: string;
}

/** 该设哪个环境变量 —— 报错文案与文档共用一份 */
export const PROXY_ENV_HINT =
  "UPSTREAM_PROXY（也认 ALL_PROXY / HTTPS_PROXY / HTTP_PROXY / SOCKS5_PROXY）";

/** 从各种 IP 回显服务的响应里抠出 IP */
function extractIp(text: string): string | null {
  const t = text.trim();
  /* 纯文本形态，比如 api.ipify.org 不带 format=json */
  if (/^[0-9a-fA-F:.]{3,45}$/.test(t)) return t;
  try {
    const j = JSON.parse(t) as Record<string, unknown>;
    for (const k of ["ip", "query", "origin", "address", "YourFuckingIPAddress"]) {
      const v = j[k];
      if (typeof v === "string" && v.trim()) return v.trim();
    }
  } catch {
    /* 不是 JSON 就按纯文本再试一次：取第一行 */
    const first = t.split(/\s+/)[0];
    if (first && /^[0-9a-fA-F:.]{3,45}$/.test(first)) return first;
  }
  return null;
}

async function probe(cfg: Config, url: string, noProxy: boolean, timeoutMs: number): Promise<EgressProbe> {
  const t0 = Date.now();
  try {
    const res = await requestRaw(url, {
      cfg,
      method: "GET",
      noProxy,
      headers: { accept: "application/json, text/plain, */*" },
      timeoutMs
    });
    const ip = res.ok ? extractIp(res.text) : null;
    return {
      ip,
      error: ip ? null : "HTTP " + res.status + " " + res.text.slice(0, 120),
      ms: Date.now() - t0
    };
  } catch (e) {
    return { ip: null, error: e instanceof Error ? e.message : String(e), ms: Date.now() - t0 };
  }
}

/**
 * 跑一次出口自检。两条请求并发，所以最坏也就是一个 timeout 的时间。
 */
export async function checkEgress(cfg: Config, timeoutMs = 8000): Promise<EgressCheck> {
  const url = cfg.ipCheckUrl;
  const proxyConfigured = !!cfg.proxy;
  const proxy = cfg.proxy ? describeProxy(cfg.proxy) : null;
  const base = { proxyConfigured, proxy, url };

  const [proxied, direct] = await Promise.all([
    cfg.proxy
      ? probe(cfg, url, false, timeoutMs)
      : Promise.resolve<EgressProbe>({ ip: null, error: "没有配置出站代理", ms: 0 }),
    probe(cfg, url, true, timeoutMs)
  ]);

  if (!proxyConfigured) {
    return {
      ...base,
      conclusive: false,
      proxyIgnored: false,
      direct,
      proxied,
      summary:
        "没有配置出站代理，这次是直连出去的，出口就是 " + (direct.ip ?? "（取不到）") + "。" +
        "如果这台机器在国内，等于把真实 IP 交给上游。要配就设 " + PROXY_ENV_HINT + "；" +
        "注意 Docker 不会自动把宿主机的环境变量传进容器，得用 -e 或 env_file。"
    };
  }

  /* 直连那次失败是很正常的：内网机器本来就没有直连出口。这时没有结论 */
  if (!direct.ip) {
    return {
      ...base,
      conclusive: false,
      proxyIgnored: false,
      direct,
      proxied,
      summary:
        "无法判定：不带代理那次拿不到出口 IP（" + (direct.error ?? "未知") + "）。" +
        "带代理的出口是 " + (proxied.ip ?? "也拿不到（" + (proxied.error ?? "未知") + "）") +
        "（配置的是 " + proxy + "）"
    };
  }

  if (!proxied.ip) {
    return {
      ...base,
      conclusive: false,
      proxyIgnored: false,
      direct,
      proxied,
      summary: "代理那条查不到出口 IP：" + (proxied.error ?? "未知") + "（配置的是 " + proxy + "）"
    };
  }

  const same = direct.ip === proxied.ip;
  return {
    ...base,
    conclusive: true,
    proxyIgnored: same,
    direct,
    proxied,
    summary: same
      ? "代理没生效：带与不带代理的出口 IP 都是 " + proxied.ip + "，说明请求根本没走代理（配置的是 " + proxy + "）"
      : "出口正常：直连 " + direct.ip + "，经代理 " + proxied.ip + "（配置的是 " + proxy + "）"
  };
}
