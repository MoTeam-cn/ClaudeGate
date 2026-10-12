import { PassThrough, Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { decodeStream, collect } from "./encoding.ts";
import { passThroughHeaders } from "./headers.ts";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { UpstreamResponse } from "../types.ts";

export interface PipeOptions {
  /** true 时先收全量再回写（需要改写响应体时用） */
  json?: boolean;
  /** 与 json 搭配：把解析后的对象转换成要发给客户端的内容 */
  transform?: (parsed: unknown) => unknown;
  /** 旁路观测每个分片（不改字节），用于从 SSE 里嗅探用量 */
  tap?: (chunk: Buffer) => void;
}

/**
 * SSE 用量嗅探器：只看不改，从数据流里抽出 input_tokens 与 output_tokens。
 * 保留一小段尾巴用于跨分片拼接，避免 JSON 被切断时漏读。
 */
export function createUsageSniffer(): {
  tap: (chunk: Buffer) => void;
  usage: () => {
    promptTokens: number;
    completionTokens: number;
    cacheCreationTokens: number;
    cacheReadTokens: number;
  };
} {
  let carry = "";
  let input = 0;
  let output = 0;
  let cacheCreate = 0;
  let cacheRead = 0;

  function tap(chunk: Buffer): void {
    const text = carry + chunk.toString("utf8");
    carry = text.length > 512 ? text.slice(-512) : text;

    /* 键名带引号前缀，所以 "input_tokens" 不会误配 "cache_creation_input_tokens" */
    if (input === 0) {
      const m = /"input_tokens"\s*:\s*(\d+)/.exec(text);
      if (m) input = Number(m[1]) || 0;
    }
    const mc = /"cache_creation_input_tokens"\s*:\s*(\d+)/.exec(text);
    if (mc) {
      const v = Number(mc[1]) || 0;
      if (v > cacheCreate) cacheCreate = v;
    }
    const mr = /"cache_read_input_tokens"\s*:\s*(\d+)/.exec(text);
    if (mr) {
      const v = Number(mr[1]) || 0;
      if (v > cacheRead) cacheRead = v;
    }

    const re = /"output_tokens"\s*:\s*(\d+)/g;
    let mm: RegExpExecArray | null;
    while ((mm = re.exec(text)) !== null) {
      const v = Number(mm[1]) || 0;
      if (v > output) output = v;
    }
  }

  return {
    tap,
    usage: () => ({
      promptTokens: input,
      completionTokens: output,
      cacheCreationTokens: cacheCreate,
      cacheReadTokens: cacheRead
    })
  };
}

/**
 * 上游在「流式响应的第一个字节之前」就断了。
 *
 * 抛出它的好处是：这时候我们还**没有**给客户端写过任何响应头，
 * 路由还能改成一个可重试的 5xx —— Claude Code 把 5xx 当可重试，会干净地重试。
 * 反过来如果先 writeHead 再断，它看到的是「200 + text/event-stream 却一个事件都没有」，
 * 于是报 "Streaming response ended before any complete data was received"，
 * 并退化成非流式重试。我们最不想要的就是那条路。
 */
export class StreamHeadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StreamHeadError";
  }
}

export interface PipeResult {
  /** 回给客户端的字节数 */
  bytes: number;
  /** 流被中途打断（上游断了或客户端先走了） */
  aborted: boolean;
  error?: string;
}

/**
 * 首字节闸门。
 *
 * 关键点：**不能「取到第一块就把 data 监听器摘掉、稍后再挂管道」**。
 * 摘监听器与挂管道之间隔着一次微任务，而同一个 socket 读循环里可能连着
 * 派发两三个 data —— 中间那几块会被静默丢掉。踩过一次：
 * 上游把 "event: message_start\n" 与 "data: {...}\n\n" 分两次写，
 * 第二块正好落进那个空档，于是 input_tokens / cache_* 全读成 0。
 *
 * 所以这里用一个 PassThrough 一直收着：先 write 再 resolve，
 * 下游接手的永远是同一个连续流。
 */
