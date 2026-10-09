import crypto from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";

export function num(v: unknown, d: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

export function bool(v: unknown, d: boolean): boolean {
  if (v === undefined || v === null || v === "") return d;
  const s = String(v).toLowerCase().trim();
  return s === "1" || s === "true" || s === "yes" || s === "on";
}

export function stripSlash(s: string): string {
  return String(s || "").replace(/\/+$/, "");
}

export function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function randHex(n: number): string {
  return crypto.randomBytes(n).toString("hex");
}

/** 由种子派生稳定 UUID（用于给同一网关令牌固定 session-id） */
export function uuidFrom(seed: string): string {
  const h = crypto.createHash("sha256").update(String(seed)).digest("hex");
  return (
    h.slice(0, 8) + "-" + h.slice(8, 12) + "-4" + h.slice(13, 16) +
    "-a" + h.slice(17, 20) + "-" + h.slice(20, 32)
  );
}

export function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

export function lowerHeaders(h: IncomingHttpHeaders | Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(h)) out[k.toLowerCase()] = (h as Record<string, unknown>)[k];
  return out;
}

export function safeJson<T = Record<string, unknown>>(s: string): T {
  try {
    const v = JSON.parse(s);
    return (v && typeof v === "object" ? v : {}) as T;
  } catch {
    return {} as T;
  }
}

export function clampInt(v: unknown, d: number, lo: number, hi: number): number {
  let n = Math.floor(Number(v));
  if (!Number.isFinite(n)) n = d;
  return Math.max(lo, Math.min(hi, n));
}

export function escapeHtml(s: unknown): string {
  return String(s === undefined || s === null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** 头值可能是数组，统一取首个 */
export function headerValue(v: string | string[] | undefined): string {
  if (Array.isArray(v)) return v[0] ?? "";
  return v ?? "";
}

export function toStr(v: unknown, d = ""): string {
  return typeof v === "string" ? v : d;
}
