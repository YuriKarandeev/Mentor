/**
 * Генерация PWA-иконок без внешних зависимостей.
 * Рисуем растровую картинку (скруглённый квадрат + символ «шапочка выпускника»)
 * и кодируем в PNG вручную (zlib + CRC32).
 *
 * Запуск: npm run icons
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const ACCENT = [79, 70, 229];
const WHITE = [255, 255, 255];
const SS = 3; // суперсэмплинг 3x3 на пиксель

const crcTable = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function encodePng(size, rgba) {
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y += 1) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

const inRoundedRect = (x, y, x0, y0, w, h, r) => {
  if (x < x0 || y < y0 || x > x0 + w || y > y0 + h) return false;
  const rr = Math.min(r, w / 2, h / 2);
  const cx = Math.min(Math.max(x, x0 + rr), x0 + w - rr);
  const cy = Math.min(Math.max(y, y0 + rr), y0 + h - rr);
  return (x - cx) ** 2 + (y - cy) ** 2 <= rr * rr + 1e-9;
};

const inPolygon = (x, y, pts) => {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i, i += 1) {
    const [xi, yi] = pts[i];
    const [xj, yj] = pts[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
};

/** Символ: шапочка выпускника + подставка. Координаты в долях от 1. */
function symbolMasks(x, y) {
  const cap = [
    [0.5, 0.235],
    [0.845, 0.4],
    [0.5, 0.565],
    [0.155, 0.4]
  ];
  const base = inRoundedRect(x, y, 0.335, 0.5, 0.33, 0.17, 0.05);
  const tassel = (x - 0.83) ** 2 + (y - 0.47) ** 2 <= 0.028 ** 2;
  return inPolygon(x, y, cap) || base || tassel;
}

function render(size, { maskable = false } = {}) {
  const buf = Buffer.alloc(size * size * 4);
  const radius = maskable ? 0 : 0.225;
  const pad = maskable ? 0.1 : 0.06;
  const scale = 1 - pad * 2;

  for (let py = 0; py < size; py += 1) {
    for (let px = 0; px < size; px += 1) {
      let bgHits = 0;
      let fgHits = 0;
      for (let sy = 0; sy < SS; sy += 1) {
        for (let sx = 0; sx < SS; sx += 1) {
          const x = (px + (sx + 0.5) / SS) / size;
          const y = (py + (sy + 0.5) / SS) / size;
          if (inRoundedRect(x, y, 0, 0, 1, 1, radius)) bgHits += 1;
          const cx = (x - 0.5) / scale + 0.5;
          const cy = (y - 0.5) / scale + 0.5;
          if (symbolMasks(cx, cy)) fgHits += 1;
        }
      }
      const total = SS * SS;
      const alpha = bgHits / total;
      const fg = fgHits / total;
      const i = (py * size + px) * 4;
      const r = ACCENT[0] * (1 - fg) + WHITE[0] * fg;
      const g = ACCENT[1] * (1 - fg) + WHITE[1] * fg;
      const b = ACCENT[2] * (1 - fg) + WHITE[2] * fg;
      buf[i] = Math.round(r);
      buf[i + 1] = Math.round(g);
      buf[i + 2] = Math.round(b);
      buf[i + 3] = Math.round(alpha * 255);
    }
  }
  return encodePng(size, buf);
}

const outDir = path.join('public', 'icons');
fs.mkdirSync(outDir, { recursive: true });

const targets = [
  { file: 'icon-192.png', size: 192, maskable: false },
  { file: 'icon-512.png', size: 512, maskable: false },
  { file: 'icon-maskable-512.png', size: 512, maskable: true },
  { file: 'apple-touch-icon.png', size: 180, maskable: true }
];

for (const t of targets) {
  const png = render(t.size, { maskable: t.maskable });
  fs.writeFileSync(path.join(outDir, t.file), png);
  console.log('written', path.join(outDir, t.file), png.length + ' bytes');
}
