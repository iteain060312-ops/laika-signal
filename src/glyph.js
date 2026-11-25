// 키워드 조합 → 아레시보 메시지처럼 생긴 신호 PNG
// - 네모 픽셀, 검은 바탕
// - 각 문양을 2배로 키워 사슬처럼 엇갈려 쌓고, 겹치는 칸은 빛처럼 섞음(screen)
// - v: 세로(메시지 본문용, 원래 아레시보처럼 세로로 긴 판) / h: 가로(카드 썸네일용)
// - 바깥 여백 없이 문양이 있는 곳까지만 그림
const { PNG } = require('pngjs');
const { byId } = require('./keywords');
const { cfg, hexToRgb } = require('./config');

const CELL = 24;
const SCALE = 2;           // 5x5 문양 → 10x10 칸
const G = 5 * SCALE;
const STEP = 8;            // 다음 문양까지 거리 (10칸 중 2칸 겹침 → 세로로 길게)
const ZIG = [0, 4, 1, 4];  // 엇갈림 (세로판에선 x, 가로판에선 y)

const cache = new Map();

// 문양 배치: 칸 좌표 → 그 칸에 놓인 색들. 내용에 딱 맞게 잘라서 여백이 없음
function compose(ids, orient) {
  const ks = ids.map((id) => byId.get(id)).filter(Boolean).slice(0, 4);
  const n = ks.length;
  const raw = [];
  ks.forEach((k, i) => {
    const along = i * STEP, across = n === 1 ? 0 : ZIG[i];
    const x0 = orient === 'v' ? across : along, y0 = orient === 'v' ? along : across;
    k.glyph.forEach((line, r) => [...line].forEach((ch, c) => {
      if (ch !== '#') return;
      for (let dy = 0; dy < SCALE; dy++) for (let dx = 0; dx < SCALE; dx++) raw.push([x0 + c * SCALE + dx, y0 + r * SCALE + dy, k.rgb]);
    }));
  });
  const minX = Math.min(...raw.map((p) => p[0])), maxX = Math.max(...raw.map((p) => p[0]));
  const minY = Math.min(...raw.map((p) => p[1])), maxY = Math.max(...raw.map((p) => p[1]));
  const head = cfg.image.showHeader ? 2 : 0; // 맨 위 한 줄: 문양 개수 (아레시보 첫 줄의 숫자처럼)
  const cells = new Map();
  for (const [x, y, rgb] of raw) {
    const key = `${x - minX},${y - minY + head}`;
    if (!cells.has(key)) cells.set(key, []);
    cells.get(key).push(rgb);
  }
  return { COLS: maxX - minX + 1, ROWS: maxY - minY + 1 + head, cells, n, head };
}

const screen = (cols) => cols.reduce((a, b) => a.map((v, i) => 255 - ((255 - v) * (255 - b[i])) / 255));

function render(ids, orient = 'v') {
  const key = orient + ids.join('-');
  if (cache.has(key)) return cache.get(key);
  const st = cfg.image;
  const { COLS, ROWS, cells, n, head } = compose(ids, orient);
  const png = new PNG({ width: COLS * CELL, height: ROWS * CELL });
  const bg = hexToRgb(st.background), grid = hexToRgb(st.gridColor);
  const frac = Math.min(1, Math.max(0.5, 0.4 + 1.2 * (st.dotScale ?? 0.4)));
  const sq = Math.round(CELL * frac), off = Math.floor((CELL - sq) / 2);

  const rect = (x, y, w, h, rgb) => {
    for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) {
      const i = (png.width * yy + xx) << 2;
      png.data[i] = rgb[0]; png.data[i + 1] = rgb[1]; png.data[i + 2] = rgb[2]; png.data[i + 3] = 255;
    }
  };
  rect(0, 0, png.width, png.height, bg);
  for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) {
    const here = cells.get(`${c},${r}`);
    if (here) rect(c * CELL + off, r * CELL + off, sq, sq, screen(here));
    else if (st.showGrid) rect(c * CELL + CELL / 2 - 2, r * CELL + CELL / 2 - 2, 4, 4, grid);
  }
  // 위쪽 흰 칸: 문양 개수 (아레시보 첫 줄의 숫자처럼)
  if (head) for (let i = 0; i < n; i++) rect(i * 2 * CELL + off, off, sq, sq, [255, 255, 255]);

  const buf = PNG.sync.write(png);
  cache.set(key, buf);
  return buf;
}

module.exports = { render, compose };
