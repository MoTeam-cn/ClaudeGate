/**
 * Claude Code 隐写标记检测与清洗。
 *
 * 背景：2.1.91 至 2.1.196 的客户端在 ANTHROPIC_BASE_URL 非官方时，会把
 * 「是否中国时区 / 是否命中域名黑名单」用隐写方式写进系统提示词的日期行：
 *   - 日期分隔符由连字符改斜杠      -> 中国时区
 *   - Today 后面的撇号换成别的码位  -> 命中不同名单
 *
 * 四个撇号码位：
 *   U+0027 正常（未命中）
 *   U+2019 命中域名名单
 *   U+02BC 命中 AI 实验室关键词
 *   U+02B9 两者都命中
 *
 * **判定范围只限日期行。** 早先这里还有一步「全局扫掠 U+02BC / U+02B9」，
 * 理由是「这两个码位在正常文本里几乎不出现」—— 那个理由不成立：
 * 乱码输出、Python 源码、从别处复制来的文本都可能带它们。
 * 结果是用户让模型跑个脚本，脚本输出里有这两个字符，整个对话就被 400 拦了。
 * 真实标记只会出现在系统提示词的日期行上，所以只认那一处。
 */

export type StegoKind = "apostrophe" | "date_separator" | "control_char";

export interface StegoFinding {
  kind: StegoKind;
  /** 在文本中的字符下标 */
  index: number;
  codepoint: number;
  /** 该码位的可读含义 */
  meaning: string;
  /** 命中位置附近的原文片段 */
  sample: string;
}

export interface StegoScanResult {
  hit: boolean;
  findings: StegoFinding[];
  /** 清洗后的文本（未命中时与原文相同） */
  cleaned: string;
  changed: boolean;
}

const APOSTROPHE_ASCII = 0x0027;

const APOSTROPHE_MEANING: Readonly<Record<number, string>> = {
  0x0027: "正常 ASCII 单引号（未命中任何名单）",
  0x2019: "U+2019 右单引号（命中域名名单）",
  0x02bc: "U+02BC 修饰字母撇号（命中 AI 实验室关键词）",
  0x02b9: "U+02B9 修饰字母角分符（两者都命中）"
};

const DATE_RE_SOURCE =
  "Today(['\\u0027\\u2019\\u02bc\\u02b9])s date is (\\d{4})([-/])(\\d{1,2})([-/])(\\d{1,2})";

function freshDateRe(): RegExp {
  return new RegExp(DATE_RE_SOURCE, "g");
}

function sliceAround(text: string, index: number, radius = 24): string {
  const a = Math.max(0, index - radius);
  const b = Math.min(text.length, index + radius);
  return text.slice(a, b);
}

/** 扫描单段文本 */
export function scanStego(text: string): StegoScanResult {
  const findings: StegoFinding[] = [];
  if (!text) return { hit: false, findings, cleaned: text, changed: false };

  /* 1) 日期行：撇号码位 + 分隔符 */
  const re = freshDateRe();
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const ap = m[1].codePointAt(0) ?? APOSTROPHE_ASCII;
    if (ap !== APOSTROPHE_ASCII) {
      findings.push({
        kind: "apostrophe",
        index: m.index,
        codepoint: ap,
        meaning: APOSTROPHE_MEANING[ap] ?? "未知码位",
        sample: sliceAround(text, m.index)
      });
    }
    if (m[3] === "/" || m[5] === "/") {
      findings.push({
        kind: "date_separator",
        index: m.index,
        codepoint: 0x002f,
        meaning: "日期分隔符为斜杠（中国时区标记）",
        sample: sliceAround(text, m.index)
      });
    }
  }

  if (!findings.length) return { hit: false, findings, cleaned: text, changed: false };

  /* 清洗：只动日期行本身，把它归一化成纯 ASCII。
     以前这里还有一步「把全文的 U+02BC/U+02B9 换成普通撇号」——
     那等于重写用户正文里合法的修饰字母，已经去掉了 */
  const cleaned = text.replace(
    freshDateRe(),
    (_all: string, _ap: string, y: string, _sep: string, mo: string, _sep2: string, d: string) =>
      "Today's date is " + y + "-" + mo + "-" + d
  );

  return { hit: true, findings, cleaned, changed: cleaned !== text };
}

export interface PayloadScanResult {
  hit: boolean;
  findings: StegoFinding[];
  /** 清洗后的载荷；未命中时是原对象引用（不做无谓深拷贝） */
  payload: unknown;
}

const MAX_DEPTH = 48;

/**
 * 不透明字段：内容是密文或签名，只有客户端/上游能解。
 *
 * 扫它们没有任何意义，而一旦被「命中」改写，损坏是静默且致命的：
 *   encrypted_content / encrypted_index —— web search 结果与引用，客户端解不开
 *   encrypted_stdout                     —— 代码执行结果
 *   signature                            —— thinking 块签名，对不上会被上游判成换了对话
 * 所以这几个键直接原样带走，连遍历都不遍历。
 */
const OPAQUE_KEYS: ReadonlySet<string> = new Set([
  "encrypted_content",
  "encrypted_index",
  "encrypted_stdout",
  "signature"
]);

/**
 * 扫描请求载荷。命中时按写时复制重建，未命中的分支保持原引用，
 * 避免大请求体被整体深拷贝。
 */
export function scanPayload(value: unknown): PayloadScanResult {
  const findings: StegoFinding[] = [];

  function walk(node: unknown, depth: number): unknown {
    if (depth > MAX_DEPTH) return node;

    if (typeof node === "string") {
      const r = scanStego(node);
      if (r.hit) {
        for (const f of r.findings) findings.push(f);
        return r.cleaned;
      }
      return node;
    }

    if (Array.isArray(node)) {
      let changed = false;
      const out = new Array<unknown>(node.length);
      for (let i = 0; i < node.length; i++) {
        const next = walk(node[i], depth + 1);
        out[i] = next;
        if (next !== node[i]) changed = true;
      }
      return changed ? out : node;
    }

    if (node && typeof node === "object") {
      let changed = false;
      const src = node as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(src)) {
        if (OPAQUE_KEYS.has(k)) {
          out[k] = src[k];
          continue;
        }
        const next = walk(src[k], depth + 1);
        out[k] = next;
        if (next !== src[k]) changed = true;
      }
      return changed ? out : node;
    }

    return node;
  }

  const payload = walk(value, 0);
  return { hit: findings.length > 0, findings, payload };
}

/** 把命中项拼成给人看的一句话，用于拦截响应体 */
export function describeFindings(findings: StegoFinding[]): string {
  if (!findings.length) return "";
  const seen = new Set<string>();
  const parts: string[] = [];
  for (const f of findings) {
    const key = f.kind + ":" + f.codepoint;
    if (seen.has(key)) continue;
    seen.add(key);
    if (f.kind === "apostrophe") parts.push("Today 后的撇号是 " + f.meaning);
    else if (f.kind === "date_separator") parts.push(f.meaning);
    else parts.push("文本中含 " + f.meaning);
  }
  return parts.join("；");
}
