import { sendJson } from "../../http/respond.ts";
import { clampInt } from "../../utils.ts";
import { applyRuntimeSettings } from "../../config.ts";
import { checkEgress } from "../../net/ipcheck.ts";
import { catalogStatus, applyModelDisabled, applyModelLimits, limitsEditorState } from "../../models.ts";
import { parseLimitsSetting } from "../../model-limits.ts";
import type { IncomingMessage, ServerResponse } from "node:http";
import { str } from "./views.ts";
import { SETTING_KEYS } from "./views.ts";
import type { PanelDeps } from "./types.ts";

/** 登录密钥 / 模型目录 / 出口自检 / 设置 / 日志清理。处理了返回 true */
export async function postMisc(
  deps: PanelDeps,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  action: string,
  body: Record<string, unknown>
): Promise<boolean> {
  const { cfg, settings, logs } = deps.ctx;

  switch (action) {
    /* 重置登录密钥。传 key 用自定义值，不传就随机生成。
       明文只在这一次响应里回去，之后只留 scrypt 哈希 —— 不再进日志 */
    case "admin.keyreset": {
      const custom = str(body.key).trim();
      try {
        const key = deps.ctx.adminKey.reset(custom || undefined);
        deps.ctx.log.warn("panel: 登录密钥已重置（" + (custom ? "自定义" : "随机生成") + "）");
        sendJson(res, 200, { ok: true, data: { key, info: deps.ctx.adminKey.info() } });
      } catch (e) {
        sendJson(res, 400, { error: { message: e instanceof Error ? e.message : String(e), code: "reset_failed" } });
      }
      return true;
    }

    /* 手动重拉模型目录。平时不刷 —— /v1/models 只读内存 */
    case "models.refresh": {
      const st = await deps.ctx.modelCatalog.refresh();
      deps.ctx.log.info("panel: 模型目录刷新 " + st.entries.length + " 个 source=" + st.source);
      sendJson(res, 200, { ok: true, data: catalogStatus(deps.ctx) });
      return true;
    }

    /* 每个模型的上下文窗口与最大输出。编辑器的初始状态 */
    case "models.limits":
      sendJson(res, 200, { ok: true, data: limitsEditorState(deps.ctx) });
      return true;

    /*
     * 保存模型限制。只存「专门给这个模型配的」那些项，
     * 没配的留给 "*" 兜底 —— 这样以后目录里加新模型会自动继承兜底值，
     * 不用挨个补一遍。
     */
    case "models.limits.save": {
      const raw = body.limits;
      const incoming = parseLimitsSetting(typeof raw === "string" ? raw : JSON.stringify(raw ?? {}));
      settings.set("modelLimits", JSON.stringify(incoming));
      applyModelLimits(deps.ctx);
      deps.ctx.log.info("panel: 模型上下文限制更新为 " + Object.keys(incoming).length + " 项");
      sendJson(res, 200, { ok: true, data: limitsEditorState(deps.ctx) });
      return true;
    }

    /* 面板里勾掉/勾上哪些模型。存进 settings，然后立刻重新应用一遍隐藏清单 */
    case "models.disable": {
      const ids = Array.isArray(body.ids) ? body.ids.map((x) => String(x)).filter(Boolean) : [];
      settings.set("modelDisabled", JSON.stringify(ids));
      applyModelDisabled(deps.ctx);
      const st = catalogStatus(deps.ctx);
      deps.ctx.log.info("panel: 模型隐藏清单更新为 " + ids.length + " 项，对外 " + st.count + " 个模型");
      sendJson(res, 200, { ok: true, data: st });
      return true;
    }

    /* 出口自检。启动时跑过一次，这里是手动再跑 —— 换了代理不用重启就能验 */
    case "net.ipcheck": {
      const chk = await checkEgress(cfg, 8000);
      deps.ctx.log.info("panel: 出口自检 " + chk.summary);
      sendJson(res, 200, { ok: true, data: chk });
      return true;
    }

    case "settings.save": {
      const patch: Record<string, string> = {};
      for (const k of SETTING_KEYS) {
        if (body[k] !== undefined) patch[k] = String(body[k]);
      }
      settings.setMany(patch);
      applyRuntimeSettings(cfg, patch);
      deps.ctx.log.info("panel: settings saved", patch);
      sendJson(res, 200, { ok: true, data: patch });
      return true;
    }

    case "logs.prune": {
      const days = clampInt(body.days ?? settings.get("logRetentionDays", "14"), 14, 1, 3650);
      const maxRows = clampInt(body.maxRows ?? settings.get("runtimeLogMax", "20000"), 20000, 100, 5_000_000);
      logs.prune(days, maxRows);
      sendJson(res, 200, { ok: true, data: { days, maxRows } });
      return true;
    }

    default:
      return false;
  }
}
