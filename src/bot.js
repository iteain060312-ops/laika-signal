// 카카오톡 대화 흐름 (문구·버튼·신호 설정은 data/config.json)
// 예매 안내(booked) → 상영 종료 → 감상 입력(await_review) → 신호 변환(confirm) → 우주로 보내기
// → 일정 시간 뒤 신호 도착 (콜백 또는 다음 대화) → 이후 같은 영화의 새 신호를 틈틈이 알림
const store = require('./store');
const { analyze } = require('./analyze');
const { findStranger, findEcho, jaccard } = require('./match');
const { byName } = require('./keywords');
const { cfg } = require('./config');

const T = cfg.messages, B = cfg.buttons, C = cfg.cards, BK = cfg.booking, N = cfg.notify || {};
const fill = cfg.fill;
const SIGNAL_TYPES = ['stranger', 'echo'].filter((t) => cfg.signals[t]?.enabled !== false);
const CALLBACK_LIMIT_MS = 4.5 * 60 * 1000; // 카카오 콜백 주소는 5분 동안 1번만 쓸 수 있음

// ---------- 카카오 응답 모양 ----------
const text = (t) => ({ simpleText: { text: String(t).slice(0, 1000) } });
const image = (url, alt) => ({ simpleImage: { imageUrl: url, altText: alt.slice(0, 50) } });
const qr = (labels) => labels.map((l) => ({ label: l, action: 'message', messageText: l }));
const reply = (outputs, quick = []) => ({
  version: '2.0',
  template: { outputs: outputs.slice(0, 3), quickReplies: quick.slice(0, 10) },
});

function glyphUrl(base, keywords, orient = 'v') {
  const ids = keywords.map((n) => byName.get(n)?.id).filter((x) => x !== undefined);
  return `${base}/glyph/${orient}/${ids.join('-')}.png`;
}
const eul = (w) => {
  const c = w.charCodeAt(w.length - 1);
  return c >= 0xac00 && c <= 0xd7a3 && (c - 0xac00) % 28 ? '을' : '를';
};
const tags = (kw) => kw.map((k) => '#' + k).join(' ');
const overlap = (a, b) => a.filter((x) => b.includes(x)).length;
const NEXT = () => [B.daily, B.demoBooking]; // 한 바퀴 뒤 관객이 고르는 다음 행동

// 받은 신호 카드. kind: stranger | echo | similar
function signalCard(base, kind, m) {
  const title = { stranger: C.strangerTitle, echo: C.echoTitle, similar: C.similarTitle || C.strangerTitle }[kind]
    + (m.seed && C.showSeedLabel ? ' ' + C.seedLabel : '');
  const from = fill(kind === 'echo' ? C.echoFrom : C.strangerFrom, { movie: m.movie, eul: eul(m.movie) });
  const head = `${tags(m.keywords)}\n— ${from}\n\n`;
  const room = 230 - head.length - 2;
  const body = m.text.length > room ? m.text.slice(0, room - 1) + '…' : m.text;
  return {
    basicCard: {
      title: title.slice(0, 50),
      description: head + `“${body}”`,
      thumbnail: { imageUrl: glyphUrl(base, m.keywords, 'h'), altText: tags(m.keywords), fixedRatio: false },
      buttons: [{ action: 'message', label: B.like, messageText: B.like, extra: { like: m.id } }],
    },
  };
}

