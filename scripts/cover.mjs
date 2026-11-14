// Generates cover.png (800x534) for gladys-wallpanel: plain Node, no dependency.
// Usage: node scripts/cover.mjs cover.png
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const W = 800;
const H = 534;
const px = Buffer.alloc(W * H * 3);
const set = (x, y, [r, g, b], a = 1) => {
  if (x < 0 || y < 0 || x >= W || y >= H) return;
  const i = (y * W + x) * 3;
  px[i] = px[i] * (1 - a) + r * a;
  px[i + 1] = px[i + 1] * (1 - a) + g * a;
  px[i + 2] = px[i + 2] * (1 - a) + b * a;
};

// Background: diagonal gradient, deep teal to night blue.
for (let y = 0; y < H; y += 1) {
  for (let x = 0; x < W; x += 1) {
    const t = (x / W + y / H) / 2;
    set(x, y, [16 + 20 * t, 60 - 30 * t, 80 + 40 * t]);
  }
}
const white = [255, 255, 255];

const disc = (cx, cy, r, color, alpha = 1) => {
  for (let y = Math.floor(cy - r - 1); y <= cy + r + 1; y += 1) {
    for (let x = Math.floor(cx - r - 1); x <= cx + r + 1; x += 1) {
      const a = Math.max(0, Math.min(1, r - Math.hypot(x - cx, y - cy) + 0.5));
      if (a > 0) set(x, y, color, a * alpha);
    }
  }
};
const box = (x0, y0, x1, y1, r, color, alpha = 1) => {
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const cx = Math.min(Math.max(x + 0.5, x0 + r), x1 - r);
      const cy = Math.min(Math.max(y + 0.5, y0 + r), y1 - r);
      const a = Math.max(0, Math.min(1, r - Math.hypot(x + 0.5 - cx, y + 0.5 - cy) + 0.5));
      if (a > 0) set(x, y, color, a * alpha);
    }
  }
};
disc(400, 267, 260, white, 0.04);

const dark = [34, 38, 48];
const screen = [236, 241, 248];
const tile = [205, 215, 230];
const accent = [52, 152, 219];
const green = [47, 158, 68];
const amber = [250, 176, 5];

// A wall: a tablet in landscape, its frame and screen.
box(130, 90, 670, 444, 30, dark);
box(156, 116, 644, 418, 10, screen);
disc(657, 267, 5, [90, 96, 110]);

// The dashboard on the screen: a header, tiles, a light bulb and a bar.
box(176, 134, 624, 164, 8, accent);
box(176, 182, 390, 290, 14, tile);
box(410, 182, 624, 290, 14, tile);
box(176, 308, 390, 400, 14, tile);
box(410, 308, 624, 400, 14, tile);
disc(283, 228, 30, amber);
box(271, 256, 295, 276, 4, [120, 126, 140]);
box(430, 220, 604, 240, 8, [255, 255, 255]);
box(430, 220, 560, 240, 8, green);
// A speech bubble (the voice) and a sensor dot (the light).
box(196, 330, 370, 376, 20, accent);
const tail = [
  [214, 376],
  [206, 392],
];
for (let i = 0; i <= 20; i += 1) {
  disc(
    tail[0][0] + ((tail[1][0] - tail[0][0]) * i) / 20,
    tail[0][1] + ((tail[1][1] - tail[0][1]) * i) / 20,
    6,
    accent,
  );
}
for (const [x, r] of [
  [470, 10],
  [517, 16],
  [564, 22],
]) {
  disc(x, 354, r, [120, 126, 140], 0.9);
}

// PNG encoding.
const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const c = Buffer.alloc(4);
  c.writeUInt32BE(crc(td));
  return Buffer.concat([len, td, c]);
};
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0);
ihdr.writeUInt32BE(H, 4);
ihdr[8] = 8;
ihdr[9] = 2;
const raw = Buffer.alloc((W * 3 + 1) * H);
for (let y = 0; y < H; y += 1) {
  raw[y * (W * 3 + 1)] = 0;
  px.copy(raw, y * (W * 3 + 1) + 1, y * W * 3, (y + 1) * W * 3);
}
const png = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);
writeFileSync(process.argv[2] ?? 'cover.png', png);
console.log('cover', png.length, 'bytes');
