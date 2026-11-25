// 신호 매칭
// ② 낯선 신호: 같은 영화 + 다른 키워드 구성 (겹치는 게 1개쯤 있으면 우선)
// ③ 먼 신호:   다른 영화 + 비슷한 키워드 구성
const store = require('./store');
const { cfg } = require('./config');
const M = cfg.matching;

function jaccard(a, b) {
  const A = new Set(a), B = new Set(b);
  const inter = [...A].filter((x) => B.has(x)).length;
  return inter / new Set([...A, ...B]).size;
}

function overlap(a, b) {
  const B = new Set(b);
  return a.filter((x) => B.has(x)).length;
}

function pickRandom(list) {
  return list[Math.floor(Math.random() * list.length)];
}

function candidates(mine, exclude) {
  return store.allMessages().filter(
    (m) => m.shareable && m.userId !== mine.userId && !exclude.has(m.id),
  );
}

// ② 같은 영화, 다른 해석
function findStranger(mine, exclude = new Set()) {
  const pool = candidates(mine, exclude).filter((m) => m.movie === mine.movie);
  if (pool.length === 0) return null;
  // partial: 1개만 겹치고 나머지는 다른 감상 우선 → 낯설지만 납득되는 해석
  if (M.strangerMode === 'partial') {
    const partial = pool.filter((m) => overlap(mine.keywords, m.keywords) === 1 && jaccard(mine.keywords, m.keywords) <= 0.34);
    if (partial.length) return pickRandom(partial);
  }
  // opposite(또는 partial이 없을 때): 가장 덜 비슷한 것
  const min = Math.min(...pool.map((m) => jaccard(mine.keywords, m.keywords)));
  if (min >= M.strangerMaxSimilarity) return null; // 다 비슷하면 '낯선 신호'라고 부르기 어려움
  return pickRandom(pool.filter((m) => jaccard(mine.keywords, m.keywords) === min));
}

// ③ 다른 영화, 같은 감정
function findEcho(mine, exclude = new Set()) {
  const pool = candidates(mine, exclude).filter((m) => m.movie !== mine.movie);
  if (pool.length === 0) return null;
  const best = Math.max(...pool.map((m) => overlap(mine.keywords, m.keywords)));
  if (best < Math.max(1, M.echoMinOverlap)) return null;
  const top = pool.filter((m) => overlap(mine.keywords, m.keywords) === best);
  const max = Math.max(...top.map((m) => jaccard(mine.keywords, m.keywords)));
  return pickRandom(top.filter((m) => jaccard(mine.keywords, m.keywords) === max));
}

module.exports = { findStranger, findEcho, jaccard };
