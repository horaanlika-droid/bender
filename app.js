// BENDER — морда для планшета + лендинг + мини-бот для Telegram (BotHost).
// Ноль зависимостей: только стандартная библиотека Node 18+ (есть global fetch).
//
// Что где:
//   public/index.html — морда: глаза и рот живут НА ЭКРАНЕ iPad, вставленного в голову;
//   public/about.html — лендинг проекта;
//   /api/face         — очередь команд для морды: хозяин пишет боту /say — планшет говорит.
//
// Переменные окружения (задаются в панели BotHost):
//   BOT_TOKEN  — токен от @BotFather. Без него работают только лендинг и морда.
//   ADMIN_ID   — chat id хозяина (число). Узнать: написать боту /id. Открывает /say и /expr.
//   WEBAPP_URL — публичный адрес (для кнопок Mini App и og:image); иначе берётся из Host.
//   TG_BOT_URL — ссылка на бота, напр. https://t.me/bender_prototype_bot (кнопка на лендинге).
//   PORT       — порт HTTP, задаёт платформа.
//   EYES_DIR   — куда класть последний кадр камеры (по умолчанию var/eyes; тесты переопределяют).
//   LORE_DIR   — папка памяти (по умолчанию brain/lore; тесты переопределяют).
//   LLM_URL    — слот под живую модель: Ollama (http://127.0.0.1:11434) или OpenAI-совместимый
//                адрес. Не задан — отвечает заглушка на правилах, как brain/llm.py:StubLLM.
//   LLM_MODEL, LLM_KIND, LLM_API_KEY, LLM_TIMEOUT — уточнения к LLM_URL, по желанию.

'use strict';

const crypto = require('crypto');
const http = require('http');
const fs = require('fs');
const path = require('path');

const { Brain, llmFromEnv } = require('./lib/brain');
const lore = require('./lib/lore');

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');

const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

// ---- конфигурация из окружения ---------------------------------------------
// Читаем лениво (на каждый вызов): тесты могут менять process.env на ходу.

function env(name) {
  return (process.env[name] || '').trim();
}

function botToken() {
  return env('BOT_TOKEN');
}

// ADMIN_ID (или ADMIN_IDS) — одно число или список через запятую/пробел.
function parseAdmins(raw) {
  return String(raw || '')
    .split(/[,\s;]+/)
    .filter(Boolean)
    .map((chunk) => Number(chunk))
    .filter((id) => Number.isSafeInteger(id) && id !== 0);
}

function adminIds() {
  return parseAdmins(env('ADMIN_ID') || env('ADMIN_IDS'));
}

function isAdmin(chatId) {
  return adminIds().includes(Number(chatId));
}

// ---- публичный адрес (для кнопок и og:image) -------------------------------
// Приоритет: WEBAPP_URL / PUBLIC_URL из окружения, потом Host первого запроса.
let derivedHost = null;

function publicUrl() {
  const fromEnv = env('WEBAPP_URL') || env('PUBLIC_URL');
  if (fromEnv) return fromEnv.replace(/\/+$/, '');
  if (derivedHost) return `https://${derivedHost}`;
  return '';
}

function tgBotUrl() {
  return env('TG_BOT_URL').replace(/\/+$/, '');
}

function fillPlaceholders(html) {
  return html
    .replaceAll('%PUBLIC_URL%', publicUrl())
    .replaceAll('%TG_BOT_URL%', tgBotUrl());
}

// ---- очередь команд для морды ----------------------------------------------
// Бот кладёт сюда команды (/say, /expr), морда на планшете забирает их через
// GET /api/face?since=N. Память — до перезапуска процесса, этого хватает: морда
// опрашивает сервер каждые две секунды.

const FACE_QUEUE_LIMIT = 50;
const face = { nextId: 1, items: [], lastSeenAt: 0 };

function facePush(kind, text) {
  const item = { id: face.nextId++, kind, text, at: Date.now() };
  face.items.push(item);
  if (face.items.length > FACE_QUEUE_LIMIT) {
    face.items.splice(0, face.items.length - FACE_QUEUE_LIMIT);
  }
  return item;
}

function faceCommandsSince(since) {
  const n = Number(since);
  const from = Number.isSafeInteger(n) && n >= 0 ? n : 0;
  return {
    now: face.nextId - 1,
    commands: face.items.filter((item) => item.id > from),
  };
}

