/**
 * 极简 .env 读写。
 *
 * 项目原本只读 process.env，.env.example 是纯文档、没有任何加载器。
 * 面板登录密钥要「首次启动派发到 .env」就必须真的读它，所以补上这一层。
 *
 * 解析规则刻意保守：
 *   - 只认 KEY=VALUE，第一个 = 之前是键；键两边空白去掉
 *   - 整行以 # 开头才是注释；值里的 # 原样保留（免得把密码从 # 处截断）
 *   - 值两侧成对的单/双引号剥掉，其余原样
 *   - export KEY=VALUE 也认
 *
 * 优先级：已存在的 process.env 优先，.env 只补空缺。这样 Docker/systemd 传进来的
 * 环境变量不会被工作目录里一个陈旧的 .env 悄悄盖掉。
 */
import fs from "node:fs";
import path from "node:path";

export interface EnvFileLoadResult {
  /** 文件路径 */
  path: string;
  /** 文件是否存在 */
  exists: boolean;
  /** 实际补进 env 的条数（被已有环境变量挡掉的不算） */
  applied: number;
  /** 文件里出现的键数 */
  seen: number;
}

/** 解析 .env 文本成键值对。同名的后出现的覆盖先出现的。 */
export function parseEnvFile(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const rawLine of String(text ?? "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const body = line.startsWith("export ") ? line.slice(7).trim() : line;
    const eq = body.indexOf("=");
    if (eq <= 0) continue;
    const key = body.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = body.slice(eq + 1).trim();
    const q = value[0];
    if ((q === "\"" || q === "'") && value.length >= 2 && value[value.length - 1] === q) {
      value = value.slice(1, -1);
    }
    out.set(key, value);
  }
  return out;
}

/**
 * 把 .env 读进 env。**不覆盖已存在的键** —— 真实环境变量永远优先。
 * 文件不存在不算错误，返回 exists=false。
 */
export function loadEnvFile(filePath: string, env: Record<string, string | undefined>): EnvFileLoadResult {
  let text = "";
  let exists = false;
  try {
    text = fs.readFileSync(filePath, "utf8");
    exists = true;
  } catch {
    return { path: filePath, exists: false, applied: 0, seen: 0 };
  }
  const parsed = parseEnvFile(text);
  let applied = 0;
  for (const [k, v] of parsed) {
    const cur = env[k];
    if (cur !== undefined && cur !== "") continue;
    env[k] = v;
    applied += 1;
  }
  return { path: filePath, exists: true, applied, seen: parsed.size };
}

/** 值是否可以不引号直接写。带空格、# 或引号的一律加引号。 */
function needsQuote(v: string): boolean {
  return !/^[A-Za-z0-9._:/@+\-]*$/.test(v);
}

/**
 * 写入或更新一个键。文件不存在就创建。
 * 已存在同名键就**原地改值**（保留注释与其它行、保留原来的位置）。
 * 写盘走 tmp + rename，和项目里其它落盘一致。
 * 返回是否写入成功；调用方对失败要能降级，不能因此起不来。
 */
export function upsertEnvVar(filePath: string, key: string, value: string): boolean {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    let lines: string[] = [];
    let existed = false;
    try {
      lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
      existed = true;
    } catch {
      lines = [];
    }
    const written = needsQuote(value) ? "\"" + value.replace(/\\/g, "\\\\").replace(/"/g, "\\\"") + "\"" : value;
    const line = key + "=" + written;
    let replaced = false;
    const out = lines.map((raw) => {
      const t = raw.trim();
      if (replaced || !t || t.startsWith("#")) return raw;
      const body = t.startsWith("export ") ? t.slice(7).trim() : t;
      const eq = body.indexOf("=");
      if (eq <= 0) return raw;
      if (body.slice(0, eq).trim() !== key) return raw;
      replaced = true;
      return line;
    });
    if (!replaced) {
      if (out.length && out[out.length - 1] !== "") out.push(line);
      else out.push(line);
    }
    const text = out.join("\n").replace(/\n+$/, "") + "\n";
    const tmp = filePath + ".tmp-" + process.pid;
    fs.writeFileSync(tmp, text, { mode: existed ? undefined : 0o600 });
    fs.renameSync(tmp, filePath);
    return true;
  } catch {
    return false;
  }
}