// ---------- 보낼 신호 대기열 (outbox) ----------
// signal: 내가 보낸 감상에 대한 답 신호(낯선/닮은)  ·  notify: 나중에 온 같은 영화의 새 신호
function takeDue(user, limit = 2) {
  const now = Date.now();
  const out = [];
  for (const item of user.outbox) {
    if (out.length >= limit) break;
    if (item.done || item.dueAt > now) continue;
    if (item.kind === 'signal') {
      const mine = store.getMessage(item.fromId);
      const seen = new Set(user.seen);
      const found = mine && (item.type === 'stranger' ? findStranger(mine, seen) : findEcho(mine, seen));
      if (!found) {
        if (now - item.dueAt > 7 * 864e5) item.done = true; // 일주일 동안 못 찾으면 포기
        continue;
      }
      item.done = true;
      user.seen.push(found.id);
      out.push({ kind: item.type, msg: found });
    } else if (item.kind === 'like') {
      item.done = true;
      const m = store.getMessage(item.msgId);
      if (m) out.push({ kind: 'like', msg: m });
    } else if (item.kind === 'notify') {
      item.done = true;
      const m = store.getMessage(item.msgId);
      if (!m || user.muted.includes(m.movie) || user.seen.includes(m.id)) continue;
      user.seen.push(m.id);
      out.push({ kind: item.relation === 'similar' ? 'similar' : 'stranger', notify: item.relation, msg: m });
    }
  }
  user.outbox = user.outbox.filter((i) => !i.done);
  store.save();
  return out;
}
const hasDue = (user) => user.outbox.some((i) => !i.done && i.dueAt <= Date.now());

// 도착한 것들을 카톡 말풍선으로
function arrivalReply(user, base, arrived, prefix = '') {
  const likes = arrived.filter((a) => a.kind === 'like');
  if (likes.length === arrived.length) {
    const m = likes[0].msg;
    return reply([text(prefix + fill(T.gotLike, { movie: m.movie, likes: m.likes || 1 }))], qr(NEXT()));
  }
  arrived = arrived.filter((a) => a.kind !== 'like');
  const notes = arrived.filter((a) => a.notify);
  let head;
  if (notes.length && notes.length === arrived.length) {
    const m = notes[0].msg;
    head = fill(notes[0].notify === 'similar' ? T.notifySimilar : T.notifyDifferent, { movie: m.movie, eul: eul(m.movie) });
  } else head = fill(T.arrived, { count: arrived.length });
  head = prefix + head;
  user.lastShown = arrived.map((a) => a.msg.id);
  const quick = [];
  if (notes.length) { user.lastNotifyMovie = notes[0].msg.movie; quick.push(B.mute); }
  quick.unshift(...NEXT());
  store.save();
  return reply([text(head), ...arrived.map((a) => signalCard(base, a.kind, a.msg))], qr(quick));
}

// 새 감상이 들어오면, 같은 영화를 본 다른 관객에게 알림을 예약
function notifyOthers(mine) {
  if (!N.enabled || !mine.shareable) return;
  const now = Date.now();
  for (const { id, u } of store.allUsers()) {
    if (id === mine.userId || !(u.watched || []).includes(mine.movie) || (u.muted || []).includes(mine.movie)) continue;
    if (u.lastNotifyQueuedAt && now - u.lastNotifyQueuedAt < (N.cooldownMin || 0) * 60000) continue;
    const theirs = store.allMessages().filter((m) => m.userId === id && m.movie === mine.movie).pop();
    if (!theirs) continue;
    const ov = overlap(theirs.keywords, mine.keywords);
    const relation = ov >= 2 ? 'similar' : jaccard(theirs.keywords, mine.keywords) <= cfg.matching.strangerMaxSimilarity ? 'different' : null;
    if (!relation || (N.mode !== 'both' && N.mode !== relation)) continue;
    u.outbox ||= [];
    u.outbox.push({ kind: 'notify', relation, msgId: mine.id, dueAt: now + (N.delayMin || 0) * 60000 });
    u.lastNotifyQueuedAt = now;
  }
  store.save();
}