// ---- глаза и уши: камера и микрофон планшета --------------------------------
// Включает только хозяин: /eyes on → бот даёт кнопку «Открыть глаза» с токеном.
// Без токена морда не шлёт кадры и не слушает речь, даже если кто-то открыл её
// по адресу. Токен живёт EYES_TTL (по умолчанию 15 мин), /eyes off гасит сразу.
// Последний кадр лежит в var/eyes/latest.jpg (var/ в .gitignore), фразы — в памяти.

const EYES_TTL_DEFAULT_MIN = 15;
const EYES_TTL_MAX_MIN = 60;
const EYES_FRAME_MAX_BYTES = 400 * 1024;
const EYES_HEARD_LIMIT = 20;
const EYES_HEARD_MAX_CHARS = 300;
const EYES_JSON_MAX_BYTES = 4096;

const eyes = { token: '', until: 0, frameAt: 0, nextHeardId: 1, heard: [] };

// Каталог кадра. Переопределяется тестами (EYES_DIR); мозг читает тот же путь.
function eyesDir() {
  return env('EYES_DIR') || path.join(__dirname, 'var', 'eyes');
}

function eyesFramePath() {
  return path.join(eyesDir(), 'latest.jpg');
}

function eyesActive() {
  return Boolean(eyes.token) && Date.now() < eyes.until;
}

function eyesStart(minutes) {
  const raw = Number(minutes);
  const min = Math.min(Math.max(Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : EYES_TTL_DEFAULT_MIN, 1), EYES_TTL_MAX_MIN);
  eyes.token = crypto.randomBytes(16).toString('base64url');
  eyes.until = Date.now() + min * 60000;
  return { token: eyes.token, minutes: min };
}

function eyesStop() {
  eyes.token = '';
  eyes.until = 0;
}

// Сравнение токена без утечки по времени.
function eyesTokenOk(candidate) {
  if (!eyesActive() || typeof candidate !== 'string' || !candidate) return false;
  const a = Buffer.from(candidate);
  const b = Buffer.from(eyes.token);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Что морда узнаёт при опросе: включено ли ей (только для владельца токена).
function eyesState(candidate) {
  const on = eyesTokenOk(candidate);
  return { on, leftSec: on ? Math.ceil((eyes.until - Date.now()) / 1000) : 0 };
}

async function eyesSaveFrame(buffer) {
  await fs.promises.mkdir(eyesDir(), { recursive: true });
  const target = eyesFramePath();
  const tmp = `${target}.tmp`;
  await fs.promises.writeFile(tmp, buffer);
  await fs.promises.rename(tmp, target); // атомарно: мозг не читает полкадра
  eyes.frameAt = Date.now();
}

function eyesHear(text) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim().slice(0, EYES_HEARD_MAX_CHARS);
  if (!clean) return null;
  const item = { id: eyes.nextHeardId++, text: clean, at: Date.now() };
  eyes.heard.push(item);
  if (eyes.heard.length > EYES_HEARD_LIMIT) eyes.heard.splice(0, eyes.heard.length - EYES_HEARD_LIMIT);
  return item;
}

function clockText(ms) {
  return new Date(ms).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Moscow' });
}

function secondsAgoText(ms) {
  return `${Math.max(0, Math.round((Date.now() - ms) / 1000))} с назад`;
}

// ---- мозг: память канона и голос морды --------------------------------------
// Бот отвечает не заготовками, а воспоминаниями: lib/brain.js берёт те же файлы
// brain/lore/*.md, что и python-мозг (brain/lore.py). Хозяин пишет /ask — морда
// на планшете говорит ответ вслух тем голосом, который выставлен здесь.

const VOICE_DEFAULT = { rate: 1.0, pitch: 0.55 };
const VOICE_PRESETS = {
  bender: { rate: 1.0, pitch: 0.55 }, // по умолчанию: низкий, ровный
  bass: { rate: 0.92, pitch: 0.32 }, // железный бас, «старина»
  fast: { rate: 1.3, pitch: 0.6 }, // тараторит, как в дубляже
};
const voice = { ...VOICE_DEFAULT };

