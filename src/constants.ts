import type { GuardMode, OAuthMode } from "./types.ts";

export const PROD = {
  BASE_API_URL: "https://api.anthropic.com",
  CONSOLE_AUTHORIZE_URL: "https://platform.claude.com/oauth/authorize",
  CLAUDE_AI_AUTHORIZE_URL: "https://claude.com/cai/oauth/authorize",
  TOKEN_URL: "https://platform.claude.com/v1/oauth/token",
  API_KEY_URL: "https://api.anthropic.com/api/oauth/claude_cli/create_api_key",
  ROLES_URL: "https://api.anthropic.com/api/oauth/claude_cli/roles",
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

/** 上游响应里需要回传给客户端的头 */
export const RESPONSE_PASS_HEADERS: readonly string[] = [
  "content-type",
  "cache-control",
  "request-id",
  "x-request-id",
  "retry-after",
  "anthropic-version"
];

export interface ModelInfo {
  id: string;
  label: string;
  tier: "opus" | "sonnet" | "haiku";
}

export const MODEL_CATALOG: readonly ModelInfo[] = [
  { id: "claude-opus-4-5-20251101", label: "Claude Opus 4.5", tier: "opus" },
  { id: "claude-opus-4-1-20250805", label: "Claude Opus 4.1", tier: "opus" },
  { id: "claude-opus-4-20250514", label: "Claude Opus 4", tier: "opus" },
  { id: "claude-sonnet-4-5-20250929", label: "Claude Sonnet 4.5", tier: "sonnet" },
  { id: "claude-sonnet-4-20250514", label: "Claude Sonnet 4", tier: "sonnet" },
  { id: "claude-3-7-sonnet-20250219", label: "Claude Sonnet 3.7", tier: "sonnet" },
  { id: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5", tier: "haiku" },
  { id: "claude-3-5-haiku-20241022", label: "Claude Haiku 3.5", tier: "haiku" }
];

export const MODEL_ALIASES: Readonly<Record<string, string>> = {
  opus: "claude-opus-4-5-20251101",
  sonnet: "claude-sonnet-4-5-20250929",
  haiku: "claude-haiku-4-5-20251001",
  "claude-3-5-sonnet-latest": "claude-sonnet-4-5-20250929",
  "claude-3-5-sonnet": "claude-sonnet-4-5-20250929",
  "claude-3-5-sonnet-20241022": "claude-3-5-haiku-20241022",
  "claude-3-opus": "claude-opus-4-5-20251101",
  "claude-3-haiku": "claude-haiku-4-5-20251001",
  "gpt-4o": "claude-sonnet-4-5-20250929",
  "gpt-4o-mini": "claude-haiku-4-5-20251001",
  "gpt-4-turbo": "claude-sonnet-4-5-20250929",
  "gpt-4": "claude-sonnet-4-5-20250929",
  "gpt-4.1": "claude-sonnet-4-5-20250929",
  "gpt-4.1-mini": "claude-haiku-4-5-20251001",
  "gpt-3.5-turbo": "claude-haiku-4-5-20251001",
  "gpt-5": "claude-opus-4-5-20251101",
  "gpt-5-mini": "claude-sonnet-4-5-20250929",
  o1: "claude-opus-4-5-20251101",
  "o1-mini": "claude-sonnet-4-5-20250929",
  o3: "claude-opus-4-5-20251101",
  "o3-mini": "claude-sonnet-4-5-20250929",
  "o4-mini": "claude-sonnet-4-5-20250929"
};
