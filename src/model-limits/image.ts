/** 图片计价：从 base64 头部读宽高，按 宽*高/750 折 token，再夹到上限。零依赖。 */

export const DEFAULT_IMAGE_TOKENS = 1600;

/** 像素到 token 的除数。Anthropic 文档口径：约 750 像素一个 token */
const PIXELS_PER_TOKEN = 750;

/**
 * 从 base64 图片里读宽高。只认 PNG / JPEG / GIF —— 这三种覆盖绝大多数情况。
 * 只解前 2KB，不整张解码。读不出来返回 null。
 */
export function readImageSize(b64: string): { width: number; height: number } | null {
  let head: Buffer;
  try {
    head = Buffer.from(b64.slice(0, 2048), "base64");
  } catch {
    return null;
  }
  /* 各格式需要的最小长度不同，逐个校验，别用一个大阈值把短的挡掉 */
  if (head.length < 10) return null;

  /* PNG：签名 8 字节，接着是 IHDR —— 宽高在偏移 16 / 20，大端 */
  if (head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47) {
    if (head.length < 24) return null;
    const w = head.readUInt32BE(16);
    const h = head.readUInt32BE(20);
    return w > 0 && h > 0 ? { width: w, height: h } : null;
  }

  /* GIF：GIF87a / GIF89a，宽高在偏移 6 / 8，小端 */
  if (head[0] === 0x47 && head[1] === 0x49 && head[2] === 0x46) {
    const w = head.readUInt16LE(6);
    const h = head.readUInt16LE(8);
    return w > 0 && h > 0 ? { width: w, height: h } : null;
  }

  /* JPEG：从 SOI 往后扫段，找到 SOFn 就是尺寸 */
  if (head[0] === 0xff && head[1] === 0xd8) {
    let i = 2;
    while (i + 9 < head.length) {
      if (head[i] !== 0xff) { i++; continue; }
      const marker = head[i + 1] ?? 0;
      /* 填充字节 */
      if (marker === 0xff) { i++; continue; }
      /* SOF0..SOF15，但 C4(DHT) / C8(JPG) / CC(DAC) 不是 */
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        const h = head.readUInt16BE(i + 5);
        const w = head.readUInt16BE(i + 7);
        return w > 0 && h > 0 ? { width: w, height: h } : null;
      }
      const len = head.readUInt16BE(i + 2);
      if (len < 2) break;
      i += 2 + len;
    }
    return null;
  }

  return null;
}

/** 一张图值多少 token：按像素算，夹到上限 */
export function imageTokens(b64: string | null, cap: number): number {
  if (!b64) return cap;
  const size = readImageSize(b64);
  if (!size) return cap;
  const byPixels = Math.ceil((size.width * size.height) / PIXELS_PER_TOKEN);
  return Math.max(1, Math.min(cap, byPixels));
}

/**
 * 取出图片块里的 base64。Anthropic 是 {type:image,source:{type:base64,data}}，
 * OpenAI 是 {type:image_url,image_url:{url:"data:image/png;base64,..."}}。
 * 不是 base64 图（比如 http URL）返回 null。
 */
export function imageBase64(o: Record<string, unknown>): string | null {
  if (o.type === "image_url") {
    const iu = o.image_url;
    if (iu && typeof iu === "object") {
      const url = (iu as Record<string, unknown>).url;
      if (typeof url === "string") {
        const i = url.indexOf("base64,");
        if (i !== -1) return url.slice(i + 7);
      }
    }
    return null;
  }
  const src = o.source;
  if (src && typeof src === "object") {
    const s = src as Record<string, unknown>;
    if (s.type === "base64" && typeof s.data === "string") return s.data;
  }
  return null;
}

/** 是不是一个图片块 */
export function isImageBlock(o: Record<string, unknown>): boolean {
  if (o.type === "image" || o.type === "image_url") return true;
  const src = o.source;
  if (src && typeof src === "object") {
    const t = (src as Record<string, unknown>).type;
    if (t === "base64" || t === "url") return true;
  }
  return false;
}

/** 纯文本的字符构成估算：ASCII 约 4 字符一个 token，非 ASCII 约 1.5 字符一个 */

