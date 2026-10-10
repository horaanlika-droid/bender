// BENDER — лендинг + мини-бот для Telegram Mini App (BotHost).
// Ноль зависимостей: только стандартная библиотека Node 18+ (есть global fetch).
// Статика — из public/, плейсхолдеры %PUBLIC_URL% / %TG_BOT_URL% подставляются на лету.

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
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

// ---- публичный адрес (для кнопок и og:image) -------------------------------
// Приоритет: WEBAPP_URL / PUBLIC_URL из окружения, потом Host первого запроса.
let derivedHost = null;

function publicUrl() {
  const fromEnv = process.env.WEBAPP_URL || process.env.PUBLIC_URL;
  if (fromEnv) return fromEnv.replace(/\/+$/, '');
  if (derivedHost) return `https://${derivedHost}`;
  return '';
}

function tgBotUrl() {
  return (process.env.TG_BOT_URL || '').replace(/\/+$/, '');
}

function fillPlaceholders(html) {
  return html
    .replaceAll('%PUBLIC_URL%', publicUrl())
    .replaceAll('%TG_BOT_URL%', tgBotUrl());
}

// ---- HTTP-сервер -----------------------------------------------------------

const server = http.createServer((req, res) => {
  const rawUrl = req.url || '/';
  const pathname = decodeURIComponent(rawUrl.split('?')[0]);

  // Запоминаем хост, с которого пришли (BotHost отдаёт свой домен).
  const host = (req.headers.host || '').split(':')[0];
  if (host && !/^(localhost|127\.0\.0\.1)$/i.test(host)) derivedHost = host;

  if (pathname === '/health') {
    res.writeHead(200, { 'Content-Type': mimeTypes['.json'] });
    res.end(JSON.stringify({ ok: true, bot: Boolean(process.env.BOT_TOKEN) }));
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

server.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Лендинг на порту ${PORT} (public: ${PUBLIC_DIR})`);
  if (process.env.BOT_TOKEN) console.log('🤖 Telegram-бот: токен найден, запускаю опрос getUpdates');
  else console.log('ℹ️  BOT_TOKEN не задан — только лендинг, бот выключен');
});

// ---- крошечный Telegram-бот (long polling, без библиотек) -------------------
// Живёт в этом же процессе: /start, /help, /status + кнопка Mini App.

const TG_API = 'https://api.telegram.org';
let updateOffset = 0;

async function tgCall(method, payload) {
  const resp = await fetch(`${TG_API}/bot${process.env.BOT_TOKEN}/${method}`, {
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

function answerFor(text) {
  const t = (text || '').trim().toLowerCase();
  if (t.startsWith('/start') || t === 'привет' || t === 'ку') {
    return {
      text:
        'Я — Бендер. Старина.\n\n' +
        'Это бот проекта: железный зад с ложной биографией и инструментами в физический мир. ' +
        'Голова — планшет с мордой в веб-приложении, тело собирается вокруг.\n\n' +
        'Жми кнопки — всё откроется прямо тут.',
      buttons: [['Морда', '/'], ['О проекте', '/about.html']],
    };
  }
  if (t.startsWith('/help')) {
    return {
      text:
        'Команды:\n' +
        '/start — морда и лендинг\n' +
        '/status — как идёт сборка\n' +
        '/help — вот это сообщение\n\n' +
        'Остальное я пока не умею — тело не приехали.',
      buttons: [['Морда', '/'], ['О проекте', '/about.html']],
    };
  }
  if (t.startsWith('/status')) {
    return {
      text:
        'Статус:\n' +
        '• мозг (brain/) — живёт без железа ✓\n' +
        '• память и лор сериала — в промпте ✓\n' +
        '• морда на планшете — вот она ✓\n' +
        '• лендинг + бот — готовы ✓\n' +
        '• железо (фаза 0) — не куплено\n' +
        '• корпус — отдельный раунд CAD\n\n' +
        'Касса: 500 000 ₽, расход 0. Одна задача за раунд.',
      buttons: [['Морда', '/'], ['О проекте', '/about.html']],
    };
  }
  return {
    text: 'Не понял, мясомешок. Жми /help — там всё есть.',
    buttons: [],
  };
}

async function handleUpdate(update) {
  const msg = update.message || update.edited_message;
  if (!msg || !msg.chat) return;
  const chatId = msg.chat.id;
  const answer = answerFor(msg.text);
  const keyboard = [];
  for (const [label, path] of answer.buttons) {
    const btn = webAppButton(label, path);
    if (btn) keyboard.push([btn]);
  }
  await tgCall('sendMessage', {
    chat_id: chatId,
    text: answer.text,
    reply_markup: keyboard.length ? { inline_keyboard: keyboard } : undefined,
  });
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

if (process.env.BOT_TOKEN) {
  pollLoop().catch((error) => {
    console.error('Бот упал:', error);
    process.exit(1);
  });
}
