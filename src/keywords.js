// 키워드와 문양은 data/config.json의 "keywords"에서 바꿔.
const { cfg } = require('./config');

const KEYWORDS = cfg.keywords;
const byName = new Map(KEYWORDS.map((k) => [k.name, k]));
const byId = new Map(KEYWORDS.map((k) => [k.id, k]));

module.exports = { KEYWORDS, byName, byId };
