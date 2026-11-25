// 카카오톡 대화 흐름
// idle → (영화 선택) → await_review → (감상 입력) → confirm → (이대로 보내기) → 신호 도착
const fs = require('fs');
const path = require('path');
const store = require('./store');
const { analyze } = require('./analyze');
const { findStranger, findEcho } = require('./match');
const { byName } = require('./keywords');

const MOVIES = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'movies.json'), 'utf8'));
const DELAY = {
  stranger: Number(process.env.DELAY_STRANGER_MIN || 0) * 60000,
  echo: Number(process.env.DELAY_ECHO_MIN || 0) * 60000,
};
const SHOW_SEED_LABEL = process.env.SHOW_SEED_LABEL !== 'false';

const CMD = {
  start: ['신호 보내기', '시작', '처음으로', '처음'],
  confirm: ['이대로 보내기'],
  rewrite: ['다시 쓰기'],
  inbox: ['도착한 신호', '신호 확인', '도착한 신호 확인'],
};
const is = (u, list) => list.includes(u.trim());

// ---------- 카카오 응답 모양 ----------
const text = (t) => ({ simpleText: { text: t.slice(0, 1000) } });
const image = (url, alt) => ({ simpleImage: { imageUrl: url, altText: alt.slice(0, 50) } });
const qr = (labels) => labels.map((l) => ({ label: l, action: 'message', messageText: l }));
const reply = (outputs, quick = []) => ({
  version: '2.0',
  template: { outputs: outputs.slice(0, 3), quickReplies: quick.slice(0, 10) },
});

function glyphUrl(base, keywords) {
  const ids = keywords.map((n) => byName.get(n)?.id).filter((x) => x !== undefined);
  return `${base}/glyph/${ids.join('-')}.png`;
}
// 받침에 따라 을/를
const eul = (w) => {
  const c = w.charCodeAt(w.length - 1);
  return c >= 0xac00 && c <= 0xd7a3 && (c - 0xac00) % 28 ? '을' : '를';
};
const tags = (kw) => kw.map((k) => '#' + k).join(' ');

function signalCard(base, type, m) {
  const title = (type === 'stranger' ? '같은 영화, 낯선 신호' : '다른 영화, 닮은 신호')
    + (m.seed && SHOW_SEED_LABEL ? ' (예시)' : '');
  const from = type === 'stranger' ? `《${m.movie}》${eul(m.movie)} 본 다른 관객` : `《${m.movie}》${eul(m.movie)} 본 관객`;
  const head = `${tags(m.keywords)}\n— ${from}\n\n`;
  const room = 230 - head.length - 2;
  const body = m.text.length > room ? m.text.slice(0, room - 1) + '…' : m.text;
  return {
    basicCard: {
      title,
      description: head + `“${body}”`,
      thumbnail: { imageUrl: glyphUrl(base, m.keywords), altText: tags(m.keywords), fixedRatio: false },
    },
  };
}

// ---------- 신호 배달 ----------
// 보낸 감상마다 ②, ③ 두 칸의 '수신함'이 생기고, 도착 시간이 되면 그때 매칭해서 열어줘.
function deliverDue(user, limit = 2) {
  const now = Date.now();
  const arrived = [];
  const seen = new Set(user.inbox.filter((s) => s.matchedId).map((s) => s.matchedId));
  for (const slot of user.inbox) {
    if (arrived.length >= limit) break;
    if (slot.delivered || slot.availableAt > now) continue;
    const mine = store.getMessage(slot.fromId);
    if (!mine) continue;
    const found = slot.type === 'stranger' ? findStranger(mine, seen) : findEcho(mine, seen);
    if (!found) continue; // 아직 맞는 신호가 없음 → 다음에 다시 찾기
    slot.matchedId = found.id;
    slot.delivered = true;
    seen.add(found.id);
    arrived.push({ type: slot.type, msg: found });
  }
  store.save();
  return arrived;
}

function waitingCount(user) {
  return user.inbox.filter((s) => !s.delivered).length;
}

