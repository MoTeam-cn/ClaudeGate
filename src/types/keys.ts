import type { FingerprintMode } from "./account.ts";

export interface ApiKeyRecord {
  id: string;
  name: string;
  keyHash: string;
  keyPrefix: string;
  enabled: boolean;
  fingerprintMode: FingerprintMode;
  /** 空数组表示不限制 */
  allowedModels: string[];
  allowedProtocols: string[];
  quotaEnabled: boolean;
  rateLimitPerMin: number;
  dailyRequestLimit: number;
  dailyTokenLimit: number;
  boundAccountId: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface ApiKeyInput {
  name: string;
  fingerprintMode?: FingerprintMode;
  allowedModels?: string[];
  allowedProtocols?: string[];
  quotaEnabled?: boolean;
  rateLimitPerMin?: number;
  dailyRequestLimit?: number;
  dailyTokenLimit?: number;
  boundAccountId?: string | null;
}

export interface ApiKeyUsage {
  keyId: string;
  day: string;
  requests: number;
  promptTokens: number;
  completionTokens: number;
  cacheTokens: number;
}
