#!/usr/bin/env node
import { createGateway } from "./server.ts";
import { effectiveTransport } from "./upstream.ts";
import { isBun } from "./net/fetch.ts";
import { checkEgress } from "./net/ipcheck.ts";

const gw = createGateway(process.env);

/**
 * 出口自检要在开始监听之前跑：如果代理根本没生效，与其让它带着错误的出口去连
 * Anthropic（那才是真正会招风控的），不如直接不起。
 * 默认 block，IP_CHECK=warn 只警告，IP_CHECK=off 跳过。
 */
async function boot(): Promise<void> {
  if (gw.cfg.ipCheckMode !== "off") {
    const chk = await checkEgress(gw.cfg, 8000);
    if (chk.conclusive && chk.proxyIgnored) {
      const msg = "出口自检失败 —— " + chk.summary + "（IP_CHECK=" + gw.cfg.ipCheckMode + "）";
      if (gw.cfg.ipCheckMode === "block") {
        gw.log.error(msg);
        gw.log.error("修好代理再启动，或用 IP_CHECK=off 显式跳过这项检查");
        process.exit(1);
      }
      gw.log.warn(msg);
    } else {
      gw.log.info("出口自检：" + chk.summary);
    }
  }
  const addr = await gw.listen();
  {
    gw.log.info("claude-gateway listening on " + addr.address + ":" + addr.port);
    gw.log.info(
      "guard=" + gw.cfg.guardMode +
      " injectMissing=" + gw.cfg.injectMissing +
      " transport=" + effectiveTransport(gw.cfg) +
    (gw.cfg.transport === "auto" && effectiveTransport(gw.cfg) === "https" && (isBun() ? !!gw.cfg.proxy : true)
      ? " (auto：非 Bun 或有代理，拿不到完全一致的 JA3；要 JA3 就 Bun 直连)"
      : "") +
      " runtime=" + (typeof (globalThis as { Bun?: unknown }).Bun !== "undefined" ? "bun" : "node") +
      " upstream=" + gw.cfg.upstreamBase +
      " maxSockets=" + gw.cfg.upstreamMaxSockets
    );
    gw.log.info(
      "pool=" + gw.accounts.list().length + " accounts, " + gw.keys.list().length + " api keys, stego=" + gw.cfg.stegoMode
    );
    /* 登录密钥只在首次派发时打印这一次，之后每次启动都不再打。
       忘了就去面板「设置」里重置，或删 data/admin.json 重新派发 */
    if (gw.adminKey.announce) printLoginKey(gw.adminKey.announce, gw.cfg.port, gw.adminKey.info());
    gw.log.info("panel: /panel（首次进入要求登录密钥，存在浏览器 localStorage；忘了可在面板设置里重置）");
    for (const w of gw.warnings) gw.log.warn(w);
    if (!gw.accounts.list().length) {
      gw.log.warn("号池为空：打开面板添加账号，或访问 /login 走 OAuth 授权");
    }
  }
}

boot().catch((e: unknown) => {
  gw.log.error("启动失败: " + (e instanceof Error && e.stack ? e.stack : String(e)));
  process.exit(1);
});

/**
 * 登录密钥横幅。刻意打成多行并带明显边框 —— 这是全流程里唯一一次出现明文，
 * 用户要在日志里一眼找到它。之后任何启动都不再打印。
 */
function printLoginKey(key: string, port: number | string, info: { keyFile: string; envFile: string; envMirrored: boolean; masterFingerprint: string }): void {
  const line = "=".repeat(72);
  const out = [
    "",
    line,
    "  面板登录密钥（只显示这一次，请立刻保存）",
    "",
    "      " + key,
    "",
    "  面板地址： http://<本机地址>:" + port + "/panel",
    "  主密钥在： " + info.keyFile + "（指纹 " + info.masterFingerprint + "）" +
      (info.envMirrored && info.envFile ? "，并已镜像到 " + info.envFile + " 的 ADMIN_SECRET" : ""),
    "  忘了密钥： 在面板「设置」里重置，或删掉 data/admin.json 重启重新派发",
    line,
    ""
  ];
  /* 走 console 而不是 log.info：这一条要能在日志里被单独看到，
     同时不进运行日志库，免得明文躺在数据库里 */
  console.log(out.join("\n"));
}

let shuttingDown = false;
function shutdown(sig: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  gw.log.info("received " + sig + ", shutting down");
  gw.close().then(() => process.exit(0));
  setTimeout(() => process.exit(0), gw.cfg.shutdownGraceMs + 1000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("unhandledRejection", (e: unknown) => {
  gw.log.error("unhandledRejection: " + (e instanceof Error && e.stack ? e.stack : String(e)));
});
process.on("uncaughtException", (e: Error) => {
  gw.log.error("uncaughtException: " + (e.stack ?? e.message));
});
