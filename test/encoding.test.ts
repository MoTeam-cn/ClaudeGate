#!/usr/bin/env node
/**
 * 响应体解压的测试。
 * 运行：node test/encoding.test.ts
 *
 * 背景：fetch 通道的 body 已经被运行时解压过了，但 content-encoding 头还在。
 * 原样透传会让 decodeStream 拿着已解压的数据再解一次 gzip ——
 * 抛 incorrect header check，整个请求 500。
 */

import zlib from "node:zlib";
import { Readable } from "node:stream";
import { decodeStream } from "../src/upstream.ts";

let pass = 0;
let fail = 0;
const failures: string[] = [];

function ok(name: string, cond: boolean, detail?: string): void {
  if (cond) { pass++; console.log("  PASS  " + name); }
  else { fail++; const line = name + (detail ? " :: " + detail : ""); failures.push(line); console.log("  FAIL  " + line); }
}
function eq(name: string, actual: unknown, expected: unknown): void {
  ok(name, actual === expected, "expected=" + JSON.stringify(expected) + " actual=" + JSON.stringify(actual));
}

function collect(stream: Readable): Promise<{ text: string; err: string | null }> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    stream.on("data", (c: Buffer) => chunks.push(c));
    stream.on("end", () => resolve({ text: Buffer.concat(chunks).toString("utf8"), err: null }));
    stream.on("error", (e: Error) => resolve({ text: Buffer.concat(chunks).toString("utf8"), err: e.message }));
  });
}

const PLAIN = JSON.stringify({ hello: "世界", n: 42 });

/* ============ A. 真压缩要解开 ============ */
console.log("\n=== A. 真压缩 ===");
{
  const gz = zlib.gzipSync(Buffer.from(PLAIN, "utf8"));
  const r = await collect(decodeStream(Readable.from([gz]), "gzip"));
  eq("gzip 解开", r.text, PLAIN);
  eq("gzip 不报错", r.err, null);
}
{
  const df = zlib.deflateSync(Buffer.from(PLAIN, "utf8"));
  const r = await collect(decodeStream(Readable.from([df]), "deflate"));
  eq("deflate 解开", r.text, PLAIN);
}
{
  const br = zlib.brotliCompressSync(Buffer.from(PLAIN, "utf8"));
  const r = await collect(decodeStream(Readable.from([br]), "br"));
  eq("brotli 解开（没有魔数，按声明的来）", r.text, PLAIN);
}
{
  /* 分片喂：魔数要跨 chunk 也能认出来 */
  const gz = zlib.gzipSync(Buffer.from(PLAIN, "utf8"));
  const r = await collect(decodeStream(Readable.from([gz.subarray(0, 1), gz.subarray(1)]), "gzip"));
  eq("分片也能解", r.text, PLAIN);
}

/* ============ B. 声明的编码与实际不符要透传 ============ */
console.log("\n=== B. 标错编码（就是这次踩的坑） ===");
{
  const r = await collect(decodeStream(Readable.from([Buffer.from(PLAIN, "utf8")]), "gzip"));
  eq("明文标 gzip 不炸", r.err, null);
  eq("明文原样透传", r.text, PLAIN);
}
{
  const r = await collect(decodeStream(Readable.from([Buffer.from(PLAIN, "utf8")]), "deflate"));
  eq("明文标 deflate 也不炸", r.err, null);
  eq("同样原样透传", r.text, PLAIN);
}
{
  const r = await collect(decodeStream(Readable.from([Buffer.from(PLAIN, "utf8")]), "zstd"));
  eq("明文标 zstd 也不炸", r.err, null);
  eq("同样原样透传", r.text, PLAIN);
}

/* ============ C. 没声明编码 ============ */
console.log("\n=== C. 没有编码 ===");
{
  const r = await collect(decodeStream(Readable.from([Buffer.from(PLAIN, "utf8")])));
  eq("直接透传", r.text, PLAIN);
}
{
  const r = await collect(decodeStream(Readable.from([Buffer.from(PLAIN, "utf8")]), "identity"));
  eq("identity 也直接透传", r.text, PLAIN);
}

/* ============ D. 空体 ============ */
console.log("\n=== D. 空体 ===");
{
  const r = await collect(decodeStream(Readable.from([]), "gzip"));
  eq("空体标 gzip 不炸", r.err, null);
  eq("空体还是空", r.text, "");
}

/* ============ E. fetch 通道必须剥掉 content-encoding ============ */
console.log("\n=== E. fetch 通道 ===");
{
  const fs = await import("node:fs");
  const path = await import("node:path");
  const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
  const src = fs.readFileSync(path.join(here, "..", "src", "net", "fetch.ts"), "utf8");
  ok("剥掉 content-encoding", src.indexOf('delete out["content-encoding"]') !== -1);
  ok("剥掉 content-length", src.indexOf('delete out["content-length"]') !== -1);
}

console.log("\n================================");
console.log("  PASS " + pass + "   FAIL " + fail);
if (fail) { console.log("  失败项："); for (const f of failures) console.log("   - " + f); }
console.log("================================");
if (fail) process.exit(1);
