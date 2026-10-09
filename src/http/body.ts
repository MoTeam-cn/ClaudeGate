import type { IncomingMessage } from "node:http";

export function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;

    function onData(c: Buffer): void {
      size += c.length;
      if (size > limit) {
        cleanup();
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    }
    function onEnd(): void {
      cleanup();
      resolve(Buffer.concat(chunks));
    }
    function onError(err: Error): void {
      cleanup();
      reject(err);
    }
    function cleanup(): void {
      req.off("data", onData);
      req.off("end", onEnd);
      req.off("error", onError);
    }

    req.on("data", onData);
    req.on("end", onEnd);
    req.on("error", onError);
  });
}

export async function readJson(req: IncomingMessage, limit: number): Promise<unknown> {
  const buf = await readBody(req, limit);
  const text = buf.toString("utf8");
  if (!text.trim()) return {};
  return JSON.parse(text) as unknown;
}

export async function readForm(req: IncomingMessage, limit: number): Promise<URLSearchParams> {
  const buf = await readBody(req, limit);
  return new URLSearchParams(buf.toString("utf8"));
}