// ---------- 메인 ----------
async function handle(body, base) {
  const utter = (body?.userRequest?.utterance || '').trim();
  const userId = body?.userRequest?.user?.id || 'anonymous';
  const callbackUrl = body?.userRequest?.callbackUrl;
  const user = store.getUser(userId);
  user.lastSeenAt = Date.now();
  user.channel = userId.startsWith('sim-') ? 'simulator' : 'kakao';

  if (utter === B.like) return like(user, userId, body?.action?.clientExtra?.like);
  if (utter === B.mute) {
    const movie = user.lastNotifyMovie;
    if (movie && !user.muted.includes(movie)) user.muted.push(movie);
    store.save();
    return reply([text(fill(T.muted, { movie: movie || '' }))], qr([B.unmute, ...NEXT()]));
  }
  if (utter === B.unmute) { user.muted = []; store.save(); return reply([text(T.unmuted)], qr(NEXT())); }
  if (utter === B.start) return schedule();
  if (utter === B.daily) return daily(user, userId, base);
  if (utter === B.demoBooking || utter === B.home) return newBooking(user, callbackUrl);
  if (utter === B.inbox) {
    const arrived = takeDue(user);
    return arrived.length ? arrivalReply(user, base, arrived) : reply([text(T.nothingYet)], qr(NEXT()));
  }

  if (user.state === 'booked') {
    if (Date.now() >= (user.screeningEndsAt || 0)) return screeningEnd(user);
    return reply([text(fill(T.bookingRemind, { movie: user.movie }))]);
  }
  if (user.state === 'await_review') return receiveReview(user, utter, base);
  if (user.state === 'confirm') {
    if (utter === B.confirm) return send(user, userId, base, callbackUrl);
    if (utter === B.rewrite) {
      user.state = 'await_review';
      store.save();
      return reply([text(T.rewrite)], qr([B.home]));
    }
    return reply([text(T.confirmAgain)], qr([B.confirm, B.rewrite]));
  }

  // 그 사이 도착한 신호가 있으면 먼저 보여주기
  if (hasDue(user)) {
    const arrived = takeDue(user);
    if (arrived.length) return arrivalReply(user, base, arrived);
  }
  if (!user.watched.length && !user.movie) return newBooking(user, callbackUrl); // 처음 온 관객
  return reply([text(T.welcome)], qr(NEXT()));
}

// ---------- 시간표 · 예매 ----------
function schedule() {
  return reply(
    [{
      textCard: {
        title: '라이카시네마 상영 시간표',
        description: T.schedule.slice(0, 400),
        buttons: [{ action: 'webLink', label: '시간표·예매 보기', webLinkUrl: cfg.links.booking }],
      },
    }],
    qr([B.demoBooking]),
  );
}

const pick = (a) => a[Math.floor(Math.random() * a.length)];
const DAYS = ['일', '월', '화', '수', '목', '금', '토'];
function newBooking(user, callbackUrl) {
  const kst = new Date(Date.now() + 9 * 3600 * 1000);
  const movie = pick(cfg.movies);
  const b = {
    movie,
    date: `${kst.getUTCMonth() + 1}월 ${kst.getUTCDate()}일 (${DAYS[kst.getUTCDay()]})`,
    time: pick(BK.times),
    hall: BK.hall,
    seat: pick([...BK.seatRows]) + (1 + Math.floor(Math.random() * BK.seatsPerRow)),
    ticket: 'LK' + String(Math.floor(Math.random() * 1e8)).padStart(8, '0'),
  };
  const delay = (cfg.flow.screeningEndDelaySec ?? 0) * 1000;
  // 0초면 예매 안내와 상영 종료 안내를 한 번에 (콜백 없이도 바로 도착)
  if (delay === 0) {
    Object.assign(user, { state: 'await_review', movie, booking: b, pending: null, screeningEndsAt: null });
    store.save();
    return reply([text(fill(T.booking, b)), text(fill(T.screeningEnd, { movie }))], qr([B.home]));
  }
  Object.assign(user, { state: 'booked', movie, booking: b, pending: null, screeningEndsAt: Date.now() + delay });
  store.save();
  // 상영 종료 안내는 버튼 없이 잠시 뒤 자동으로 (카카오 콜백)
  if (callbackUrl) {
    setTimeout(async () => {
      if (user.state !== 'booked' || user.booking !== b) return;
      try { await postCallback(callbackUrl, screeningEnd(user)); } catch (e) { console.error('[callback] 실패', e.message); }
    }, delay);
    return { version: '2.0', useCallback: true, data: { text: fill(T.booking, b) } };
  }
  // 콜백이 없으면: 시뮬레이터는 실시간 수신, 카톡은 다음 대화 때
  return reply([text(fill(T.booking, b))]);
}

