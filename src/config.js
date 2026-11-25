// 모든 조정 값은 data/config.json 한 파일에 있어.
// 조정 페이지에서 '설정 복사'로 받은 JSON을 이 파일에 그대로 붙여넣으면 돼.
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'data', 'config.json');
const cfg = JSON.parse(fs.readFileSync(FILE, 'utf8'));

const hexToRgb = (h) => {
  const m = /^#?([0-9a-f]{6})$/i.exec(h || '');
  const n = m ? parseInt(m[1], 16) : 0xaaaaaa;
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};

// 키워드에 순서대로 id를 붙임 (문양 이미지 주소에 쓰임)
cfg.keywords = cfg.keywords.map((k, i) => ({ ...k, id: i, rgb: hexToRgb(k.color), words: k.words || [] }));

// 환경 변수가 있으면 도착 시간은 그걸 우선 사용
if (process.env.DELAY_STRANGER_MIN) cfg.signals.stranger.delayMin = Number(process.env.DELAY_STRANGER_MIN);
if (process.env.DELAY_ECHO_MIN) cfg.signals.echo.delayMin = Number(process.env.DELAY_ECHO_MIN);
if (process.env.NOTIFY_DELAY_MIN) cfg.notify.delayMin = Number(process.env.NOTIFY_DELAY_MIN);
if (process.env.SHOW_SEED_LABEL === 'false') cfg.cards.showSeedLabel = false;

// '{movie}' 같은 자리에 값 채우기
cfg.fill = (tpl, vars = {}) => String(tpl || '').replace(/\{(\w+)\}/g, (_, k) => (vars[k] ?? `{${k}}`));

module.exports = { cfg, hexToRgb };
