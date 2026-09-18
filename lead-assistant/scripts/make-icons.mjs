/**
 * Draws the app icons from scratch -- no image editor, no dependency.
 * The mark is a call list: three bars with the top one flagged, which is
 * exactly what the app is for.
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.resolve(here, '../web/public');

// --- a very small PNG writer ------------------------------------------------

const CRC_TABLE = (() => {
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
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function encodePng(width, height, rgba) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (width * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // RGBA
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// --- drawing ----------------------------------------------------------------

const SS = 4; // supersampling factor, for smooth edges

function roundedRectCoverage(x, y, rect) {
  const { left, top, right, bottom, radius } = rect;
  const cx = Math.min(Math.max(x, left + radius), right - radius);
  const cy = Math.min(Math.max(y, top + radius), bottom - radius);
  if (x < left || x > right || y < top || y > bottom) return false;
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= radius * radius;
}

function circleCoverage(x, y, { cx, cy, r }) {
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= r * r;
}

function mix(a, b, t) {
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t),
  ];
}

function drawIcon(size, { padding = 0, transparent = false } = {}) {
  const rgba = Buffer.alloc(size * size * 4);
  const inset = size * padding;
  const box = {
    left: inset, top: inset, right: size - inset, bottom: size - inset,
    radius: (size - inset * 2) * 0.235,
  };

  const top = [0x4f, 0x46, 0xe5];    // indigo
  const bottom = [0x7c, 0x3a, 0xed]; // violet
  const white = [0xff, 0xff, 0xff];
  const amber = [0xfb, 0xbf, 0x24];

  const inner = size - inset * 2;
  const barLeft = inset + inner * 0.30;
  const barHeight = inner * 0.085;
  const bars = [0.315, 0.455, 0.595].map((topFrac, i) => ({
    left: barLeft,
    right: inset + inner * (i === 0 ? 0.76 : i === 1 ? 0.70 : 0.61),
    top: inset + inner * topFrac,
    bottom: inset + inner * topFrac + barHeight,
    radius: barHeight / 2,
  }));
  const dots = [0.315, 0.455, 0.595].map((topFrac) => ({
    cx: inset + inner * 0.225,
    cy: inset + inner * topFrac + barHeight / 2,
    r: barHeight * 0.62,
  }));

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let bgHits = 0;
      let markHits = 0;
      let accentHits = 0;

      for (let sy = 0; sy < SS; sy += 1) {
        for (let sx = 0; sx < SS; sx += 1) {
          const px = x + (sx + 0.5) / SS;
          const py = y + (sy + 0.5) / SS;
          if (!roundedRectCoverage(px, py, box)) continue;
          bgHits += 1;
          if (bars.some((bar) => roundedRectCoverage(px, py, bar))) markHits += 1;
          else if (circleCoverage(px, py, dots[0])) accentHits += 1;
          else if (dots.slice(1).some((dot) => circleCoverage(px, py, dot))) markHits += 1;
        }
      }

      const total = SS * SS;
      const offset = (y * size + x) * 4;
      if (bgHits === 0) {
        if (!transparent) { rgba[offset + 3] = 0; }
        continue;
      }

      const gradient = mix(top, bottom, y / size);
      const markAlpha = markHits / total;
      const accentAlpha = accentHits / total;
      let color = gradient;
      if (markAlpha > 0) color = mix(color, white, markAlpha / (bgHits / total));
      if (accentAlpha > 0) color = mix(color, amber, accentAlpha / (bgHits / total));

      rgba[offset] = color[0];
      rgba[offset + 1] = color[1];
      rgba[offset + 2] = color[2];
      rgba[offset + 3] = Math.round((bgHits / total) * 255);
    }
  }
  return encodePng(size, size, rgba);
}

const SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#4f46e5"/>
      <stop offset="1" stop-color="#7c3aed"/>
    </linearGradient>
  </defs>
  <rect width="512" height="512" rx="120" fill="url(#g)"/>
  <circle cx="115" cy="183" r="27" fill="#fbbf24"/>
  <circle cx="115" cy="255" r="27" fill="#fff"/>
  <circle cx="115" cy="327" r="27" fill="#fff"/>
  <rect x="154" y="161" width="235" height="44" rx="22" fill="#fff"/>
  <rect x="154" y="233" width="204" height="44" rx="22" fill="#fff"/>
  <rect x="154" y="305" width="158" height="44" rx="22" fill="#fff"/>
</svg>
`;

fs.mkdirSync(outDir, { recursive: true });
const outputs = [
  ['icon-192.png', drawIcon(192)],
  ['icon-512.png', drawIcon(512)],
  ['icon-maskable-512.png', drawIcon(512, { padding: 0.12, transparent: true })],
  ['apple-touch-icon.png', drawIcon(180, { padding: 0, transparent: true })],
];
for (const [name, buffer] of outputs) {
  fs.writeFileSync(path.join(outDir, name), buffer);
  console.log(`wrote ${name} (${buffer.length} bytes)`);
}
fs.writeFileSync(path.join(outDir, 'icon.svg'), SVG);
console.log('wrote icon.svg');
