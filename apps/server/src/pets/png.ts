import { deflateSync, inflateSync } from "node:zlib";

/**
 * Just enough PNG to tidy a pet picture without an image library: decode 8-bit, non-interlaced
 * PNGs (what image models send), clear a plain background so the pet stands on its own, shrink
 * it to the size the app shows, and encode it again as RGBA.
 */

export interface Rgba {
  width: number;
  height: number;
  /** width * height * 4 bytes, straight (not premultiplied) alpha. */
  data: Uint8Array;
}

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export function isPng(bytes: Uint8Array): boolean {
  return bytes.length > 8 && Buffer.from(bytes.subarray(0, 8)).equals(SIGNATURE);
}

/** null when the PNG uses a layout this decoder does not handle (the picture is kept as is). */
export function decodePng(bytes: Uint8Array): Rgba | null {
  if (!isPng(bytes)) return null;
  const buf = Buffer.from(bytes);
  let pos = 8;
  let width = 0;
  let height = 0;
  let colorType = -1;
  let palette: Buffer | null = null;
  let transparency: Buffer | null = null;
  const idat: Buffer[] = [];
  while (pos + 8 <= buf.length) {
    const length = buf.readUInt32BE(pos);
    const type = buf.toString("latin1", pos + 4, pos + 8);
    const body = buf.subarray(pos + 8, pos + 8 + length);
    pos += 12 + length;
    if (type === "IHDR") {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      const depth = body[8];
      colorType = body[9] ?? -1;
      const interlace = body[12];
      if (depth !== 8 || interlace !== 0) return null;
    } else if (type === "PLTE") palette = body;
    else if (type === "tRNS") transparency = body;
    else if (type === "IDAT") idat.push(body);
    else if (type === "IEND") break;
  }
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
  if (!channels || !width || !height || width * height > 4096 * 4096) return null;
  if (colorType === 3 && !palette) return null;
  let raw: Buffer;
  try {
    raw = inflateSync(Buffer.concat(idat));
  } catch {
    return null;
  }
  const stride = width * channels;
  if (raw.length < (stride + 1) * height) return null;
  const pixels = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const out = pixels.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? pixels.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? (out[x - channels] ?? 0) : 0;
      const b = prev ? (prev[x] ?? 0) : 0;
      const c = prev && x >= channels ? (prev[x - channels] ?? 0) : 0;
      const v = line[x] ?? 0;
      let r: number;
      switch (filter) {
        case 0:
          r = v;
          break;
        case 1:
          r = v + a;
          break;
        case 2:
          r = v + b;
          break;
        case 3:
          r = v + ((a + b) >> 1);
          break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          r = v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
          break;
        }
        default:
          return null;
      }
      out[x] = r & 0xff;
    }
  }
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const s = i * channels;
    const d = i * 4;
    if (colorType === 6) {
      data.set(pixels.subarray(s, s + 4), d);
    } else if (colorType === 2) {
      data.set(pixels.subarray(s, s + 3), d);
      data[d + 3] = 255;
    } else if (colorType === 4) {
      const g = pixels[s] ?? 0;
      data[d] = g;
      data[d + 1] = g;
      data[d + 2] = g;
      data[d + 3] = pixels[s + 1] ?? 255;
    } else if (colorType === 0) {
      const g = pixels[s] ?? 0;
      data[d] = g;
      data[d + 1] = g;
      data[d + 2] = g;
      data[d + 3] = 255;
    } else {
      const index = pixels[s] ?? 0;
      const p = palette as Buffer;
      data[d] = p[index * 3] ?? 0;
      data[d + 1] = p[index * 3 + 1] ?? 0;
      data[d + 2] = p[index * 3 + 2] ?? 0;
      data[d + 3] = transparency?.[index] ?? 255;
    }
  }
  return { width, height, data };
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes: Buffer): number {
  let c = 0xffffffff;
  for (const b of bytes) c = (CRC_TABLE[(c ^ b) & 0xff] ?? 0) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, body: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(body.length, 0);
  head.write(type, 4, "latin1");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])), 0);
  return Buffer.concat([head, body, crc]);
}