function voiceState() {
  return { ...voice };
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

//: Разбор /voice: пресеты «bender|bass|fast» или «pitch=0.4 rate=1.1».
function voiceApply(arg) {
  const raw = String(arg || '').trim().toLowerCase();
  if (!raw || raw === 'reset' || raw === 'default') {
    Object.assign(voice, VOICE_DEFAULT);
    return { ok: true, note: raw ? 'вернул заводской голос' : 'голос по умолчанию' };
  }
  if (VOICE_PRESETS[raw]) {
    Object.assign(voice, VOICE_PRESETS[raw]);
    return { ok: true, note: `пресет «${raw}»` };
  }
  let touched = 0;
  for (const pair of raw.split(/[\s,;]+/).filter(Boolean)) {
    const m = /^(pitch|rate|тон|скорость)\s*[=:]\s*(\d+(?:[.,]\d+)?)$/.exec(pair);
    if (!m) continue;
    const value = Number(m[2].replace(',', '.'));
    if (!Number.isFinite(value)) continue;
    if (m[1] === 'pitch' || m[1] === 'тон') voice.pitch = clamp(value, 0, 2);
    else voice.rate = clamp(value, 0.5, 2);
    touched += 1;
  }
  if (!touched) return { ok: false };
  return { ok: true, note: 'записал' };
}

function voiceLine() {
  const preset = Object.entries(VOICE_PRESETS).find(
    ([, v]) => v.rate === voice.rate && v.pitch === voice.pitch,
  );
  return `Голос морды: pitch ${voice.pitch}, rate ${voice.rate}${preset ? ` (пресет «${preset[0]}»)` : ''}.`;
}

let brainInstance = null;

//: Мозг создаётся лениво: до первого /ask память не читается.
function getBrain() {
  if (!brainInstance) {
    brainInstance = new Brain({ loreDir: env('LORE_DIR') || undefined, llm: llmFromEnv() });
  }
  return brainInstance;
}

//: Подмена мозга в тестах (например, на живой движок с mock-сервером).
function setBrain(brain) {
  brainInstance = brain;
}

//: Реплика мясомешка → ответ Бендера из памяти (+ сведения, что всплыло).
async function benderAnswer(text) {
  return getBrain().answer(text, { k: 3 });
}

function memoryLine() {
  const brain = getBrain();
  const { chunks, episodes } = brain.memoryStats();
  const engine = brain.llm ? brain.llm.name : 'заглушка (LLM_URL не задан)';
  return `• память: ${chunks} кусков канона, ${episodes} серий и фильмов; движок — ${engine}`;
}

//: Что показать как «всплыло»: верхний кусок и осмысленные рядом.
//: Сезонные оглавления («Сезон 4 — 18 серий») в выдачу попадают по совпадению
//: слов, но воспоминанием не являются — их не показываем.
function memoryHighlights(memories, limit = 3) {
  const top = (memories || [])[0];
  if (!top) return [];
  return memories.filter((m, i) => i === 0 || m.code || m.score >= 0.8 * top.score).slice(0, limit);
}

function recallLine(query) {
  const memories = lore.recall(query, { k: 3, loreDir: env('LORE_DIR') || undefined });
  if (!memories.length) return 'Ничего не всплыло. Для меня это значит: такого не было.';
  return memories
    .map((m) => `• ${m.path} — балл ${m.score}\n  ${m.text.split('\n')[0].slice(0, 160)}`)
    .join('\n');
}

// Читает тело запроса с лимитом. Лишнее не копим в памяти — только помечаем.
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let tooBig = false;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        tooBig = true;
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (tooBig) {
        const error = new Error('too large');
        error.code = 413;
        reject(error);
      } else {
        resolve(Buffer.concat(chunks));
      }
    });
    req.on('error', reject);
  });
}

// ---- человеческие тексты ----------------------------------------------------

const FACE_EXPRESSIONS = ['idle', 'happy', 'angry', 'surprised'];
const SAY_LIMIT = 400;

