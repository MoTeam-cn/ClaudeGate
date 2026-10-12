import { sendJson } from "../../http/respond.ts";
import { readJson } from "../../http/body.ts";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { PanelDeps } from "./types.ts";
import { postAccount } from "./post-account.ts";
import { postKey } from "./post-key.ts";
import { postMisc } from "./post-misc.ts";

/**
 * POST 的总入口。
 *
 * 390 行的 switch 按域拆成三块（account+oauth / key / 杂项），
 * 每块返回「我处理了没有」，都没处理才落到 unknown_action。
 * 拆的理由：单文件曾达 695 行，而 post 一段就占 390。
 */
export async function handlePost(
  deps: PanelDeps,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  action: string
): Promise<void> {
  const body = (await readJson(req, deps.ctx.cfg.maxBodyBytes)) as Record<string, unknown>;

  if (await postAccount(deps, req, res, url, action, body)) return;
  if (await postKey(deps, req, res, url, action, body)) return;
  if (await postMisc(deps, req, res, url, action, body)) return;

  sendJson(res, 400, { error: { message: "unknown action: " + action, code: "unknown_action" } });
}
