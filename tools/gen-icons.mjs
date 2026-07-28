// Génère icons/icon-{48,96,128,256}.png depuis le design de icons/icon.svg
// (dégradé bleu→violet, deux vagues « sonar », flèche). Aucune dépendance.
// Usage : node tools/gen-icons.mjs

import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "icons");
const SIZES = [48, 96, 128, 256];
const SS = 4; // facteur de suréchantillonnage (anticrénelage)

/* ---------- Design, en unités 96×96 (identique au viewBox du SVG) ---------- */

const C1 = [0x12, 0x6e, 0xd3]; // bleu
const C2 = [0x7c, 0x3a, 0xed]; // violet
const RADIUS = 20;

const WAVES = [
  { yc: 30, alpha: 1 },
  { yc: 48, alpha: 0.65 },
];
const WX0 = 17;
const WX1 = 79;
const WAVE_AMP = 7;
const WAVE_PERIOD = 62;
const STROKE = 7;

const SHAFT = { x0: 26, x1: 60, y: 72 };
const HEAD = { x0: 60, y0: 61, y1: 83, tipX: 76, tipY: 72 };

function roundedRectDist(x, y) {
  const dx = Math.max(Math.abs(x - 48) - (48 - RADIUS), 0);
  const dy = Math.max(Math.abs(y - 48) - (48 - RADIUS), 0);
  return Math.hypot(dx, dy) - RADIUS;
}

const waveY = (yc, x) => yc - WAVE_AMP * Math.sin(((x - WX0) / WAVE_PERIOD) * 2 * Math.PI);

function waveCover(x, y, yc) {
  const cx = Math.min(Math.max(x, WX0), WX1);
  return Math.hypot(x - cx, y - waveY(yc, cx)) <= STROKE / 2;
}

function capsuleCover(x, y) {
  const cx = Math.min(Math.max(x, SHAFT.x0), SHAFT.x1);
  return Math.hypot(x - cx, y - SHAFT.y) <= STROKE / 2;
}

function triangleCover(x, y) {
  const { x0, y0, y1, tipX, tipY } = HEAD;
  if (x < x0 || x > tipX) return false;
  const t = (x - x0) / (tipX - x0);
  const top = y0 + (tipY - y0) * t;
  const bottom = y1 + (tipY - y1) * t;
  return y >= top && y <= bottom;
}

// Couleur prémultipliée [r,g,b,a] (0..1) au point (x,y) de l'espace 96×96.
function sample(x, y) {
  if (roundedRectDist(x, y) > 0) return [0, 0, 0, 0];
  const t = Math.min(Math.max((x + y) / 192, 0), 1);
  let r = (C1[0] + (C2[0] - C1[0]) * t) / 255;
  let g = (C1[1] + (C2[1] - C1[1]) * t) / 255;
  let b = (C1[2] + (C2[2] - C1[2]) * t) / 255;
  let fg = 0;
  for (const w of WAVES) if (waveCover(x, y, w.yc)) fg = Math.max(fg, w.alpha);
  if (capsuleCover(x, y) || triangleCover(x, y)) fg = 1;
  if (fg > 0) {
    r += (1 - r) * fg;
    g += (1 - g) * fg;
    b += (1 - b) * fg;
  }
  return [r, g, b, 1];
}

/* ---------- Rendu ---------- */

function render(size) {
  const rgba = Buffer.alloc(size * size * 4);
  const step = 96 / (size * SS);
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const x = (px * SS + sx + 0.5) * step;
          const y = (py * SS + sy + 0.5) * step;
          const [sr, sg, sb, sa] = sample(x, y);
          r += sr * sa; g += sg * sa; b += sb * sa; a += sa;
        }
      }
      const n = SS * SS;
      const alpha = a / n;
      const i = (py * size + px) * 4;
      rgba[i] = alpha > 0 ? Math.round((r / a) * 255) : 0;
      rgba[i + 1] = alpha > 0 ? Math.round((g / a) * 255) : 0;
      rgba[i + 2] = alpha > 0 ? Math.round((b / a) * 255) : 0;
      rgba[i + 3] = Math.round(alpha * 255);
    }
  }
  return rgba;
}

/* ---------- Encodage PNG ---------- */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // 8 bits par canal
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filtre "None"
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

for (const size of SIZES) {
  const file = join(OUT_DIR, `icon-${size}.png`);
  writeFileSync(file, encodePng(size, render(size)));
  console.log(`OK ${file}`);
}