function screeningEnd(user) {
  user.state = 'await_review';
  user.screeningEndsAt = null;
  store.save();
  return reply([text(fill(T.screeningEnd, { movie: user.movie }))], qr([B.home]));
}

// ---------- 감상 → 신호 ----------
async function receiveReview(user, utter, base) {
  const minLength = cfg.flow.minReviewLength;
  if (utter.length < minLength) return reply([text(fill(T.tooShort, { minLength }))], qr([B.home]));
  const result = await analyze(user.movie, utter);
  user.pending = { movie: user.movie, text: utter, keywords: result.keywords, shareable: result.shareable };
  user.state = 'confirm';
  store.save();
  return reply(
    [
      text(fill(T.converted, { movie: user.movie, tags: tags(result.keywords) })),
      image(glyphUrl(base, result.keywords), tags(result.keywords)),
      text(result.shareable ? T.confirmAsk : T.notShareable),
    ],
    qr([B.confirm, B.rewrite]),
  );
}

// ---------- 좋아요 ----------
function like(user, userId, msgId) {
  const id = msgId || (user.lastShown || [])[0];
  const m = id && store.getMessage(id);
  if (!m) return reply([text(T.liked)], qr(NEXT()));
  m.likedBy ||= [];
  if (m.likedBy.includes(userId)) return reply([text(T.likedAlready)], qr(NEXT()));
  m.likedBy.push(userId);
  m.likes = m.likedBy.length;
  // 보낸 사람에게 마음이 도착했다고 알려주기 (예시 감상은 제외)
  if (!m.seed && m.userId !== userId) {
    const author = store.getUser(m.userId);
    author.outbox.push({ kind: 'like', msgId: m.id, dueAt: Date.now() });
  }
  store.save();
  return reply([text(T.liked)], qr(NEXT()));
}

// ---------- 우주로 보내기 ----------
let postCallback = async () => {};
function setCallbackSender(fn) { postCallback = fn; }

function send(user, userId, base, callbackUrl) {
  const p = user.pending;
  if (!p) return newBooking(user);
  const mine = store.addMessage({ userId, movie: p.movie, keywords: p.keywords, text: p.text, shareable: p.shareable });
  Object.assign(user, { pending: null, state: 'idle' });
  if (!user.watched.includes(p.movie)) user.watched.push(p.movie);
  const now = Date.now();
  let maxDelay = 0;
  for (const type of SIGNAL_TYPES) {
    const d = (cfg.signals[type].delayMin || 0) * 60000;
    maxDelay = Math.max(maxDelay, d);
    user.outbox.push({ kind: 'signal', type, fromId: mine.id, dueAt: now + d });
  }
  store.save();
  notifyOthers(mine);

  // 바로 도착
  if (maxDelay === 0) {
    const arrived = takeDue(user);
    const head = T.sent + (arrived.length ? '\n' + fill(T.sentArrived, { count: arrived.length }) : '\n' + T.sentWaiting);
    return reply([text(head), ...arrived.map((a) => signalCard(base, a.kind, a.msg))], qr(NEXT()));
  }

  // 시간차 도착: 카카오 콜백으로 나중에 보내기
  if (callbackUrl && maxDelay <= CALLBACK_LIMIT_MS) {
    setTimeout(async () => {
      const arrived = takeDue(user);
      const out = arrived.length ? arrivalReply(user, base, arrived) : reply([text(T.nothingYet)], qr(NEXT()));
      try { await postCallback(callbackUrl, out); } catch (e) { console.error('[callback] 실패', e.message); }
    }, maxDelay);
    return { version: '2.0', useCallback: true, data: { text: T.sent + '\n' + T.sentWaiting } };
  }

  // 콜백이 없으면: 시뮬레이터는 실시간 수신, 카톡은 다음 대화 때 도착
  return reply([text(T.sent + '\n' + T.sentWaiting)], qr(NEXT()));
}

