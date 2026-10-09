import type { Logger, LogLevel } from "./types.ts";

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export function createLogger(level: LogLevel): Logger {
  const min = ORDER[level] ?? 20;

  function write(lv: LogLevel, msg: string, extra?: unknown): void {
    if (ORDER[lv] < min) return;
    let line = new Date().toISOString() + " [" + lv.toUpperCase() + "] " + msg;
    if (extra !== undefined) {
      try {
        line += " " + JSON.stringify(extra);
      } catch {
        /* 忽略不可序列化的额外信息 */
      }
    }
    process.stdout.write(line + "\n");
  }

  return {
    level,
    debug: (m, e) => write("debug", m, e),
    info: (m, e) => write("info", m, e),
    warn: (m, e) => write("warn", m, e),
    error: (m, e) => write("error", m, e)
  };
}
