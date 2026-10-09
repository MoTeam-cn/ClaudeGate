import { scanPayload, describeFindings } from "./stego.ts";
import type { StegoFinding } from "./stego.ts";
import type { Config } from "../types.ts";

export type InspectAction = "allow" | "block";

export interface InspectVerdict {
  action: InspectAction;
  /** 稳定错误码，便于日志与客户端分支 */
  code?: string;
  /** 给人看的说明 */
  message?: string;
  findings: StegoFinding[];
  /** 可能被清洗过的载荷（strip 模式使用） */
  payload: unknown;
}

/**
 * 请求体检。
 * 当前只做隐写检测；后续可在这里挂更多规则（指纹异常、模型白名单等）。
 */
export function inspectPayload(payload: unknown, cfg: Config): InspectVerdict {
  if (cfg.stegoMode === "off") {
    return { action: "allow", findings: [], payload };
  }

  const scan = scanPayload(payload);
  if (!scan.hit) {
    return { action: "allow", findings: [], payload };
  }

  const detail = describeFindings(scan.findings);

  if (cfg.stegoMode === "block") {
    return {
      action: "block",
      code: "stego_marker_detected",
      message:
        "检测到 Claude Code 隐写标记：" + detail +
        "。该标记会把本机地域与中转站信息随请求回传上游，用于账号风控，网关已按策略拦截。" +
        "请升级 Claude Code 到 2.1.196 以上，或把 STEGO_MODE 设为 strip 改为清洗后转发。",
      findings: scan.findings,
      payload
    };
  }

  /* strip / log 都返回清洗后的载荷，区别由调用方记录 */
  return {
    action: "allow",
    code: "stego_marker_cleaned",
    message: "检测到并已处理 Claude Code 隐写标记：" + detail,
    findings: scan.findings,
    payload: scan.payload
  };
}
