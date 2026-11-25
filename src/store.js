// 아주 단순한 JSON 파일 저장소 (프로토타입용)
// 주의: 무료 호스팅(Render 무료 플랜 등)은 서버가 재시작되면 파일이 초기화될 수 있어.
// 시연 전에 실제 감상이 쌓여야 한다면 README의 '데이터 보존' 항목을 참고.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const SEED_FILE = path.join(__dirname, '..', 'data', 'seed.json');

let db = null;

function newId() {
  return crypto.randomBytes(6).toString('hex');
}

function load() {
  if (db) return db;
  try {
    db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  } catch {
    db = { messages: [], users: {} };
  }
  // 예시 감상을 고치거나 늘렸으면, 이미 쌓인 데이터는 두고 예시만 새로 맞춤
  const seeds = JSON.parse(fs.readFileSync(SEED_FILE, 'utf8'));
  const keep = new Set(seeds.map((x) => x.movie + '|' + x.text));
  db.messages = db.messages.filter((m) => !m.seed || keep.has(m.movie + '|' + m.text));
  const have = new Set(db.messages.filter((m) => m.seed).map((m) => m.movie + '|' + m.text));
  for (const x of seeds) {
    if (have.has(x.movie + '|' + x.text)) continue;
    db.messages.push({
      id: newId(), userId: 'seed', movie: x.movie, keywords: x.keywords,
      text: x.text, shareable: true, seed: true, createdAt: Date.now(),
    });
  }
  save();
  return db;
}

let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = DB_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
    fs.renameSync(tmp, DB_FILE);
  }, 50);
}

function getUser(userId) {
  const d = load();
  if (!d.users[userId]) d.users[userId] = { state: 'idle' };
  const u = d.users[userId];
  u.outbox ||= []; u.watched ||= []; u.muted ||= []; u.seen ||= [];
  return u;
}

function allUsers() {
  return Object.entries(load().users).map(([id, u]) => ({ id, u }));
}

function addMessage(msg) {
  const d = load();
  const m = { id: newId(), createdAt: Date.now(), ...msg };
  d.messages.push(m);
  save();
  return m;
}

function getMessage(id) {
  return load().messages.find((m) => m.id === id);
}

function allMessages() {
  return load().messages;
}

module.exports = { load, save, getUser, allUsers, addMessage, getMessage, allMessages };
