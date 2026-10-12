import zlib from "node:zlib";
import { pipeline } from "node:stream/promises";
import { Transform, Readable, PassThrough } from "node:stream";
/**
 * 各压缩格式的魔数。brotli 没有魔数，只能按声明的来。
 */
const COMPRESS_MAGIC: Record<string, readonly (readonly number[])[]> = {
  gzip: [[0x1f, 0x8b]],
  zstd: [[0x28, 0xb5, 0x2f, 0xfd]],
  deflate: [[0x78, 0x01], [0x78, 0x9c], [0x78, 0xda], [0x78, 0x5e]]
};

/** 头几个字节像不像这个格式。null = 判不了（brotli 或字节还不够） */
function looksCompressed(enc: string, head: Buffer): boolean | null {
  const sigs = COMPRESS_MAGIC[enc];
  if (!sigs || !sigs.length) return null;
  for (const sig of sigs) {
    if (head.length < sig.length) continue;
    let same = true;
    for (let i = 0; i < sig.length; i++) {
      if (head[i] !== sig[i]) { same = false; break; }
    }
    if (same) return true;
  }
  return head.length >= 2 ? false : null;
}

function decompressorFor(enc: string): (() => NodeJS.ReadWriteStream) | null {
  if (enc === "gzip") return () => zlib.createGunzip();
  if (enc === "deflate") return () => zlib.createInflate();
  if (enc === "br") return () => zlib.createBrotliDecompress();
  const zstd = (zlib as unknown as { createZstdDecompress?: () => NodeJS.ReadWriteStream }).createZstdDecompress;
  if (enc === "zstd" && typeof zstd === "function") return () => zstd();
  return null;
}

/**
 * 按 content-encoding 解压上游响应体。
 *
 * 先嗅魔数再决定：声明的编码与实际字节对不上时直接透传，不要硬解。
 * 这是为了防止「body 已经被运行时解压过、头却还留着」这种情况 ——
 * 硬解会抛 incorrect header check，把整个请求打成 500。
 */
export function decodeStream(body: Readable, encoding?: string): Readable {
  const enc = String(encoding ?? "").toLowerCase();
  const found = decompressorFor(enc);
  if (!found) return body;
  /* 收窄一次：下面在嵌套函数里用，TS 会丢掉这里的判断 */
  const make: () => NodeJS.ReadWriteStream = found;

  const out = new PassThrough();
  const chunks: Buffer[] = [];
  let len = 0;
  let settled = false;

  const onBodyError = (e: Error): void => { out.destroy(e); };

  /** 拿定主意：解压还是透传 */
  function settle(): void {
    settled = true;
    body.removeListener("data", onData);
    body.removeListener("end", onEnd);
    const head = Buffer.concat(chunks);
    /* 只有明确「不像」才透传；判不了（brotli / 字节不够）就按声明的解 */
    if (looksCompressed(enc, head) === false) {
      if (head.length) out.write(head);
      body.pipe(out);
      return;
    }
    const dec = make();
    dec.on("error", onBodyError);
    dec.pipe(out);
    if (head.length) dec.write(head);
    body.pipe(dec);
  }

  function onData(c: Buffer): void {
    chunks.push(c);
    len += c.length;
    /* 魔数最长 4 字节，够了就定 */
    if (len >= 4) settle();
  }

  function onEnd(): void {
    if (settled) return;
    settled = true;
    const head = Buffer.concat(chunks);
    /* 空体：没有东西可解，硬解会 "unexpected end of file" */
    if (head.length === 0) {
      out.end();
      return;
    }
    if (looksCompressed(enc, head) === false) {
      out.end(head);
      return;
    }
    const dec = make();
    dec.on("error", onBodyError);
    dec.pipe(out);
    dec.end(head);
  }

  body.on("data", onData);
  body.once("end", onEnd);
  body.once("error", onBodyError);
  return out;
}

/** 收集流内容，带上限，避免异常上游把内存打满 */
export async function collect(stream: Readable, limit = 64 * 1024 * 1024): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > limit) throw new Error("upstream response too large");
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}