export function encodePng(image: Rgba): Buffer {
  const { width, height, data } = image;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    Buffer.from(data.buffer, data.byteOffset + y * width * 4, width * 4).copy(
      raw,
      y * (width * 4 + 1) + 1,
    );
  }
  return Buffer.concat([
    SIGNATURE,
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** Shrink so the longer side is at most `max`, averaging pixels (alpha-weighted). */
export function shrink(image: Rgba, max: number): Rgba {
  const scale = Math.max(image.width, image.height) / max;
  if (scale <= 1) return image;
  const width = Math.max(1, Math.round(image.width / scale));
  const height = Math.max(1, Math.round(image.height / scale));
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    const y0 = Math.floor(y * scale);
    const y1 = Math.min(image.height, Math.max(y0 + 1, Math.floor((y + 1) * scale)));
    for (let x = 0; x < width; x++) {
      const x0 = Math.floor(x * scale);
      const x1 = Math.min(image.width, Math.max(x0 + 1, Math.floor((x + 1) * scale)));
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let n = 0;
      for (let sy = y0; sy < y1; sy++) {
        for (let sx = x0; sx < x1; sx++) {
          const i = (sy * image.width + sx) * 4;
          const alpha = image.data[i + 3] ?? 0;
          r += (image.data[i] ?? 0) * alpha;
          g += (image.data[i + 1] ?? 0) * alpha;
          b += (image.data[i + 2] ?? 0) * alpha;
          a += alpha;
          n++;
        }
      }
      const d = (y * width + x) * 4;
      if (a > 0) {
        data[d] = Math.round(r / a);
        data[d + 1] = Math.round(g / a);
        data[d + 2] = Math.round(b / a);
      }
      data[d + 3] = Math.round(a / n);
    }
  }
  return { width, height, data };
}

/**
 * Make a plain background see-through: when the corners share one color, every pixel of about
 * that color connected to the edge is cleared, with a soft fringe. Pictures that already have
 * a transparent background, or a busy one, are left alone.
 */
export function clearBackground(image: Rgba): Rgba {
  const { width, height, data } = image;
  const at = (x: number, y: number) => (y * width + x) * 4;
  const corners = [at(0, 0), at(width - 1, 0), at(0, height - 1), at(width - 1, height - 1)];
  if (corners.some((i) => (data[i + 3] ?? 0) < 16)) return image;
  const avg = [0, 1, 2].map((c) => corners.reduce((s, i) => s + (data[i + c] ?? 0), 0) / 4);
  const distance = (i: number) =>
    Math.hypot(
      (data[i] ?? 0) - (avg[0] ?? 0),
      (data[i + 1] ?? 0) - (avg[1] ?? 0),
      (data[i + 2] ?? 0) - (avg[2] ?? 0),
    );
  if (corners.some((i) => distance(i) > 40)) return image;
  const HARD = 36;
  const SOFT = 72;
  const out = new Uint8Array(data);
  const seen = new Uint8Array(width * height);
  const stack: number[] = [];
  for (let x = 0; x < width; x++) stack.push(x, (height - 1) * width + x);
  for (let y = 0; y < height; y++) stack.push(y * width, y * width + width - 1);
  while (stack.length) {
    const p = stack.pop() as number;
    if (seen[p]) continue;
    seen[p] = 1;
    const i = p * 4;
    const d = distance(i);
    if (d >= SOFT) continue;
    if (d <= HARD) out[i + 3] = 0;
    else {
      // The fringe fades out and stops the fill, so outlines stay crisp.
      out[i + 3] = Math.round(((d - HARD) / (SOFT - HARD)) * (data[i + 3] ?? 255));
      continue;
    }
    const x = p % width;
    const y = (p - x) / width;
    if (x > 0) stack.push(p - 1);
    if (x < width - 1) stack.push(p + 1);
    if (y > 0) stack.push(p - width);
    if (y < height - 1) stack.push(p + width);
  }
  return { width, height, data: out };
}

/** The size pets are stored at: crisp at the largest size the app shows, on 3x screens. */
export const PET_PIXELS = 384;

/** A picture from an image model, ready to store: background cleared and shrunk (PNG only). */
export function tidyPetPicture(bytes: Uint8Array): Uint8Array {
  const image = decodePng(bytes);
  if (!image) return bytes;
  return encodePng(shrink(clearBackground(image), PET_PIXELS));
}