function uptimeText() {
  const total = Math.floor(process.uptime());
  if (total < 60) return `${total} с`;
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${minutes} мин ${total % 60} с`;
  return `${Math.floor(minutes / 60)} ч ${minutes % 60} мин`;
}

function adminLine() {
  const ids = adminIds();
  return ids.length ? `• админ (ADMIN_ID): ${ids.join(', ')} ✓` : '• админ (ADMIN_ID): не задан — /say выключен';
}

function faceLine() {
  if (!face.lastSeenAt) return '• морда на планшете: ещё не связывалась';
  const sec = Math.round((Date.now() - face.lastSeenAt) / 1000);
  const where = sec < 5 ? 'на связи прямо сейчас' : `последний раз ${sec} с назад`;
  return `• морда на планшете: ${where}`;
}

function helpText(admin) {
  const lines = [
    'Команды:',
    '/start — морда и лендинг',
    '/status — как идёт сборка',
    '/id — твой chat id (он же ADMIN_ID для хозяина)',
    '/help — вот это сообщение',
  ];
  lines.push(
    '',
    'Поговорить со мной: /ask кто такой Фрай — отвечаю из своих воспоминаний' +
      (admin ? ' (и морда скажет вслух)' : ''),
  );
  if (admin) {
    lines.push(
      '',
      'Хозяину:',
      '/say текст — морда на планшете скажет вслух',
      '/ask текст — я вспомню канон и отвечу, морда озвучит',
      '/expr happy|angry|surprised|idle — выражение морды',
      '/voice bass|bender|fast|pitch=0.4 rate=1.1 — голос морды',
      '/recall текст — что всплывает в памяти (без ответа)',
      '/eyes on|off|status — камера и микрофон планшета (on на 15 мин, можно /eyes on 30)',
      '/look — что видит камера последним кадром',
      '/heard — что морда услышала за последнее время',
      '/ping — жив ли бот',
    );
  }
  lines.push('', 'Остальное я пока не умею — тело не приехало.');
  return lines.join('\n');
}

const MENU_BUTTONS = [['Морда', '/'], ['О проекте', '/about.html']];

// Чистая логика: что ответить на текст от chatId.
// Возвращает { text, buttons, face: [{kind, text}] } — face-команды кладёт вызывающий.
function answerFor(chatId, text) {
  const admin = isAdmin(chatId);
  const raw = (text || '').trim();
  const words = raw.split(/\s+/);
  const head = (words[0] || '').toLowerCase().replace(/@[^@\s]*$/, '');
  const arg = words.slice(1).join(' ').trim();
  const idNote = `Твой chat id: ${chatId}.`;

  if (head === '/start') {
    const owner = admin ? '\n\nТы хозяин: /say текст — морда скажет вслух, /expr — выражение.' : '';
    return {
      text:
        'Я — Бендер. Старина.\n\n' +
        'Это бот проекта: железный зад с ложной биографией и инструментами в физический мир. ' +
        'Глаза и рот живут на экране планшета — он и есть голова, тело собирается вокруг.\n\n' +
        'Спроси про канон — отвечу из своих воспоминаний: /ask кто такой Фрай.\n' +
        'Жми кнопки — всё откроется прямо тут.' +
        owner,
      buttons: MENU_BUTTONS,
    };
  }

  if (head === '/help') {
    return { text: helpText(admin), buttons: MENU_BUTTONS };
  }

  if (head === '/id' || head === '/myid' || head === '/whoami') {
    return {
      text:
        `${idNote}\nАдмин: ${admin ? 'да' : 'нет'}.` +
        (admin ? '' : '\n\nХозяину: впиши это число в переменную ADMIN_ID на BotHost — и мне откроются /say и /expr.'),
      buttons: [],
    };
  }

  if (head === '/ping') {
    return {
      text: `Живой, старина. Аптайм: ${uptimeText()}.\nКоманд в очереди морды: ${face.items.length}.`,
      buttons: [],
    };
  }

  if (head === '/status') {
    return {
      text:
        'Статус:\n' +
        '• мозг (brain/) — живёт без железа ✓\n' +
        '• память и лор сериала — в промпте ✓\n' +
        `${memoryLine()}\n` +
        `• морда на планшете — глаза и рот на экране ✓\n` +
        `• ${voiceLine()}\n` +
        `• камера и микрофон планшета — ${eyesActive() ? 'включены' : 'выключены (/eyes on)'}\n` +
        '• лендинг + бот — готовы ✓\n' +
        `${adminLine()}\n` +
        `${faceLine()}\n` +
        '• железо (фаза 0) — не куплено\n' +
        '• корпус — отдельный раунд CAD\n\n' +
        'Касса: 500 000 ₽, расход 0. Одна задача за раунд.',
      buttons: MENU_BUTTONS,
    };
  }

  // /ask — вопрос Бендеру: отвечает память (lib/brain.js), морда озвучивает ответ.
  // Текст ответа видят все, голосом морды говорит только хозяин.
  if (head === '/ask' || head === '/think' || head === '/remember') {
    if (!arg) {
      return {
        text: 'Спроси по-человечески: /ask кто такой Фрай. Ещё понимаю /ask помнишь Сеймура.',
        buttons: [],
      };
    }
    return {
      text: '',
      buttons: [],
      ask: { query: arg.slice(0, SAY_LIMIT), speak: admin },
    };
  }

  if (head === '/recall') {
    if (!admin) return { text: `Копаться в моей памяти — хозяину.\n${idNote}`, buttons: [] };
    if (!arg) return { text: 'Что вспомнить? Пиши: /recall Сеймур.', buttons: [] };
    return { text: `Всплывает по запросу «${arg.slice(0, 120)}»:\n${recallLine(arg)}`, buttons: [] };
  }

  if (head === '/voice') {
    if (!admin) return { text: `Голос морды — хозяину.\n${idNote}`, buttons: [] };
    const result = voiceApply(arg);
    if (!result.ok) {
      return {
        text:
          'Не понял. Варианты: /voice bass, /voice bender, /voice fast, ' +
          '/voice pitch=0.4 rate=1.1 или /voice reset.\n' +
          voiceLine(),
        buttons: [],
      };
    }
    return {
      text: `${result.note.charAt(0).toUpperCase()}${result.note.slice(1)}. ${voiceLine()}\nМорда подхватит в следующие 2 секунды.`,
      buttons: [],
    };
  }

  if (head === '/say') {
    if (!admin) {
      return {
        text: `Не твоё, мясомешок. Рот морды слушает только хозяина (ADMIN_ID).\n${idNote}`,
        buttons: [],
      };
    }
    if (!arg) {
      return { text: 'Пусто. Пиши так: /say Я Бендер, пожалуйста, вставьте балку.', buttons: [] };
    }
    const phrase = arg.slice(0, SAY_LIMIT);
    return {
      text: `Морда скажет: «${phrase}»${arg.length > SAY_LIMIT ? ' (обрезал — длинно)' : ''}`,
      buttons: [],
      face: [{ kind: 'say', text: phrase }],
    };
  }

  if (head === '/expr') {
    if (!admin) {
      return { text: `Не твоё, мясомешок. Выражение морды — хозяину.\n${idNote}`, buttons: [] };
    }
    const name = arg.toLowerCase();
    if (!FACE_EXPRESSIONS.includes(name)) {
      return { text: `Выражения: ${FACE_EXPRESSIONS.join(', ')}.`, buttons: [] };
    }
    return { text: `Морда: ${name}.`, buttons: [], face: [{ kind: 'expr', text: name }] };
  }

  if (head === '/eyes') {
    if (!admin) {
      return { text: `Глаза и уши — хозяину. Камера не для чужих.\n${idNote}`, buttons: [] };
    }
    const sub = (words[1] || 'status').toLowerCase();
    if (sub === 'off') {
      eyesStop();
      return { text: 'Глаза и уши выключены. Кадров и речи больше не будет.', buttons: [] };
    }
    if (sub === 'on') {
      const session = eyesStart(words[2]);
      return {
        text:
          `Глаза и уши включены на ${session.minutes} мин.\n` +
          'Открой морду на планшете кнопкой ниже: камера и микрофон заработают после тапа по экрану ' +
          '(iPad требует жест). Выключить: /eyes off.' +
          (publicUrl() ? '' : '\nАдрес морды ещё не знаю: открой её из бота (/start) и повтори /eyes on.'),
        buttons: [['Открыть глаза на планшете', `/?eyes=${session.token}`]],
      };
    }
    if (sub !== 'status') {
      return { text: 'Пиши так: /eyes on, /eyes on 30, /eyes off, /eyes status.', buttons: [] };
    }
    const left = eyesActive() ? `включены, ещё ${Math.ceil((eyes.until - Date.now()) / 60000)} мин` : 'выключены';
    const frame = eyes.frameAt ? `кадр ${secondsAgoText(eyes.frameAt)}` : 'кадров ещё не было';
    return {
      text: `Глаза и уши: ${left}.\n• камера: ${frame}\n• услышано фраз: ${eyes.heard.length}`,
      buttons: [],
    };
  }

  if (head === '/look') {
    if (!admin) return { text: `Что я вижу — хозяину.\n${idNote}`, buttons: [] };
    if (!eyes.frameAt) {
      return { text: 'Кадров ещё не было. Включи: /eyes on и открой морду на планшете.', buttons: [] };
    }
    return { text: `Вот что видит камера. Кадр ${secondsAgoText(eyes.frameAt)}.`, buttons: [], photo: true };
  }

  if (head === '/heard') {
    if (!admin) return { text: `Что я слышу — хозяину.\n${idNote}`, buttons: [] };
    if (!eyes.heard.length) {
      return { text: 'Пока тихо. Морда слушает, только если включено: /eyes on.', buttons: [] };
    }
    const lines = eyes.heard.slice(-5).map((item) => `${clockText(item.at)} — «${item.text}»`);
    return { text: `Услышал:\n${lines.join('\n')}`, buttons: [] };
  }

  return {
    text: `Не понял, мясомешок. Жми /help — там всё есть.${admin ? '\nМорда говорит по команде /say текст.' : ''}`,
    buttons: [],
  };
}

// ---- HTTP-сервер -----------------------------------------------------------

function json(res, code, payload) {
  res.writeHead(code, { 'Content-Type': mimeTypes['.json'], 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(payload));
}

async function handleEyesUpload(req, res, pathname, query) {
  if (req.method !== 'POST') {
    json(res, 405, { ok: false, error: 'только POST' });
    return;
  }
  // Токен: из ?token= или из заголовка X-Eyes-Token.
  const token = query.get('token') || req.headers['x-eyes-token'] || '';
  if (!eyesTokenOk(String(token))) {
    await readBody(req, EYES_JSON_MAX_BYTES).catch(() => null); // сливаем тело, чтобы ответ ушёл чисто
    json(res, 403, { ok: false, error: 'глаза выключены или токен устарел' });
    return;
  }

  if (pathname === '/api/eyes/frame') {
    const buffer = await readBody(req, EYES_FRAME_MAX_BYTES);
    const isJpeg = buffer.length > 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
    if (!isJpeg) {
      json(res, 415, { ok: false, error: 'нужен JPEG' });
      return;
    }
    await eyesSaveFrame(buffer);
    json(res, 200, { ok: true, bytes: buffer.length });
    return;
  }

  // /api/eyes/heard — морда прислала распознанную фразу.
  const raw = (await readBody(req, EYES_JSON_MAX_BYTES)).toString('utf-8');
  let data = null;
  try {
    data = JSON.parse(raw);
  } catch (_) {
    data = null;
  }
  const item = eyesHear(data && data.text);
  if (!item) {
    json(res, 400, { ok: false, error: 'пустая фраза' });
    return;
  }
  json(res, 200, { ok: true, id: item.id });
}

function createServer() {
  return http.createServer((req, res) => {
    const rawUrl = req.url || '/';
    const question = rawUrl.indexOf('?');
    const pathname = decodeURIComponent(question === -1 ? rawUrl : rawUrl.slice(0, question));
    const query = new URLSearchParams(question === -1 ? '' : rawUrl.slice(question + 1));

    // Запоминаем хост, с которого пришли (BotHost отдаёт свой домен).
    const host = (req.headers.host || '').split(':')[0];
    if (host && !/^(localhost|127\.0\.0\.1)$/i.test(host)) derivedHost = host;

    if (pathname === '/health') {
      const stats = getBrain().memoryStats();
      json(res, 200, {
        ok: true,
        bot: Boolean(botToken()),
        admin: adminIds().length > 0,
        uptime: Math.floor(process.uptime()),
        memory: { chunks: stats.chunks, episodes: stats.episodes, engine: getBrain().llm ? getBrain().llm.name : 'stub' },
        voice: voiceState(),
        face: {
          pending: face.items.length,
          lastSeenAt: face.lastSeenAt || null,
        },
      });
      return;
    }

    // Морда на планшете забирает здесь команды хозяина из Telegram.
    if (pathname === '/api/face' || pathname === '/api/face/poll') {
      face.lastSeenAt = Date.now();
      const data = faceCommandsSince(query.get('since'));
      json(res, 200, {
        ok: true,
        ...data,
        // eyes: включены ли камера и микрофон для этой морды (только с токеном хозяина)
        eyes: eyesState(query.get('eyes')),
        // voice: голос морды, выставленный хозяином (/voice)
        voice: voiceState(),
      });
      return;
    }

    // Что всплывает в памяти по запросу — только чтение канона, без секретов.
    if (pathname === '/api/recall') {
      const q = (query.get('q') || '').slice(0, 200);
      if (!q) {
        json(res, 400, { ok: false, error: 'нужен параметр q' });
        return;
      }
      const memories = lore
        .recall(q, { k: 3, loreDir: env('LORE_DIR') || undefined })
        .map((m) => ({ ...m, preview: m.text.split('\n')[0].slice(0, 200) }));
      json(res, 200, { ok: true, q, memories });
      return;
    }

    // Камера и микрофон планшета: кадры и распознанная речь. Только с токеном.
    if (pathname === '/api/eyes/frame' || pathname === '/api/eyes/heard') {
      handleEyesUpload(req, res, pathname, query).catch((error) => {
        console.error('глаза:', error.message);
        if (!res.headersSent) json(res, error.code === 413 ? 413 : 500, { ok: false, error: error.message });
      });
      return;
    }

    // Нормализуем путь и держим его внутри public/ (защита от path traversal).
    const rel = pathname.replace(/^\/+/, '') || 'index.html';
    const filePath = path.join(PUBLIC_DIR, path.normalize(rel));
    const resolved = path.resolve(filePath);
    if (resolved !== PUBLIC_DIR && !resolved.startsWith(PUBLIC_DIR + path.sep)) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Доступ запрещён');
      return;
    }

    fs.readFile(resolved, (error, content) => {
      if (error) {
        if (error.code === 'ENOENT' || error.code === 'EISDIR') {
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('Файл не найден');
        } else {
          res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end(`Ошибка сервера: ${error.code}`);
        }
        return;
      }
      const ext = path.extname(resolved).toLowerCase();
      const type = mimeTypes[ext] || 'application/octet-stream';
      if (ext === '.html') {
        // HTML не кешируем: в нём плейсхолдеры, зависящие от окружения.
        res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
        res.end(fillPlaceholders(content.toString('utf-8')));
        return;
      }
      const cache = ext === '.jpg' || ext === '.png' || ext === '.webp' ? 'public, max-age=86400' : 'public, max-age=3600';
      res.writeHead(200, { 'Content-Type': type, 'Cache-Control': cache });
      res.end(content);
    });
  });
}

// ---- крошечный Telegram-бот (long polling, без библиотек) -------------------
// Живёт в этом же процессе: /start, /help, /status, /id + админские /say и /expr.

// Базовый адрес API Telegram. Переопределяется только тестами (TG_API_BASE → mock).
function tgApiBase() {
  return (env('TG_API_BASE') || 'https://api.telegram.org').replace(/\/+$/, '');
}

let updateOffset = 0;

async function tgCall(method, payload) {
  const resp = await fetch(`${tgApiBase()}/bot${botToken()}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload || {}),
  });
  return resp.json();
}

