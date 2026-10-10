#!/usr/bin/env node
/** 依次跑全部测试文件，聚合退出码。 */
import { spawnSync } from "node:child_process";

const files = ["test/smoke.ts", "test/attribution.test.ts",
  "test/encoding.test.ts",
  "test/stream.test.ts", "test/passthrough.test.ts", "test/websearch.test.ts",
  "test/stego.test.ts", "test/pool.test.ts", "test/usage.test.ts", "test/headers.test.ts",
  "test/userid.test.ts", "test/proxy.test.ts",
  "test/transport.test.ts", "test/agent.test.ts", "test/panel.test.ts", "test/gateway-contract.test.ts", "test/ja3.test.ts", "test/oauth.test.ts",
  "test/ipcheck.test.ts", "test/models.test.ts", "test/admin-key.test.ts",
  "test/limits.test.ts"];
let failed = 0;

/* CG_ENV_FILE="" 让网关既不读也不写 .env。
   否则每次跑测试都会往仓库里写一个带 ADMIN_SECRET 的 .env，污染后续运行 */
const childEnv = { ...process.env, CG_ENV_FILE: "" };

for (const f of files) {
  console.log("\n########## " + f + " ##########");
  const r = spawnSync(process.execPath, [f], { stdio: "inherit", env: childEnv });
  if (r.status !== 0) failed += 1;
}

console.log("\n########## 汇总 ##########");
console.log(failed === 0 ? "全部测试通过" : failed + " 个测试文件失败");
process.exit(failed ? 1 : 0);