// 시뮬레이터용: 지금 도착한 신호가 있으면 말풍선으로
function pushFor(userId, base) {
  const user = store.getUser(userId);
  if (user.state === 'booked' && user.screeningEndsAt && Date.now() >= user.screeningEndsAt) return screeningEnd(user);
  if (!hasDue(user)) return null;
  const arrived = takeDue(user);
  return arrived.length ? arrivalReply(user, base, arrived) : null;
}

// ---------- 일상 속 신호 받기 (관객이 직접 눌러보는 시연용) ----------
// 누를 때마다 비슷한 신호 → 다른 신호 → 내 신호에 좋아요 순서로 돌아가며 도착
function daily(user, userId, base) {
  if (!user.watched.length) return newBooking(user);
  const order = ['similar', 'different', 'like'];
  const start = user.dailyCount || 0;
  for (let k = 0; k < order.length; k++) {
    const relation = order[(start + k) % order.length];
    const movies = [...user.watched].reverse().filter((mv) => !user.muted.includes(mv));
    for (const mv of movies) {
      const r = adminSend(userId, relation, 0, mv, true);
      if (!r.ok) continue;
      user.dailyCount = start + k + 1;
      const arrived = takeDue(user);
      if (arrived.length) return arrivalReply(user, base, arrived, T.dailyIntro ? T.dailyIntro + '\n' : '');
    }
  }
  return reply([text(T.dailyEmpty)], qr([B.demoBooking]));
}

// ---------- 운영자 패널: 일상 속 신호를 직접 보내기 ----------
// relation: similar(비슷한 신호) | different(다른 신호) | like(내 신호에 좋아요)
function adminSend(userId, relation, delaySec = 0, forMovie = null, keepMute = false) {
  const user = store.getUser(userId);
  const movie = forMovie || user.watched[user.watched.length - 1] || user.movie;
  if (!movie) return { ok: false, reason: '아직 영화를 본 적이 없는 관객이에요' };
  const dueAt = Date.now() + Math.max(0, delaySec) * 1000;
  const mine = store.allMessages().filter((m) => m.userId === userId && m.movie === movie).pop();

  if (relation === 'like') {
    if (!mine) return { ok: false, reason: '이 관객이 보낸 신호가 아직 없어요' };
    mine.likes = (mine.likes || 0) + 1;
    user.outbox.push({ kind: 'like', msgId: mine.id, dueAt });
    store.save();
    return { ok: true, movie };
  }
  const myKw = mine ? mine.keywords : [];
  const pool = store.allMessages().filter((m) => m.movie === movie && m.userId !== userId && m.shareable && !user.seen.includes(m.id));
  const fit = pool.filter((m) => {
    const ov = overlap(m.keywords, myKw);
    return relation === 'similar' ? ov >= 2 || !myKw.length : ov <= 1;
  });
  const pickFrom = fit.length ? fit : pool;
  if (!pickFrom.length) return { ok: false, reason: '이 영화에 보낼 수 있는 새 신호가 없어요' };
  const m = pickFrom[Math.floor(Math.random() * pickFrom.length)];
  user.outbox.push({ kind: 'notify', relation: relation === 'similar' ? 'similar' : 'different', msgId: m.id, dueAt });
  if (!keepMute && user.muted.includes(movie)) user.muted = user.muted.filter((x) => x !== movie); // 패널에서 보낼 땐 그만 받기를 풀어줌
  store.save();
  return { ok: true, movie, preview: m.text };
}

function adminUsers() {
  return store.allUsers()
    .filter(({ id }) => id !== 'seed')
    .map(({ id, u }) => ({
      id,
      channel: u.channel || (id.startsWith('sim-') ? 'simulator' : 'kakao'),
      lastSeenAt: u.lastSeenAt || 0,
      movie: u.watched?.[u.watched.length - 1] || u.movie || null,
      watched: u.watched || [],
      muted: u.muted || [],
      state: u.state,
      waiting: (u.outbox || []).filter((i) => !i.done).length,
      sent: store.allMessages().filter((m) => m.userId === id).length,
    }))
    .sort((a, b) => b.lastSeenAt - a.lastSeenAt);
}

module.exports = { handle, pushFor, setCallbackSender, adminSend, adminUsers };
