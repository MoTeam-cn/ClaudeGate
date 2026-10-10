/**
 * 服务端分类器（auto mode）的往返观测。
 *
 * 背景：Claude Code 的 auto mode 把「这条命令能不能跑」交给服务端分类器，
 * 做法是在请求内容块上挂 `safeguards` 字段，等响应把 `safeguard_results` 带回来。
 * 二进制里的判定原话（原文引用）：
 *   [server-classifier] a completed response carried no classification result
 *   (no safeguard_results); assuming something on the path to the API dropped it,
 *   so auto mode classifies locally for the rest of this session
 * 少了这一个键，它就认定路上有人丢了东西，退回本地分类，并弹那条
 * 「your requests go through <网关>, which isn't compatible with this update」。
 *
 * 网关本身是原样转发的（见 test/passthrough.test.ts 的 19 项往返验证），
 * 所以这里的作用不是修，而是把「到底断在哪一跳」摆进运行日志：
 * 请求带了、响应没回，问题就在网关之后（中转站 / 落地机 / 上游本身）。
 */

const RESULT_KEY = "safeguard_results";
const ASK_KEY = "safeguards";
const MAX_DEPTH = 32;

function findKey(node: unknown, key: string, depth: number): boolean {
  if (depth > MAX_DEPTH || node === null || typeof node !== "object") return false;
  if (Array.isArray(node)) {
    for (const item of node) if (findKey(item, key, depth + 1)) return true;
    return false;
  }
  const rec = node as Record<string, unknown>;
  const own = rec[key];
  if (own !== undefined && own !== null) return true;
  for (const k of Object.keys(rec)) if (findKey(rec[k], key, depth + 1)) return true;
  return false;
}

/** 请求体里有没有要求服务端分类。safeguards 可能挂在任意一层内容块上 */
export function askedForClassifier(body: unknown): boolean {
  return findKey(body, ASK_KEY, 0);
}

/** 非流式响应里有没有把结果带回来 */
export function answeredByClassifier(parsed: unknown): boolean {
  return findKey(parsed, RESULT_KEY, 0);
}

/**
 * 流式响应里找 safeguard_results。
 * 键名可能被分片切开，所以留一小段 carry 再拼上下一片 —— 不然恰好跨边界时会漏判。
 */
export function createClassifierSniffer() {
  let carry = "";
  let seen = false;
  return {
    tap(chunk: Buffer): void {
      if (seen) return;
      const text = carry + chunk.toString("latin1");
      if (text.indexOf(RESULT_KEY) !== -1) {
        seen = true;
        carry = "";
        return;
      }
      carry = text.slice(-(RESULT_KEY.length * 2));
    },
    saw(): boolean {
      return seen;
    }
  };
}

export interface ClassifierLog {
  info(message: string): void;
  warn(message: string): void;
}

/**
 * 只在「客户端确实要了服务端分类」时才说话 —— 否则每一轮都刷一行没有意义的日志。
 * 没要过就一个字都不打。
 */
export function logClassifier(log: ClassifierLog, id: string, asked: boolean, answered: boolean): void {
  if (!asked) return;
  if (answered) {
    log.info("[" + id + "] 服务端分类器：请求带了 safeguards，响应回了 safeguard_results（往返完好）");
    return;
  }
  log.warn(
    "[" + id + "] 服务端分类器：请求带了 safeguards，但响应里没有 safeguard_results —— " +
      "断点在网关之后的某一跳（中转站 / 落地机 / 上游本身），不是本网关丢的。" +
      "Claude Code 会因此弹「网关不兼容 auto mode」并退回本地分类。"
  );
}
