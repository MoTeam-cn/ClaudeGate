import type { Agent as HttpsAgent } from "node:https";
import type { Agent as HttpAgent } from "node:http";
import type { ProxySpec } from "../net/proxy.ts";
import type { UserIdMode } from "../userid.ts";

/** 请求头守卫模式 */
export type GuardMode = "strict" | "lenient" | "off";
/** 隐写拦截模式 */
export type StegoMode = "block" | "strip" | "log" | "off";
/** 请求 ID 回显模式 */
export type ReqIdMode = "error" | "always" | "off";
export type OAuthMode = "claude_ai" | "console" | "design";
export type LogLevel = "debug" | "info" | "warn" | "error";

/** 单个模型的上下文窗口与最大输出 */
export interface ModelLimit {
  /** 上下文窗口（token） */
  context: number;
  /** 最大输出（token）；null 表示不限制 */
  maxOutput: number | null;
}

export interface Config {
  port: number;
  host: string;
  publicUrl: string;
  /** 上游 429/5xx 时最多换几个号重试（含第一次，所以 1 = 不重试） */
  upstreamRetries: number;
  /** 注入 Claude Code 的归因头（system 第一段）。关掉只用于对照排查 */
  attributionHeader: boolean;
  /** cc_entrypoint 的值，默认 cli */
  attributionEntrypoint: string;
  /**
   * 每个模型的上下文窗口与最大输出。键是归一化后的模型名（小写、去 [1m]、去日期后缀），
   * "*" 是兜底项。见 src/model-limits.ts 的语法说明。
   */
  modelLimits: Record<string, ModelLimit>;
  /** 上下文超限怎么处理：block 拒绝（默认）/ log 只记 / off 不查 */
  contextGuard: "block" | "log" | "off";
  /** 超限容差。0.1 = 允许超出 10% 才拒绝 —— 客户端计数和真实计数不会完全一致 */
  contextHeadroom: number;
  /** 请求体身份校验：block 拒绝（默认）/ log 只记 / off 不查 */
  identityMode: "block" | "log" | "off";
  /**
   * 单张图片的 token 上限。官方是按模型给的（Haiku 4.5 是 1568，
   * Opus 5.5 / Sonnet 5.5 是 4784），网关拿不到这条通道，用一个可配的默认值。
   */
  imageMaxTokens: number;
  dataDir: string;
  secret: string;

  upstreamBase: string;
  upstreamProxy: string;
  /** 上游通道：auto / https / fetch */
  transport: "auto" | "https" | "fetch";
  /** metadata.user_id 的重写模式 */
  rewriteUserId: UserIdMode;
  tlsMin: string;
  /** 出站 TLS 密码套件；空串表示用 Node 默认 */
  tlsCiphers: string;
  tlsMax: string;
  upstreamAlpn: string;
  upstreamTimeoutMs: number;
  upstreamMaxSockets: number;

  maxBodyBytes: number;
  shutdownGraceMs: number;

  guardMode: GuardMode;
  guardRequire: string[];
  injectMissing: boolean;
  /** 请求头规范集合的施加方式，见 fingerprint/canonical.ts */
  headerMode: "union" | "canonical" | "off";

  stegoMode: StegoMode;
  reqIdInResponse: ReqIdMode;

  trustProxy: boolean;
  adminToken: string;
  /** 主密钥；首次启动自动生成并镜像进 .env */
  adminSecret: string;
  /** .env 路径；空串表示不读也不镜像 */
  envFile: string;
  tokenTtlDays: number;

  oauthMode: OAuthMode;
  oauthClientId: string;
  oauthScopes: string[];
  oauthAuthorizeUrl: string;
  oauthTokenUrl: string;
  oauthManualRedirect: string;
  oauthRolesUrl: string;
  /** GET /api/oauth/profile，用来拿真名字 */
  oauthProfileUrl: string;
  /** 出口自检用的 IP 回显服务 */
  ipCheckUrl: string;
  /** Claude Code 的模型目录地址 */
  modelCatalogUrl: string;
  /** 目录缓存多久算过期（毫秒） */
  modelCatalogTtlMs: number;
  /** 消息接口的模型校验：strict 不在目录里就报错 / off 放行 */
  modelValidation: "strict" | "off";
  /** 部署级隐藏清单（MODEL_DISABLED），跟面板里勾掉的取并集 */
  modelDisabled: string[];
  /** 出口自检模式：off / warn / block */
  ipCheckMode: "off" | "warn" | "block";
  apiKeyUrl: string;

  defaultModel: string;
  maxTokensDefault: number;
  logLevel: LogLevel;

  /** 内部：到上游的 keep-alive Agent（https 目标） */
  agent?: HttpsAgent;
  /** 内部：到上游的 keep-alive Agent（http 目标，测试与内网用） */
  agentHttp?: HttpAgent;
  /** 内部：解析好的出站代理；null 表示直连 */
  proxy?: ProxySpec | null;
}