function webAppButton(text, path) {
  const base = publicUrl() || tgBotUrl();
  if (!base) return null;
  return { text, web_app: { url: base + path } };
}

function keyboardFor(buttons) {
  const keyboard = [];
  for (const [label, href] of buttons) {
    const btn = webAppButton(label, href);
    if (btn) keyboard.push([btn]);
  }
  return keyboard.length ? { inline_keyboard: keyboard } : undefined;
}

// Ответ на /ask: память — вслух, память — в чат.
// Показываем, что именно всплыло: это ложные воспоминания, их видно, а не «поверь на слово».
async function answerAsk(chatId, ask) {
  let reply;
  try {
    reply = await benderAnswer(ask.query);
  } catch (error) {
    await tgCall('sendMessage', {
      chat_id: chatId,
      text: `Память заклинило: ${error.message}. Позову инженера — то есть тебя, старина.`,
    });
    return;
  }

  if (ask.speak) facePush('say', reply.text);

  const lines = [reply.text];
  const top = memoryHighlights(reply.memories);
  if (top.length) {
    lines.push('', '🧠 Всплыло в памяти:', ...top.map((m) => `• ${m.path} (${m.source}, балл ${m.score})`));
  } else {
    lines.push('', '🧠 В памяти пусто — говорю честно: не помню.');
  }
  if (reply.fallback) lines.push('', `⚠️ Модель не ответила (${reply.error}) — ответила заглушка.`);
  if (ask.speak) lines.push('', 'Морда скажет это вслух.');

  await tgCall('sendMessage', { chat_id: chatId, text: lines.join('\n').slice(0, 4000) });
}

