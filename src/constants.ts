import type { GuardMode, OAuthMode } from "./types.ts";

export const PROD = {
  BASE_API_URL: "https://api.anthropic.com",
  CONSOLE_AUTHORIZE_URL: "https://platform.claude.com/oauth/authorize",
  CLAUDE_AI_AUTHORIZE_URL: "https://claude.com/cai/oauth/authorize",
  TOKEN_URL: "https://platform.claude.com/v1/oauth/token",
  API_KEY_URL: "https://api.anthropic.com/api/oauth/claude_cli/create_api_key",
  ROLES_URL: "https://api.anthropic.com/api/oauth/claude_cli/roles",
  PROFILE_URL: "https://api.anthropic.com/api/oauth/profile",
  IP_CHECK_URL: "https://ipinfo.io/json",
  /* Claude Code 的模型目录。catalog.json 是数据，schema.json 是形状定义 */
  MODEL_CATALOG_URL: "https://downloads.claude.ai/model-catalog/v1/catalog.json",
  MANUAL_REDIRECT_URL: "https://platform.claude.com/oauth/code/callback",
  CLAUDEAI_SUCCESS_URL: "https://platform.claude.com/oauth/code/success?app=claude-code",
  CLIENT_ID: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
  DESIGN_CLIENT_ID: "59637612-477b-4836-a601-b0589eda7704"
} as const;

export const DEFAULT_SCOPES: readonly string[] = [
  "org:create_api_key",
  "user:profile",
  "user:inference",
  "user:sessions:claude_code",
  "user:mcp_servers",
  "user:file_upload",
  "user:plugins"
];

export const OAUTH_BETA = "oauth-2025-04-20";
/** Claude Code 请求必带的 beta 标志，是「我是 Claude Code」的强信号之一 */
export const CC_BETA = "claude-code-20250219";
export const ANTHROPIC_VERSION = "2023-06-01";
export const CC_VERSION = "2.1.293";
export const CC_UA = "claude-cli/" + CC_VERSION + " (external, cli)";

export const GUARD_MODES: readonly GuardMode[] = ["strict", "lenient", "off"];
export const OAUTH_MODES: readonly OAuthMode[] = ["claude_ai", "console", "design"];

/** 由 Claude Code 或网关决定的头，不接受客户端伪造 */
export const PROTECTED_HEADERS: readonly string[] = [
  "x-app",
  "x-claude-code-request-class",
  "x-claude-code-agent-type",
  "x-claude-code-prompt-id",
  "x-claude-remote-session-origin",
  "x-anthropic-additional-protection"
];

/**
 * 与 Claude Code 真正使用的 BoringSSL 客户端完全一致的一组密码套件，顺序也一致。
 * Node 默认发 52 个套件（含一堆 CBC / 老套件），BoringSSL 只发 17 个；
 * 套件列表是 TLS 指纹里权重最大的一段，所以默认就按这个来发。
 * 想恢复 Node 默认（比如出站代理只支持老套件）：TLS_CIPHERS=default
 */
export const BORINGSSL_CIPHERS: string = [
  "TLS_AES_128_GCM_SHA256",
  "TLS_AES_256_GCM_SHA384",
  "TLS_CHACHA20_POLY1305_SHA256",
  "ECDHE-ECDSA-AES128-GCM-SHA256",
  "ECDHE-RSA-AES128-GCM-SHA256",
  "ECDHE-ECDSA-AES256-GCM-SHA384",
  "ECDHE-RSA-AES256-GCM-SHA384",
  "ECDHE-ECDSA-CHACHA20-POLY1305",
  "ECDHE-RSA-CHACHA20-POLY1305",
  "ECDHE-ECDSA-AES128-SHA",
  "ECDHE-RSA-AES128-SHA",
  "ECDHE-ECDSA-AES256-SHA",
  "ECDHE-RSA-AES256-SHA",
  "AES128-GCM-SHA256",
  "AES256-GCM-SHA384",
  "AES128-SHA",
  "AES256-SHA"
].join(":");

/** 凭据类请求头：转发时按客户端原来的位置换成号池账号的凭据 */
export const AUTH_HEADER_NAMES: ReadonlySet<string> = new Set<string>(["authorization", "x-api-key"]);

/**
 * 真正逐跳、不该转给上游的头。
 * 注意 authorization / x-api-key / content-length 不在这里：
 * 它们要么原地换成号的凭据（保位置），要么按实际体长重算，
 * 直接丢掉会让它们跑到头部列表末尾，顺序本身就是可观测的指纹。
 */
export const HOP_BY_HOP: ReadonlySet<string> = new Set<string>([
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "cookie"
]);

/**
 * 上游响应里**必须丢掉**的头。其余一律原样回传。
 *
 * 早先这里是白名单，结果 anthropic-organization-id、anthropic-ratelimit-* 之外的
 * 头全被吃了 —— Claude Code 会读 anthropic-* 与 request-id，白名单漏一个就是行为差异。
 * 现在反过来：只列必须丢的。
 */
export const RESPONSE_DROP_HEADERS: ReadonlySet<string> = new Set<string>([
  /* 逐跳，由 Node 自己管 */
  "connection",
  "keep-alive",
  "transfer-encoding",
  "te",
  "trailer",
  "upgrade",
  "proxy-authenticate",
  "proxy-authorization",
  /* 我们已经解压，长度对不上了 */
  "content-length",
  /* 别让上游的 cookie 盖掉网关面板自己的会话 */
  "set-cookie"
]);

/** 我们会解压的编码；只有这些才需要连带丢掉 content-encoding */
export const DECODED_ENCODINGS: ReadonlySet<string> = new Set<string>(["gzip", "deflate", "br", "zstd"]);

