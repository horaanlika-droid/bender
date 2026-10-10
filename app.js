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

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

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
  if (admin) {
    lines.push(
      '',
      'Хозяину:',
      '/say текст — морда на планшете скажет вслух',
      '/expr happy|angry|surprised|idle — выражение морды',
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
        '• морда на планшете — глаза и рот на экране ✓\n' +
        '• лендинг + бот — готовы ✓\n' +
        `${adminLine()}\n` +
        `${faceLine()}\n` +
        '• железо (фаза 0) — не куплено\n' +
        '• корпус — отдельный раунд CAD\n\n' +
        'Касса: 500 000 ₽, расход 0. Одна задача за раунд.',
      buttons: MENU_BUTTONS,
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
      json(res, 200, {
        ok: true,
        bot: Boolean(botToken()),
        admin: adminIds().length > 0,
        uptime: Math.floor(process.uptime()),
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
      json(res, 200, { ok: true, ...data });
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

  await tgCall('sendMessage', {
    chat_id: chatId,
    text: answer.text,
    reply_markup: keyboardFor(answer.buttons || []),
  });
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
  FACE_EXPRESSIONS,
  adminIds,
  answerFor,
  createServer,
  faceCommandsSince,
  facePush,
  fillPlaceholders,
  handleUpdate,
  isAdmin,
  parseAdmins,
  publicUrl,
  start,
};

if (require.main === module) start();
