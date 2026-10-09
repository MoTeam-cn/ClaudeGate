#!/usr/bin/env node
/** 依次跑全部测试文件，聚合退出码。 */
import { spawnSync } from "node:child_process";

const files = ["test/smoke.ts", "test/stego.test.ts", "test/pool.test.ts", "test/usage.test.ts", "test/headers.test.ts",
  "test/userid.test.ts", "test/proxy.test.ts",
  "test/transport.test.ts"];
let failed = 0;

for (const f of files) {
  console.log("\n########## " + f + " ##########");
  const r = spawnSync(process.execPath, [f], { stdio: "inherit" });
  if (r.status !== 0) failed += 1;
}

console.log("\n########## 汇总 ##########");
console.log(failed === 0 ? "全部测试通过" : failed + " 个测试文件失败");
process.exit(failed ? 1 : 0);
