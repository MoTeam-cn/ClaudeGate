import { escapeHtml } from "../utils.ts";
import { CC_VERSION } from "../constants.ts";
import type { Config } from "../types.ts";

const STYLE = [
  "*{box-sizing:border-box}",
  "body{margin:0;min-height:100vh;background:#0f1115;color:#e6e8ee;",
  "font:14px/1.65 ui-sans-serif,system-ui,'Segoe UI',Roboto,'Helvetica Neue',Arial,'PingFang SC','Microsoft YaHei',sans-serif;",
  "display:flex;justify-content:center;padding:40px 16px}",
  ".wrap{width:100%;max-width:760px}",
  "h1{font-size:20px;margin:0 0 4px;letter-spacing:.2px}",
  ".sub{color:#8b93a7;margin-bottom:24px;font-size:13px}",
  ".card{background:#171a21;border:1px solid #242a36;border-radius:12px;padding:20px;margin-bottom:16px}",
  ".card h2{font-size:14px;margin:0 0 12px;color:#aab2c5;font-weight:600;letter-spacing:.3px}",
  "a.btn,button.btn{display:inline-block;background:#3b6ef6;color:#fff;border:0;border-radius:8px;padding:10px 18px;",
  "font-size:14px;font-weight:600;text-decoration:none;cursor:pointer}",
  "a.btn:hover,button.btn:hover{background:#4a7bfa}",
  "code,pre{font-family:ui-monospace,SFMono-Regular,Consolas,'Courier New',monospace}",
  "pre{background:#0b0d12;border:1px solid #232936;border-radius:8px;padding:12px;overflow:auto;font-size:12.5px;color:#c8d0e0;margin:0}",
  "input[type=text]{width:100%;background:#0b0d12;border:1px solid #2a3140;color:#e6e8ee;border-radius:8px;",
  "padding:10px 12px;font-size:13px;margin:10px 0}",
  ".ok{color:#4ade80}.bad{color:#f87171}.warn{color:#fbbf24}",
  ".kv{display:grid;grid-template-columns:170px 1fr;gap:6px 12px;font-size:13px}",
  ".kv div:nth-child(odd){color:#8b93a7}"
].join("");

export function page(title: string, inner: string): string {
  return (
    "<!doctype html><html lang=\"zh-CN\"><head><meta charset=\"utf-8\">" +
    "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">" +
    "<title>" + escapeHtml(title) + "</title><style>" + STYLE + "</style></head>" +
    "<body><div class=\"wrap\">" + inner + "</div></body></html>"
  );
}

export function maskToken(t: string | undefined): string {
  if (!t) return "(未生成)";
  return t.slice(0, 10) + "..." + t.slice(-6);
}

export function baseUrl(cfg: Config): string {
  return cfg.publicUrl || "http://<落地机IP>:" + cfg.port;
}

export function envSnippet(cfg: Config, token: string): string {
  return [
    "export CLAUDE_CODE_USE_GATEWAY=1",
    "export ANTHROPIC_BASE_URL=" + baseUrl(cfg),
    "export ANTHROPIC_AUTH_TOKEN=" + token
  ].join("\n");
}

export function openaiSnippet(cfg: Config, token: string): string {
  return (
    "curl " + baseUrl(cfg) + "/v1/chat/completions \\\n" +
    "  -H \"Authorization: Bearer " + token + "\" \\\n" +
    "  -H \"Content-Type: application/json\" \\\n" +
    "  -H \"User-Agent: claude-cli/" + CC_VERSION + " (external, cli)\" \\\n" +
    "  -H \"x-app: cli\" \\\n" +
    "  -d '{\"model\":\"claude-sonnet-4-5-20250929\",\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}]}'"
  );
}

export function htmlEsc(s: unknown): string {
  return escapeHtml(s);
}
