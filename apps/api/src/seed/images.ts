import { deflateSync } from 'node:zlib';

/**
 * Tiny PNG writer for demo data and tests: on-site "photos" (a schematic building, equipment or
 * information panel) and a handwritten-looking signature. No image library needed.
 */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

type RGB = [number, number, number];

class Canvas {
  readonly px: Uint8Array;
  constructor(
    readonly w: number,
    readonly h: number,
    bg: RGB = [255, 255, 255],
  ) {
    this.px = new Uint8Array(w * h * 3);
    for (let i = 0; i < w * h; i++) this.px.set(bg, i * 3);
  }
  set(x: number, y: number, c: RGB) {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    this.px.set(c, (Math.floor(y) * this.w + Math.floor(x)) * 3);
  }
  rect(x: number, y: number, w: number, h: number, c: RGB) {
    for (let j = Math.max(0, y); j < Math.min(this.h, y + h); j++) for (let i = Math.max(0, x); i < Math.min(this.w, x + w); i++) this.set(i, j, c);
  }
  dot(x: number, y: number, r: number, c: RGB) {
    for (let j = -r; j <= r; j++) for (let i = -r; i <= r; i++) if (i * i + j * j <= r * r) this.set(x + i, y + j, c);
  }
  png(): Buffer {
    const raw = Buffer.alloc((this.w * 3 + 1) * this.h);
    for (let y = 0; y < this.h; y++) {
      raw[y * (this.w * 3 + 1)] = 0;
      Buffer.from(this.px.buffer, y * this.w * 3, this.w * 3).copy(raw, y * (this.w * 3 + 1) + 1);
    }
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(this.w, 0);
    ihdr.writeUInt32BE(this.h, 4);
    ihdr[8] = 8; // bit depth
    ihdr[9] = 2; // truecolour
    return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
  }
}

function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

const mix = (a: RGB, b: RGB, t: number): RGB => [0, 1, 2].map((i) => Math.round(a[i]! + (b[i]! - a[i]!) * t)) as RGB;

/** A schematic on-site photo: sky, ground and a subject depending on `kind`. */
export function demoPhoto(kind: 'building' | 'equipment' | 'panel' | 'works', seed = 1, w = 640, h = 480): Buffer {
  const r = rng(seed);
  const c = new Canvas(w, h);
  const horizon = Math.round(h * (0.55 + r() * 0.1));
  for (let y = 0; y < horizon; y++) c.rect(0, y, w, 1, mix([120, 170, 220], [205, 225, 240], y / horizon));
  for (let y = horizon; y < h; y++) c.rect(0, y, w, 1, mix([125, 150, 95], [95, 115, 70], (y - horizon) / (h - horizon)));
  for (let i = 0; i < 4; i++) c.dot(Math.round(r() * w), Math.round(r() * horizon * 0.5), 18 + Math.round(r() * 14), [240, 244, 248]);
  if (kind === 'building' || kind === 'works') {
    const bw = Math.round(w * 0.55);
    const bh = Math.round(h * 0.38);
    const bx = Math.round(w * 0.2 + r() * w * 0.1);
    const by = horizon - bh;
    c.rect(bx, by, bw, bh, kind === 'works' ? [180, 160, 130] : [215, 205, 190]);
    c.rect(bx - 10, by - 18, bw + 20, 18, [150, 70, 60]);
    for (let i = 0; i < 5; i++) for (let j = 0; j < 2; j++) c.rect(bx + 20 + i * Math.round((bw - 40) / 5), by + 25 + j * Math.round(bh / 2.4), 34, 40, [90, 130, 170]);
    c.rect(bx + Math.round(bw / 2) - 22, horizon - 70, 44, 70, [110, 80, 60]);
    if (kind === 'works') for (let k = 0; k < 6; k++) c.rect(bx - 30 + k * 12, by - 60 + (k % 2) * 6, 4, bh + 60, [200, 140, 40]);
  } else if (kind === 'equipment') {
    c.rect(0, 0, w, horizon, [225, 228, 232]);
    c.rect(0, horizon, w, h - horizon, [170, 175, 180]);
    const mx = Math.round(w * 0.22);
    c.rect(mx, horizon - 190, Math.round(w * 0.5), 190, [70, 110, 160]);
    c.rect(mx + 20, horizon - 170, 120, 80, [30, 40, 50]);
    c.rect(mx + 30, horizon - 160, 100, 60, [120, 200, 230]);
    for (let i = 0; i < 4; i++) c.dot(mx + 200 + i * 40, horizon - 130, 10, [230, 60, 50]);
    c.rect(mx + 180, horizon - 60, 120, 18, [240, 240, 240]);
  } else {
    // information and publicity panel with the EU flag colours
    c.rect(Math.round(w * 0.5), horizon - 210, 8, 210, [90, 90, 90]);
    c.rect(Math.round(w * 0.5) + 150, horizon - 210, 8, 210, [90, 90, 90]);
    const px = Math.round(w * 0.5) - 40;
    c.rect(px, horizon - 330, 240, 150, [250, 250, 250]);
    c.rect(px + 10, horizon - 320, 60, 40, [0, 51, 153]);
    for (let i = 0; i < 12; i++) c.dot(px + 40 + Math.round(14 * Math.cos((i * Math.PI) / 6)), horizon - 300 + Math.round(14 * Math.sin((i * Math.PI) / 6)), 2, [255, 204, 0]);
    for (let l = 0; l < 6; l++) c.rect(px + 80, horizon - 315 + l * 20, 140 - (l % 3) * 20, 8, [60, 60, 70]);
  }
  return c.png();
}

/** A handwriting-like signature: a few connected loops and a closing underline. */
export function demoSignature(seed = 1, w = 520, h = 200): Buffer {
  const r = rng(seed);
  const c = new Canvas(w, h);
  const ink: RGB = [20, 40, 110];
  let x = 40;
  let y = h * 0.55;
  const loops = 4 + Math.floor(r() * 3);
  for (let l = 0; l < loops; l++) {
    const rad = 18 + r() * 22;
    const cx = x + rad;
    for (let t = 0; t <= Math.PI * 2.2; t += 0.02) {
      c.dot(cx - rad * Math.cos(t) + t * 6, y - rad * 1.4 * Math.sin(t), 2, ink);
    }
    x = cx + rad * 0.6 + 6;
    y = h * (0.45 + r() * 0.2);
  }
  for (let t = 0; t < 1; t += 0.002) c.dot(30 + t * (w - 70), h * 0.82 - Math.sin(t * Math.PI) * 10, 2, ink);
  return c.png();
}
