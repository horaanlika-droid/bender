// Долговременная память Бендера на Node: канон «Футурамы» из brain/lore/*.md.
// Порт brain/lore.py один в один: те же файлы, тот же стеммер, тот же BM25.
//
// Зачем порт: морда и бот живут в Node (BotHost поднимает app.js), а лор лежит
// рядом, в brain/lore/. Python-мозг читает те же файлы — это одна память,
// а не две. Хозяин пишет боту /ask — отвечает память, а не шаблон из коробки.
//
//   const { recall } = require('./lib/lore');
//   recall('помнишь Сеймура?')[0].title   // 'S04E07 · Jurassic Bark'

'use strict';

const fs = require('fs');
const path = require('path');

const LORE_DIR = path.join(__dirname, '..', 'brain', 'lore');

//: Код серии в заголовке: S04E07 или F1 (фильмы).
const EPISODE_RE = /^(S\d{2}E\d{2}|F\d)\b/;

const TITLE_WEIGHT = 3;
//: Добавка за каждое слово запроса, попавшее прямо в заголовок (досье бьёт упоминания).
const TITLE_BONUS = 1.0;
//: Добавка, если запрос целиком называет героя заголовка («кто такой Фрай» → «Фрай (Philip J. Fry)»).
const HEAD_BONUS = 4.0;
const KEYS_WEIGHT = 2;
const BM25_K1 = 1.5;
const BM25_B = 0.75;

//: Ниже этого балла кусок считаем шумом, а не воспоминанием.
const MIN_SCORE = 4.0;
//: С таким баллом вспоминаем даже без вопроса «помнишь…».
const STRONG_SCORE = 6.5;

const KEYS_RE = /^\s*Ключи\s*:\s*(.*)$/i;
const WORD_RE = /[a-zа-я0-9]+/g;

// Окончания: от длинных к коротким. Стеммер грубый и одинаков для текста
// и для запроса, поэтому точность морфологии не важна — важна стабильность.
const RU_ENDINGS = [
  // прилагательные и причастия
  'ыми', 'ими', 'ого', 'его', 'ому', 'ему', 'ая', 'яя', 'ое', 'ее', 'ые', 'ие',
  'ый', 'ий', 'ой', 'ую', 'юю', 'ей', 'ых', 'их', 'ым', 'им',
  // существительные
  'ами', 'ями', 'ах', 'ях', 'ов', 'ев', 'ом', 'ем', 'ам', 'ям', 'ою', 'ею',
  'ия', 'ья', 'ию', 'ью', 'ии', 'ость', 'ости', 'ство', 'ства',
  'а', 'я', 'о', 'е', 'ы', 'и', 'у', 'ю', 'ь', 'й',
  // глаголы
  'ешь', 'ет', 'ют', 'ут', 'ишь', 'ит', 'ат', 'ят', 'ете', 'ите',
  'ала', 'ила', 'ела', 'ал', 'ил', 'ел', 'ла', 'ло', 'ли', 'л', 'ть', 'ти',
  'ан', 'ян', 'ен',
].sort((a, b) => b.length - a.length);

const EN_ENDINGS = ["'s", 'ing', 'ed', 'es', 's'];
const MIN_STEM = 3;

const STOP = new Set(
  `
  и в во не что он на я с со как а то все всё она так его но да ты к у же вы за бы по
  только ее её мне было вот от меня еще ещё нет о об из ему теперь когда даже ну ли если
  уже или ни быть был него до вас нибудь опять уж вам ведь там потом себя ничего ей может
  они тут где есть надо ней для мы тебя их чем была сам чтоб без будто чего раз тоже себе
  под будет ж тогда кто этот того потому этого какой какая какие совсем ним здесь этом
  один почти мой тем чтобы нее сейчас были куда зачем всех никогда можно при наконец два
  другой хоть после над больше тот через эти нас про всего них много разве три эту
  моя впрочем хорошо свою этой перед иногда лучше чуть том нельзя такой такая такое такие
  им более всегда конечно всю между это ли же бы вообще там тебе твой твоя
  помнишь помню вспомни вспомнишь расскажи расскажешь поведай напомни знаешь звали зовут
  старина бендер бендера бендеру бендером мясомешок эй слушай скажи ладно ну-ка
  серия серии серию серий серией эпизод эпизоде эпизода эпизоды
  the a an of and or to in on is was it who what that this
  `.split(/\s+/).filter(Boolean),
);

