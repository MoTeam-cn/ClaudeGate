import fs from "node:fs";

/**
 * 删临时目录。
 *
 * Bun 释放 SQLite 句柄比 Node 慢一拍，紧接着 rm 会 EBUSY —— 清理失败会把
 * 测试判成失败，很冤。Node 的 rmSync 认 maxRetries（对 EBUSY/EPERM 线性退避），
 * Bun 不一定认，所以外面再套一层手动重试。
 */
export function cleanupDir(dir: string): void {
  for (let i = 0; i < 20; i++) {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 40 });
      return;
    } catch {
      /* 再等一会儿；同步上下文里用 Atomics.wait 做真睡眠 */
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 80);
    }
  }
}
