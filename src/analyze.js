// 감상 텍스트 → 키워드 2~4개 (+ 다른 관객에게 보여줘도 되는지)
// 카카오 스킬은 5초 안에 답해야 해서, AI가 늦으면 단어 기반 규칙으로 대신 처리해.
const { KEYWORDS, byName } = require('./keywords');

const MODEL = process.env.CLAUDE_MODEL || 'claude-haiku-5-5';
const AI_TIMEOUT_MS = Number(process.env.AI_TIMEOUT_MS || 3200);

const SYSTEM = `너는 영화관 '라이카시네마'의 감상 신호 변환기야.
관객의 영화 감상을 읽고, 아래 키워드 중 감상에 가장 잘 맞는 것을 2~4개 골라.

키워드 목록:
${KEYWORDS.map((k) => `- ${k.name}: ${k.hint}`).join('\n')}

또 이 감상을 다른 낯선 관객에게 그대로 보여줘도 되는지 판단해.
욕설·혐오 표현, 특정인을 향한 공격, 전화번호 같은 개인정보, 영화와 무관한 광고나 장난이면 shareable을 false로 해.
스포일러는 괜찮아(같은 영화를 본 사람끼리 나누는 거니까).

반드시 JSON 한 줄만 출력해. 다른 말은 쓰지 마.
형식: {"keywords":["키워드1","키워드2"],"shareable":true}`;

function ruleBased(text) {
  const scores = KEYWORDS.map((k) => ({
    name: k.name,
    score: k.words.reduce((s, w) => s + (text.includes(w) ? 1 : 0), 0),
  }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);
  const picked = scores.slice(0, 3).map((x) => x.name);
  if (picked.length === 0) picked.push('여운');
  if (picked.length === 1) picked.push(picked[0] === '질문' ? '여운' : '질문');
  return { keywords: picked, shareable: true, source: 'rule' };
}

function clean(result) {
  const names = [...new Set((result.keywords || []).filter((n) => byName.has(n)))].slice(0, 4);
  if (names.length < 2) return null;
  return { keywords: names, shareable: result.shareable !== false };
}

async function analyze(movie, text) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return ruleBased(text);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), AI_TIMEOUT_MS);
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'content-type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 120,
        system: SYSTEM,
        messages: [{ role: 'user', content: `영화: ${movie}\n감상: ${text}` }],
      }),
    });
    if (!res.ok) throw new Error(`Claude API ${res.status}: ${await res.text()}`);
    const data = await res.json();
    const raw = (data.content || []).map((c) => c.text || '').join('');
    const json = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1));
    const ok = clean(json);
    if (!ok) throw new Error('키워드를 해석하지 못함: ' + raw);
    return { ...ok, source: 'ai' };
  } catch (err) {
    console.warn('[analyze] AI 대신 규칙 사용:', err.name === 'AbortError' ? '시간 초과' : err.message);
    return ruleBased(text);
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { analyze, ruleBased };
