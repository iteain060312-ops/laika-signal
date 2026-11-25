const express = require('express');
const path = require('path');
const { handle, pushFor, setCallbackSender, adminSend, adminUsers } = require('./bot');
const { render } = require('./glyph');
const store = require('./store');

const app = express();
app.use(express.json({ limit: '200kb' }));
app.set('trust proxy', true);

// 이미지 주소의 기준. 배포하면 PUBLIC_BASE_URL에 https 주소를 넣어줘.
function baseUrl(req) {
  if (process.env.PUBLIC_BASE_URL) return process.env.PUBLIC_BASE_URL.replace(/\/$/, '');
  return `${req.protocol}://${req.get('host')}`;
}

// 카카오 i 오픈빌더 스킬 주소
app.post('/skill', async (req, res) => {
  const started = Date.now();
  try {
    const out = await handle(req.body, baseUrl(req));
    res.json(out);
  } catch (err) {
    console.error('[skill] 오류', err);
    res.json({
      version: '2.0',
      template: { outputs: [{ simpleText: { text: require('./config').cfg.messages.error } }] },
    });
  } finally {
    const ms = Date.now() - started;
    if (ms > 4000) console.warn(`[skill] 응답이 ${ms}ms 걸림 (카카오 제한 5초)`);
  }
});

// 신호 이미지: /glyph/v/0-5-8.png (세로) · /glyph/h/0-5-8.png (가로, 카드용)
function sendGlyph(req, res, orient) {
  const ids = req.params.code.split('-').map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n < 64).slice(0, 4);
  if (!ids.length) return res.status(400).end();
  res.set('Content-Type', 'image/png');
  res.set('Cache-Control', 'public, max-age=86400');
  res.send(render(ids, orient));
}
app.get('/glyph/v/:code.png', (req, res) => sendGlyph(req, res, 'v'));
app.get('/glyph/h/:code.png', (req, res) => sendGlyph(req, res, 'h'));
app.get('/glyph/:code.png', (req, res) => sendGlyph(req, res, 'v'));

// 카카오 콜백: 나중에 도착하는 신호를 callbackUrl로 보냄
setCallbackSender(async (url, body) => {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  console.log('[callback]', res.status, await res.text());
});

// 시뮬레이터가 몇 초마다 물어보는 주소: 도착한 신호가 있으면 돌려줌
app.get('/api/push/:userId', (req, res) => {
  res.json(pushFor(String(req.params.userId).slice(0, 80), baseUrl(req)) || {});
});

// 운영자 패널 API (ADMIN_KEY 환경 변수로 보호)
function adminOk(req, res) {
  const key = process.env.ADMIN_KEY;
  if (!key) { res.status(403).json({ error: 'Render 환경 변수에 ADMIN_KEY를 먼저 정해주세요' }); return false; }
  if (req.get('x-admin-key') !== key) { res.status(401).json({ error: '운영자 비밀번호가 맞지 않아요' }); return false; }
  return true;
}
app.get('/api/admin/users', (req, res) => { if (adminOk(req, res)) res.json(adminUsers()); });
app.post('/api/admin/send', (req, res) => {
  if (!adminOk(req, res)) return;
  const { userId, relation, delaySec } = req.body || {};
  if (!userId || !['similar', 'different', 'like'].includes(relation)) return res.status(400).json({ error: '잘못된 요청' });
  res.json(adminSend(String(userId), relation, Number(delaySec) || 0));
});
app.get('/admin', (req, res) => res.sendFile(require('path').join(__dirname, '..', 'public', 'admin.html')));

app.get('/health', (req, res) => res.json({ ok: true, messages: store.allMessages().length }));

// 카톡 모양 시뮬레이터 (오픈빌더 승인 전에도 시연 가능)
app.use(express.static(path.join(__dirname, '..', 'public')));

const port = process.env.PORT || 3000;
store.load();
app.listen(port, () => console.log(`LAIKA SIGNAL 서버 실행 중: http://localhost:${port}`));