async function handleUpdate(update) {
  const msg = update.message || update.edited_message;
  if (!msg || !msg.chat) return;
  const chatId = msg.chat.id;

  if (!msg.text) {
    await tgCall('sendMessage', { chat_id: chatId, text: 'Пиши текстом, мясомешок. Рот у меня на планшете.' });
    return;
  }

  const answer = answerFor(chatId, msg.text);
  for (const command of answer.face || []) facePush(command.kind, command.text);

  // /ask: ответ рождается в памяти (и, если настроена модель, у неё) — это асинхронно.
  if (answer.ask) {
    await answerAsk(chatId, answer.ask);
    return;
  }

  if (answer.photo) {
    const sent = await tgSendPhoto(chatId, eyesFramePath(), answer.text).catch(() => null);
    if (sent && sent.ok) return;
    await tgCall('sendMessage', { chat_id: chatId, text: 'Кадр не отправился: файла нет или Telegram не принял. Попробуй ещё раз через пару секунд.' });
    return;
  }

  await tgCall('sendMessage', {
    chat_id: chatId,
    text: answer.text,
    reply_markup: keyboardFor(answer.buttons || []),
  });
}

// Фото из файла (кадр камеры) — multipart, без библиотек: FormData есть в Node 18+.
async function tgSendPhoto(chatId, filePath, caption) {
  const buffer = await fs.promises.readFile(filePath);
  const form = new FormData();
  form.append('chat_id', String(chatId));
  if (caption) form.append('caption', caption.slice(0, 1000));
  form.append('photo', new Blob([buffer], { type: 'image/jpeg' }), 'bender-eyes.jpg');
  const resp = await fetch(`${tgApiBase()}/bot${botToken()}/sendPhoto`, { method: 'POST', body: form });
  return resp.json();
}

