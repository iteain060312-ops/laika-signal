// 키워드 조합 → 아레시보 메시지처럼 생긴 도트 신호 PNG
const { PNG } = require('pngjs');
const { byId } = require('./keywords');

const CELL = 25;          // 모눈 한 칸 (px)
const COLS = 32, ROWS = 16; // 800 x 400
const BG = [11, 15, 30];
const GRID = [36, 44, 70];

const cache = new Map();

function blend(png, x, y, rgb, a) {
  if (x < 0 || y < 0 || x >= png.width || y >= png.height) return;
  const i = (png.width * y + x) << 2;
  for (let c = 0; c < 3; c++) png.data[i + c] = Math.round(png.data[i + c] * (1 - a) + rgb[c] * a);
}

function dot(png, col, row, rgb, radius) {
  const cx = col * CELL + CELL / 2, cy = row * CELL + CELL / 2;
  const r = radius;
  for (let y = Math.floor(cy - r - 1); y <= Math.ceil(cy + r + 1); y++) {
    for (let x = Math.floor(cx - r - 1); x <= Math.ceil(cx + r + 1); x++) {
      // 4x4 슈퍼샘플링으로 가장자리를 부드럽게
      let hit = 0;
      for (let sy = 0; sy < 4; sy++) for (let sx = 0; sx < 4; sx++) {
        const dx = x + (sx + 0.5) / 4 - cx, dy = y + (sy + 0.5) / 4 - cy;
        if (dx * dx + dy * dy <= r * r) hit++;
      }
      if (hit) blend(png, x, y, rgb, hit / 16);
    }
  }
}

function render(ids) {
  const key = ids.join('-');
  if (cache.has(key)) return cache.get(key);

  const png = new PNG({ width: COLS * CELL, height: ROWS * CELL });
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i] = BG[0]; png.data[i + 1] = BG[1]; png.data[i + 2] = BG[2]; png.data[i + 3] = 255;
  }
  // 빈 모눈
  for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) dot(png, c, r, GRID, 2.2);

  const glyphs = ids.map((id) => byId.get(id)).filter(Boolean);
  const total = glyphs.length * 5 + (glyphs.length - 1) * 2;
  let col0 = Math.floor((COLS - total) / 2);
  const row0 = 5;

  glyphs.forEach((k) => {
    k.glyph.forEach((line, r) => {
      [...line].forEach((ch, c) => {
        if (ch === '#') dot(png, col0 + c, row0 + r, k.color, 9.5);
      });
    });
    // 문양 아래 키워드 표시줄 (아레시보의 색 띠처럼)
    for (let c = 0; c < 5; c++) dot(png, col0 + c, row0 + 7, k.color, 4);
    col0 += 7;
  });
  // 상단 시작 신호: 키워드 개수만큼
  for (let i = 0; i < glyphs.length; i++) dot(png, 1 + i * 2, 1, [255, 255, 255], 5);

  const buf = PNG.sync.write(png);
  cache.set(key, buf);
  return buf;
}

module.exports = { render };
