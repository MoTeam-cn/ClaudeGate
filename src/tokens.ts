import crypto from "node:crypto";
import { b64url, nowSec } from "./utils.ts";
import type { Config, GatewayTokenPayload } from "./types.ts";

const PREFIX = "gw1.";

export function signGatewayToken(cfg: Config, sub: string): string {
  const payload: GatewayTokenPayload = {
    sub: sub || "default",
    iat: nowSec(),
    exp: nowSec() + Math.floor(cfg.tokenTtlDays * 86400)
  };
  const body = b64url(JSON.stringify(payload));
  const sig = b64url(crypto.createHmac("sha256", cfg.secret).update(body).digest());
  return PREFIX + body + "." + sig;
}

export function verifyGatewayToken(cfg: Config, token: string): GatewayTokenPayload | null {
  if (!token || !token.startsWith(PREFIX)) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;

  const expect = Buffer.from(b64url(crypto.createHmac("sha256", cfg.secret).update(parts[1]).digest()));
  const given = Buffer.from(parts[2]);
  if (expect.length !== given.length || !crypto.timingSafeEqual(expect, given)) return null;

  let payload: GatewayTokenPayload;
  try {
    payload = JSON.parse(
      Buffer.from(parts[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8")
    ) as GatewayTokenPayload;
  } catch {
    return null;
  }
  if (!payload || typeof payload.exp !== "number" || payload.exp < nowSec()) return null;
  return payload;
}

export function isGatewayToken(token: string): boolean {
  return typeof token === "string" && token.startsWith(PREFIX);
}
