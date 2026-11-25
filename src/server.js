const express = require('express');
const path = require('path');
const { handle } = require('./bot');
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
      template: { outputs: [{ simpleText: { text: '신호가 잠시 끊겼어요. 다시 한 번 보내주세요.' } }] },
    });
  } finally {
    const ms = Date.now() - started;
    if (ms > 4000) console.warn(`[skill] 응답이 ${ms}ms 걸림 (카카오 제한 5초)`);
  }
});

// 도트 신호 이미지: /glyph/0-5-8.png
app.get('/glyph/:code.png', (req, res) => {
  const ids = req.params.code.split('-').map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n < 64).slice(0, 4);
  if (!ids.length) return res.status(400).end();
  res.set('Content-Type', 'image/png');
  res.set('Cache-Control', 'public, max-age=31536000, immutable');
  res.send(render(ids));
});

app.get('/health', (req, res) => res.json({ ok: true, messages: store.allMessages().length }));

// 카톡 모양 시뮬레이터 (오픈빌더 승인 전에도 시연 가능)
app.use(express.static(path.join(__dirname, '..', 'public')));

const port = process.env.PORT || 3000;
store.load();
app.listen(port, () => console.log(`LAIKA SIGNAL 서버 실행 중: http://localhost:${port}`));