// Хозяин узнаёт, что бот поднялся и что ADMIN_ID прочитан.
// Небольшая задержка и повторы: ждём первого запроса, чтобы знать адрес морды
// (BotHost стучит в /health сразу после старта).
const BOOT_NOTICE_EVERY_MS = 4000;
const BOOT_NOTICE_TRIES = 5;

async function sendBootNotice() {
  const ids = adminIds();
  if (!botToken() || !ids.length) return;
  await tgCall('sendMessage', {
    chat_id: ids[0],
    text:
      '🤖 Я в сети, старина.\n' +
      `Морда: ${publicUrl() || '(адрес ещё не знаю — открой её из бота)'}\n` +
      `Админ chat id: ${ids.join(', ')}\n\n` +
      '/say текст — морда скажет вслух. /expr happy — выражение.',
    reply_markup: keyboardFor(MENU_BUTTONS),
  });
}

function scheduleBootNotice() {
  if (!botToken() || !adminIds().length) return;
  let tries = 0;
  const timer = setInterval(async () => {
    tries += 1;
    const lastTry = tries >= BOOT_NOTICE_TRIES;
    if (!publicUrl() && !lastTry) return; // ждём первого запроса — тогда адрес известен
    clearInterval(timer);
    try {
      await sendBootNotice();
    } catch (error) {
      console.error('Админу не постучался:', error.message);
    }
  }, BOOT_NOTICE_EVERY_MS);
}