function normalize(text) {
  return String(text).toLowerCase().replace(/ё/g, 'е');
}

function isAsciiWord(word) {
  return /^[a-z0-9']+$/.test(word);
}

//: Грубый стеммер: отрезает самое длинное окончание, оставляя ≥3 букв.
function stem(word) {
  if (/^\d+$/.test(word)) return word;
  if (isAsciiWord(word)) {
    for (const end of EN_ENDINGS) {
      if (word.endsWith(end) && word.length - end.length >= MIN_STEM) {
        return word.slice(0, -end.length);
      }
    }
    return word;
  }
  let w = word;
  for (const refl of ['ся', 'сь']) {
    if (w.endsWith(refl) && w.length - 2 >= MIN_STEM) {
      w = w.slice(0, -2);
      break;
    }
  }
  // Несколько проходов: «розуэллом» и «розуэлл» должны сойтись в одну основу.
  for (let pass = 0; pass < 3; pass += 1) {
    let cut = false;
    for (const end of RU_ENDINGS) {
      if (w.endsWith(end) && w.length - end.length >= MIN_STEM) {
        w = w.slice(0, -end.length);
        cut = true;
        break;
      }
    }
    if (!cut) break;
  }
  return w;
}

//: Нижний регистр, ё→е, стоп-слова прочь, стемминг.
function tokenize(text) {
  const out = [];
  for (const w of normalize(text).match(WORD_RE) || []) {
    if (STOP.has(w)) continue;
    if (w.length > 1 || /^\d+$/.test(w)) out.push(stem(w));
  }
  return out;
}

// ---- разбор файлов памяти ---------------------------------------------------

//: Кусок памяти: заголовок + текст (+ ключи для поиска).
function makeChunk({ title, context, text, source, keys = '', code = '' }) {
  return {
    title,
    context,
    text,
    source,
    keys,
    code,
    tf: new Map(),
    titleToks: new Set(),
    headToks: new Set(),
    length: 0,
    get path() {
      return this.context && this.context !== this.title ? `${this.context} › ${this.title}` : this.title;
    },
  };
}

function parseFile(file) {
  const chunks = [];
  let h1 = '';
  let h2 = '';
  let title = '';
  let level = 0;
  let body = [];
  let keys = [];

  const flush = () => {
    const text = body.join('\n').trim();
    if (title && (text || keys.length)) {
      const ctx = level === 3 && h2 ? h2 : h1;
      const m = EPISODE_RE.exec(title);
      chunks.push(
        makeChunk({
          title,
          context: ctx,
          text,
          source: path.basename(file),
          keys: keys.join(', '),
          code: m ? m[1] : '',
        }),
      );
    }
  };

  const content = fs.readFileSync(file, 'utf-8');
  for (const raw of content.split(/\r?\n/)) {
    const m = /^(#{1,3})\s+(.*?)\s*$/.exec(raw);
    if (m) {
      flush();
      body = [];
      keys = [];
      level = m[1].length;
      title = m[2];
      if (level === 1) {
        h1 = title;
        h2 = '';
      } else if (level === 2) {
        h2 = title;
      }
      continue;
    }
    const km = KEYS_RE.exec(raw);
    if (km) keys.push(km[1].trim());
    else body.push(raw);
  }
  flush();
  return chunks;
}

// ---- BM25 по кускам лора ----------------------------------------------------

class LoreIndex {
  constructor(chunks) {
    this.chunks = chunks;
    const df = new Map();
    for (const c of chunks) {
      const tf = new Map();
      const parts = [
        [TITLE_WEIGHT, c.title],
        [KEYS_WEIGHT, c.keys],
        [1, c.text],
      ];
      for (const [weight, part] of parts) {
        for (const tok of tokenize(part)) tf.set(tok, (tf.get(tok) || 0) + weight);
      }
      c.tf = tf;
      c.titleToks = new Set(tokenize(c.title));
      c.headToks = new Set(tokenize(c.title.split(/[(·:—]/)[0]));
      c.length = [...tf.values()].reduce((a, b) => a + b, 0);
      for (const tok of tf.keys()) df.set(tok, (df.get(tok) || 0) + 1);
    }
    const n = Math.max(chunks.length, 1);
    this.avgLen = chunks.length ? chunks.reduce((a, c) => a + c.length, 0) / n : 1.0;
    this.idf = new Map();
    for (const [t, d] of df) this.idf.set(t, Math.log(1 + (n - d + 0.5) / (d + 0.5)));
  }

  static fromDir(dir) {
    const d = dir || LORE_DIR;
    const files = fs
      .readdirSync(d)
      .filter((name) => name.toLowerCase().endsWith('.md') && name.toLowerCase() !== 'readme.md')
      .sort();
    let chunks = [];
    for (const name of files) chunks = chunks.concat(parseFile(path.join(d, name)));
    return new LoreIndex(chunks);
  }

  search(query, { k = 3, minScore = 0 } = {}) {
    const q = [...new Set(tokenize(query))];
    if (!q.length) return [];
    const qset = new Set(q);
    const scored = [];
    for (const c of this.chunks) {
      let s = 0;
      for (const tok of q) {
        const f = c.tf.get(tok);
        if (!f) continue;
        const norm = BM25_K1 * (1 - BM25_B + (BM25_B * c.length) / this.avgLen);
        s += (this.idf.get(tok) * f * (BM25_K1 + 1)) / (f + norm);
        if (c.titleToks.has(tok)) s += this.idf.get(tok) * TITLE_BONUS;
      }
      if (s && c.headToks.size && [...c.headToks].every((t) => qset.has(t))) s += HEAD_BONUS;
      if (s > minScore) scored.push([s, c]);
    }
    scored.sort((a, b) => b[0] - a[0]);
    return scored.slice(0, k).map(([s, c]) => ({
      title: c.title,
      path: c.path,
      code: c.code,
      text: c.text,
      source: c.source,
      score: Math.round(s * 1000) / 1000,
    }));
  }

  //: Коды всех серий и фильмов в порядке файлов.
  episodes() {
    return this.chunks.filter((c) => c.code).map((c) => c.code);
  }
}

let cached = null;
let cachedDir = null;

function getIndex(loreDir) {
  const dir = loreDir || LORE_DIR;
  if (cached && cachedDir === dir) return cached;
  cached = LoreIndex.fromDir(dir);
  cachedDir = dir;
  return cached;
}

//: Что всплывает в памяти по реплике: до k кусков, лучшие первыми.
function recall(query, { k = 3, minScore = MIN_SCORE, loreDir } = {}) {
  return getIndex(loreDir).search(query, { k, minScore });
}

//: Склейка кусков для промпта или для дневника памяти.
function formatMemories(memories, budget = 2500) {
  const out = [];
  let used = 0;
  for (const m of memories || []) {
    let block = `### ${m.path}\n${m.text}`.trim();
    if (used + block.length > budget) {
      const room = budget - used;
      if (room < 200) break;
      block = `${block.slice(0, room - 1).replace(/\s+$/, '')}…`;
    }
    out.push(block);
    used += block.length + 2;
  }
  return out.join('\n\n');
}

//: Первые n предложений, не длиннее limit символов.
function firstSentences(text, { n = 2, limit = 350 } = {}) {
  const flat = String(text).split(/\s+/).filter(Boolean).join(' ');
  const parts = flat.split(/(?<=[.!?…»])\s+(?=[А-ЯЁA-Z«"(])/u);
  let out = '';
  for (const p of parts.slice(0, n)) {
    const cand = `${out} ${p}`.trim();
    if (cand.length > limit) break;
    out = cand;
  }
  if (!out) out = flat.length > limit ? `${flat.slice(0, limit - 1).replace(/\s+$/, '')}…` : flat;
  return out;
}

module.exports = {
  BM25_B,
  BM25_K1,
  HEAD_BONUS,
  KEYS_WEIGHT,
  LORE_DIR,
  LoreIndex,
  MIN_SCORE,
  STRONG_SCORE,
  TITLE_WEIGHT,
  firstSentences,
  formatMemories,
  getIndex,
  normalize,
  parseFile,
  recall,
  stem,
  tokenize,
};
