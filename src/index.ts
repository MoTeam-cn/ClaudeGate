#!/usr/bin/env node
import { createGateway } from "./server.ts";
import { effectiveTransport } from "./upstream.ts";
import { isBun } from "./net/fetch.ts";

const gw = createGateway(process.env);

gw.listen()
  .then((addr) => {
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
    gw.log.info("panel: " + (gw.cfg.adminToken ? "/panel?key=<ADMIN_TOKEN>" : "/panel（未设置 ADMIN_TOKEN，无鉴权）"));
    for (const w of gw.warnings) gw.log.warn(w);
    if (!gw.accounts.list().length) {
      gw.log.warn("号池为空：打开面板添加账号，或访问 /login 走 OAuth 授权");
    }
  })
  .catch((e: unknown) => {
    gw.log.error("listen failed: " + (e instanceof Error && e.stack ? e.stack : String(e)));
    process.exit(1);
  });

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