function gateFirstByte(stream: Readable): { head: Promise<Buffer | null>; out: PassThrough } {
  const out = new PassThrough();
  /*
   * 兜底监听，必须有。
   *
   * out 有可能在 pipeline 接手之前就出错（上游在首字节前断连，我们 destroy 它）。
   * 那一刻它身上没有任何 'error' 监听者，Node 会把它当未捕获异常直接抛出，
   * **把整个网关进程带走** —— 测试里真的复现过：一次代理抽风 = 所有在途请求一起断。
   * 真正的错误传播靠 head 这个 promise 和之后的 pipeline，这里只负责不让它崩。
   */
  out.on("error", () => undefined);
  let settled = false;
  let resolveHead: (v: Buffer | null) => void = () => undefined;
  let rejectHead: (e: Error) => void = () => undefined;
  const head = new Promise<Buffer | null>((res, rej) => {
    resolveHead = res;
    rejectHead = rej;
  });

  stream.on("data", (c: Buffer) => {
    out.write(c);
    if (!settled) {
      settled = true;
      resolveHead(c);
    }
  });
  stream.once("end", () => {
    if (!settled) {
      settled = true;
      resolveHead(null);
    }
    out.end();
  });
  stream.once("error", (e: Error) => {
    if (!settled) {
      settled = true;
      /* 首字节之前就断：对调用方来说和「空流」是同一类事，都还能重试 */
      rejectHead(new StreamHeadError("上游在流式响应首字节前中断：" + e.message));
    }
    out.destroy(e);
  });

  return { head, out };
}

/** 把上游响应回写客户端；非 json 模式走 stream.pipeline，天然带背压与连接回收 */
export async function pipeUpstream(
  res: ServerResponse,
  up: UpstreamResponse,
  opts: PipeOptions = {}
): Promise<PipeResult> {
  const headers = passThroughHeaders(up);

  const stream = decodeStream(up.raw, up.headers["content-encoding"]);

  if (!opts.json) {
    const tap = opts.tap;
    const tapOne = (chunk: Buffer): void => {
      if (!tap) return;
      try {
        tap(chunk);
      } catch {
        /* 观测失败不能影响转发 */
      }
    };

    /* 首字节闸门：拿到第一个字节之前绝不写响应头 */
    const gate = gateFirstByte(stream);
    const first = await gate.head;
    if (first === null) {
      throw new StreamHeadError("上游在流式响应的第一个字节之前就结束了（空流）");
    }

    /* 流式响应别让中间的反向代理攒够一批再吐 */
    if (String(headers["content-type"] ?? "").indexOf("text/event-stream") !== -1) {
      headers["x-accel-buffering"] = "no";
    }

    res.writeHead(up.status, headers);

    let bytes = 0;
    const count = new Transform({
      transform(chunk: Buffer, _enc, cb): void {
        bytes += chunk.length;
        tapOne(chunk);
        cb(null, chunk);
      }
    });

    try {
      await pipeline(gate.out, count, res);
      return { bytes, aborted: false };
    } catch (e) {
      /* 上游中途断了、或者客户端先走了。pipeline 已经把 res 销毁，
         这里只把原因交回去 —— 响应头早发出去了，没法再改成错误码。 */
      return { bytes, aborted: true, error: e instanceof Error ? e.message : String(e) };
    }
  }

  const buf = await collect(stream);
  if (opts.transform && up.status < 400) {
    let out: unknown;
    try {
      out = opts.transform(JSON.parse(buf.toString("utf8")));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      res.writeHead(502, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify({ error: { message: "translate failed: " + msg, type: "api_error" } }));
      return { bytes: 0, aborted: false };
    }
    const body = Buffer.from(JSON.stringify(out), "utf8");
    headers["content-type"] = "application/json; charset=utf-8";
    res.writeHead(up.status, headers);
    res.end(body);
    return { bytes: body.length, aborted: false };
  }

  res.writeHead(up.status, headers);
  res.end(buf);
  return { bytes: buf.length, aborted: false };
}