async function pollLoop() {
  while (true) {
    try {
      const result = await tgCall('getUpdates', {
        offset: updateOffset,
        timeout: 50,
        allowed_updates: ['message', 'edited_message'],
      });
      if (result && result.ok && Array.isArray(result.result)) {
        for (const update of result.result) {
          updateOffset = update.update_id + 1;
          await handleUpdate(update);
        }
      }
    } catch (error) {
      console.error('getUpdates error:', error.message);
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
}

// ---- запуск ----------------------------------------------------------------

function start() {
  const server = createServer();
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ Лендинг на порту ${PORT} (public: ${PUBLIC_DIR})`);
    if (botToken()) {
      console.log('🤖 Telegram-бот: токен найден, запускаю опрос getUpdates');
      if (adminIds().length) console.log(`👑 Админ (ADMIN_ID): ${adminIds().join(', ')}`);
      else console.log('ℹ️  ADMIN_ID не задан — /say и /expr выключены. Напиши боту /id, вставь число в BotHost и перезапусти.');
    } else {
      console.log('ℹ️  BOT_TOKEN не задан — только лендинг и морда, бот выключен');
      if (adminIds().length) console.log('⚠️  ADMIN_ID задан, но без BOT_TOKEN бесполезен: нет бота, которому слушать команды');
    }
  });

  if (botToken()) {
    pollLoop().catch((error) => {
      console.error('Бот упал:', error);
      process.exit(1);
    });
    scheduleBootNotice();
  }

  return server;
}

module.exports = {
  Brain,
  FACE_EXPRESSIONS,
  VOICE_DEFAULT,
  VOICE_PRESETS,
  adminIds,
  answerAsk,
  answerFor,
  benderAnswer,
  createServer,
  eyes,
  eyesActive,
  eyesDir,
  eyesFramePath,
  eyesHear,
  eyesStart,
  eyesState,
  eyesStop,
  eyesTokenOk,
  faceCommandsSince,
  facePush,
  fillPlaceholders,
  getBrain,
  lore,
  handleUpdate,
  isAdmin,
  memoryHighlights,
  parseAdmins,
  publicUrl,
  recallLine,
  setBrain,
  start,
  voice,
  voiceApply,
  voiceLine,
  voiceState,
};

if (require.main === module) start();