// ---------- 메인 ----------
async function handle(body, base) {
  const utter = (body?.userRequest?.utterance || '').trim();
  const userId = body?.userRequest?.user?.id || 'anonymous';
  const user = store.getUser(userId);

  // 어느 단계에서든 통하는 명령
  if (is(utter, CMD.start)) return askMovie(user);
  if (is(utter, CMD.inbox)) return checkInbox(user, base);

  if (MOVIES.includes(utter)) {
    user.state = 'await_review';
    user.movie = utter;
    store.save();
    return reply(
      [text(`《${utter}》 어떠셨어요?\n\n떠오르는 감상을 자유롭게 보내주세요. 한 문장이어도 괜찮아요.`)],
      qr(['처음으로']),
    );
  }

  if (user.state === 'await_review') return receiveReview(user, utter, base);

  if (user.state === 'confirm') {
    if (is(utter, CMD.confirm)) return send(user, userId, base);
    if (is(utter, CMD.rewrite)) {
      user.state = 'await_review';
      store.save();
      return reply([text('다시 한 번 감상을 보내주세요.')], qr(['처음으로']));
    }
    return reply([text('신호를 이대로 보낼까요?')], qr(['이대로 보내기', '다시 쓰기']));
  }

  return welcome(user);
}

function welcome(user) {
  const waiting = waitingCount(user);
  const lines = [
    '📡 LAIKA SIGNAL',
    '',
    '영화관에서는 서로를 알지 못하는 우리.',
    '오늘 본 영화의 감상을 신호로 바꿔, 낯선 관객에게 보내보세요.',
  ];
  if (waiting) lines.push('', `아직 도착하지 않은 신호가 ${waiting}개 있어요.`);
  return reply([text(lines.join('\n'))], qr(['신호 보내기', '도착한 신호']));
}

function askMovie(user) {
  user.state = 'choose_movie';
  store.save();
  return reply([text('오늘 어떤 영화를 보셨나요?')], qr(MOVIES));
}

async function receiveReview(user, utter, base) {
  if (utter.length < 5) {
    return reply([text('조금만 더 길게 들려주세요. 다섯 글자 이상이면 신호로 바꿀 수 있어요.')], qr(['처음으로']));
  }
  const result = await analyze(user.movie, utter);
  user.pending = { movie: user.movie, text: utter, keywords: result.keywords, shareable: result.shareable };
  user.state = 'confirm';
  store.save();

  const msg = [`《${user.movie}》에 대한 감상을 신호로 바꿨어요.`, '', tags(result.keywords)];
  if (!result.shareable) {
    msg.push('', '다른 관객에게 전하기 어려운 표현이 있어서, 이 신호는 나에게만 보관돼요. 다시 써서 보내도 좋아요.');
  } else {
    msg.push('', '이 신호를 낯선 관객에게 보낼까요?');
  }
  return reply(
    [text(msg.join('\n')), image(glyphUrl(base, result.keywords), tags(result.keywords))],
    qr(['이대로 보내기', '다시 쓰기']),
  );
}

function send(user, userId, base) {
  const p = user.pending;
  if (!p) return askMovie(user);
  const mine = store.addMessage({ userId, movie: p.movie, keywords: p.keywords, text: p.text, shareable: p.shareable });
  user.pending = null;
  user.state = 'idle';
  const now = Date.now();
  user.inbox.push(
    { fromId: mine.id, type: 'stranger', availableAt: now + DELAY.stranger, delivered: false },
    { fromId: mine.id, type: 'echo', availableAt: now + DELAY.echo, delivered: false },
  );
  const arrived = deliverDue(user);

  const head = ['🛰 신호를 우주로 보냈어요.'];
  if (arrived.length) head.push(`그리고 ${arrived.length}개의 신호가 도착했어요.`);
  const waiting = waitingCount(user);
  if (waiting) head.push(`아직 ${waiting}개의 신호를 기다리고 있어요. 나중에 '도착한 신호'를 눌러보세요.`);

  return reply(
    [text(head.join('\n')), ...arrived.map((a) => signalCard(base, a.type, a.msg))],
    qr(['도착한 신호', '신호 보내기']),
  );
}

function checkInbox(user, base) {
  const arrived = deliverDue(user);
  const waiting = waitingCount(user);
  if (!arrived.length) {
    if (!user.inbox.length) {
      return reply([text('아직 보낸 신호가 없어요. 먼저 감상을 보내면, 낯선 관객의 신호가 도착해요.')], qr(['신호 보내기']));
    }
    return reply(
      [text(waiting ? `아직 새로 도착한 신호가 없어요.\n기다리는 신호: ${waiting}개` : '새로 도착한 신호가 없어요. 모든 신호를 받았어요.')],
      qr(['신호 보내기', '도착한 신호']),
    );
  }
  const head = `새 신호 ${arrived.length}개가 도착했어요.` + (waiting ? `\n기다리는 신호: ${waiting}개` : '');
  return reply(
    [text(head), ...arrived.map((a) => signalCard(base, a.type, a.msg))],
    qr(['도착한 신호', '신호 보내기']),
  );
}

module.exports = { handle };
