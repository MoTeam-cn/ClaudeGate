import { sendJson } from "../../http/respond.ts";
import { clampInt } from "../../utils.ts";
import type { IncomingMessage, ServerResponse } from "node:http";
import { asBool, publicKey, str, strList } from "./views.ts";
import type { PanelDeps } from "./types.ts";

/** key.* 的 POST 动作。处理了返回 true，没处理返回 false 交给下一个域 */
export async function postKey(
  deps: PanelDeps,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  action: string,
  body: Record<string, unknown>
): Promise<boolean> {
  const { keys } = deps.ctx;

  switch (action) {
    case "key.create": {
      const input = {
        name: str(body.name).trim() || "未命名 Key",
        fingerprintMode: str(body.fingerprintMode, "claude_code") === "passthrough" ? ("passthrough" as const) : ("claude_code" as const),
        allowedModels: strList(body.allowedModels),
        allowedProtocols: strList(body.allowedProtocols),
        quotaEnabled: asBool(body.quotaEnabled),
        rateLimitPerMin: clampInt(body.rateLimitPerMin, 0, 0, 100000),
        dailyRequestLimit: clampInt(body.dailyRequestLimit, 0, 0, 10_000_000),
        dailyTokenLimit: clampInt(body.dailyTokenLimit, 0, 0, 1_000_000_000),
        boundAccountId: str(body.boundAccountId) || null
      };
      const { record, plaintext } = keys.create(input);
      deps.ctx.log.info("panel: api key created " + record.id + " name=" + record.name);
      sendJson(res, 200, { ok: true, data: { key: publicKey(record, deps.ctx), plaintext } });
      return true;
    }

    /* 重置密钥：只换明文，其它配置保留。新明文只在这条响应里回一次 */
    case "key.reset": {
      const id = str(body.id);
      const done = keys.resetSecret(id);
      if (!done) {
        sendJson(res, 404, { error: { message: "Key 不存在", code: "not_found" } });
        return true;
      }
      deps.ctx.log.warn("panel: api key secret reset " + id);
      sendJson(res, 200, { ok: true, data: { key: publicKey(done.record, deps.ctx), plaintext: done.plaintext } });
      return true;
    }

    case "key.update": {
      const id = str(body.id);
      const patch: Record<string, unknown> = {};
      if (body.name !== undefined) patch.name = str(body.name);
      if (body.enabled !== undefined) patch.enabled = asBool(body.enabled);
      if (body.fingerprintMode !== undefined) {
        patch.fingerprintMode = str(body.fingerprintMode) === "passthrough" ? "passthrough" : "claude_code";
      }
      if (body.allowedModels !== undefined) patch.allowedModels = strList(body.allowedModels);
      if (body.allowedProtocols !== undefined) patch.allowedProtocols = strList(body.allowedProtocols);
      if (body.quotaEnabled !== undefined) patch.quotaEnabled = asBool(body.quotaEnabled);
      if (body.rateLimitPerMin !== undefined) patch.rateLimitPerMin = clampInt(body.rateLimitPerMin, 0, 0, 100000);
      if (body.dailyRequestLimit !== undefined) patch.dailyRequestLimit = clampInt(body.dailyRequestLimit, 0, 0, 10_000_000);
      if (body.dailyTokenLimit !== undefined) patch.dailyTokenLimit = clampInt(body.dailyTokenLimit, 0, 0, 1_000_000_000);
      if (body.boundAccountId !== undefined) patch.boundAccountId = str(body.boundAccountId) || null;
      const next = keys.update(id, patch as never);
      if (!next) {
        sendJson(res, 404, { error: { message: "Key 不存在", code: "not_found" } });
        return true;
      }
      sendJson(res, 200, { ok: true, data: publicKey(next, deps.ctx) });
      return true;
    }

    case "key.delete": {
      const id = str(body.id);
      const ok = keys.remove(id);
      deps.ctx.log.info("panel: api key deleted " + id);
      sendJson(res, ok ? 200 : 404, ok ? { ok: true } : { error: { message: "Key 不存在", code: "not_found" } });
      return true;
    }

    default:
      return false;
  }
}