export const USER_ID_MODES: readonly string[] = ["off", "device", "full"];

export const TRANSPORT_MODES: readonly string[] = ["auto", "https", "fetch"];

/**
 * 一个模型。字段名跟 Claude Code 内置目录（seed catalog）对齐 ——
 * 那份目录里每个模型是 { id, family, display_name, provider_ids: { first_party, ... } }，
 * 其中 provider_ids.first_party 才是真正发给上游的 id。
 */
export interface ModelInfo {
  /** 家族 id，比如 claude-opus-5。Claude Code 的模型选择器用的就是它 */
  id: string;
  /** 给人看的名字，比如 Opus 5 */
  label: string;
  family: string;
  /** 发给上游的规范 id；老模型带日期后缀，跟家族 id 不同 */
  firstParty: string;
}

export const MODEL_CATALOG: readonly ModelInfo[] = [
  { id: "claude-opus-5-5", label: "Opus 5.5", family: "opus", firstParty: "claude-opus-5-5" },
  { id: "claude-opus-5", label: "Opus 5", family: "opus", firstParty: "claude-opus-5" },
  { id: "claude-opus-4-8", label: "Opus 4.8", family: "opus", firstParty: "claude-opus-4-8" },
  { id: "claude-opus-4-7", label: "Opus 4.7", family: "opus", firstParty: "claude-opus-4-7" },
  { id: "claude-opus-4-6", label: "Opus 4.6", family: "opus", firstParty: "claude-opus-4-6" },
  { id: "claude-opus-4-5", label: "Opus 4.5", family: "opus", firstParty: "claude-opus-4-5-20251101" },
  { id: "claude-opus-4-1", label: "Opus 4.1", family: "opus", firstParty: "claude-opus-4-1-20250805" },
  { id: "claude-opus-4-0", label: "Opus 4", family: "opus", firstParty: "claude-opus-4-20250514" },
  { id: "claude-sonnet-5-5", label: "Sonnet 5.5", family: "sonnet", firstParty: "claude-sonnet-5-5" },
  { id: "claude-sonnet-5", label: "Sonnet 5", family: "sonnet", firstParty: "claude-sonnet-5" },
  { id: "claude-sonnet-4-6", label: "Sonnet 4.6", family: "sonnet", firstParty: "claude-sonnet-4-6" },
  { id: "claude-sonnet-4-5", label: "Sonnet 4.5", family: "sonnet", firstParty: "claude-sonnet-4-5-20250929" },
  { id: "claude-sonnet-4-0", label: "Sonnet 4", family: "sonnet", firstParty: "claude-sonnet-4-20250514" },
  { id: "claude-3-7-sonnet", label: "Sonnet 3.7", family: "sonnet", firstParty: "claude-3-7-sonnet-20250219" },
  { id: "claude-3-5-sonnet", label: "Sonnet 3.5", family: "sonnet", firstParty: "claude-3-5-sonnet-20241022" },
  { id: "claude-haiku-5-5", label: "Haiku 5.5", family: "haiku", firstParty: "claude-haiku-5-5" },
  { id: "claude-haiku-4-5", label: "Haiku 4.5", family: "haiku", firstParty: "claude-haiku-4-5-20251001" },
  { id: "claude-3-5-haiku", label: "Haiku 3.5", family: "haiku", firstParty: "claude-3-5-haiku-20241022" },
  { id: "claude-fable-5-1", label: "Fable 5.1", family: "fable", firstParty: "claude-fable-5-1" },
  { id: "claude-fable-5", label: "Fable 5", family: "fable", firstParty: "claude-fable-5" },
  { id: "claude-mythos-5-1", label: "Mythos 5.1", family: "mythos", firstParty: "claude-mythos-5-1" },
  { id: "claude-mythos-5", label: "Mythos 5", family: "mythos", firstParty: "claude-mythos-5" },
];

export const MODEL_ALIASES: Readonly<Record<string, string>> = {
  /* 三个短别名指向当前代 */
  opus: "claude-opus-5",
  sonnet: "claude-sonnet-5",
  haiku: "claude-haiku-4-5-20251001",
  /* 历史别名：老客户端可能还在发这些 */
  "claude-3-5-sonnet-latest": "claude-sonnet-5",
  "claude-3-5-sonnet": "claude-3-5-sonnet-20241022",
  "claude-3-5-sonnet-20241022": "claude-3-5-sonnet-20241022",
  "claude-3-opus": "claude-opus-5",
  "claude-3-haiku": "claude-3-5-haiku-20241022",
  "claude-3-7-sonnet-latest": "claude-3-7-sonnet-20250219",
  "claude-sonnet-4-latest": "claude-sonnet-4-6",
  "claude-opus-4-latest": "claude-opus-4-8",
  "claude-opus-4-1-latest": "claude-opus-4-1-20250805",
  "claude-haiku-latest": "claude-haiku-4-5-20251001",
  /* OpenAI 那边的名字，方便直接换 base_url */
  "gpt-4o": "claude-sonnet-5",
  "gpt-4o-mini": "claude-haiku-4-5-20251001",
  "gpt-4-turbo": "claude-sonnet-5",
  "gpt-4": "claude-sonnet-5",
  "gpt-4.1": "claude-sonnet-5",
  "gpt-4.1-mini": "claude-haiku-4-5-20251001",
  "gpt-3.5-turbo": "claude-haiku-4-5-20251001",
  "gpt-5": "claude-opus-5",
  "gpt-5-mini": "claude-sonnet-5",
  o1: "claude-opus-5",
  "o1-mini": "claude-sonnet-5",
  o3: "claude-opus-5",
  "o3-mini": "claude-sonnet-5",
  "o4-mini": "claude-sonnet-5"
};
