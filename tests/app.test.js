// Тесты Node-слоя: морда (статика), очередь команд и Telegram-бот.
// Запуск: npm test  (node --test tests/) — рядом с python -m unittest для мозга.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

// Окружение до require: приложение читает переменные лениво, но так честнее.
process.env.BOT_TOKEN = '';
process.env.ADMIN_ID = '777001, 777002';
process.env.WEBAPP_URL = 'https://bender.example';
process.env.TG_BOT_URL = 'https://t.me/bender_test_bot';
// Кадры камеры пишем во временную папку, не в настоящий var/.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
process.env.EYES_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bender-eyes-'));

const app = require('../app.js');

const ADMIN = 777001;
const STRANGER = 900500;

// ---- Админ-список ----------------------------------------------------------

test('parseAdmins понимает запятые, пробелы и мусор', () => {
  assert.deepEqual(app.parseAdmins('777001, 777002'), [777001, 777002]);
  assert.deepEqual(app.parseAdmins('777001 777002'), [777001, 777002]);
  assert.deepEqual(app.parseAdmins('777001;777002'), [777001, 777002]);
  assert.deepEqual(app.parseAdmins('мама, 5'), [5]);
  assert.deepEqual(app.parseAdmins(''), []);
  assert.deepEqual(app.parseAdmins('0'), []);
});

test('isAdmin: свой — да, чужой — нет', () => {
  assert.equal(app.isAdmin(ADMIN), true);
  assert.equal(app.isAdmin(777002), true);
  assert.equal(app.isAdmin(STRANGER), false);
  assert.equal(app.isAdmin('777001'), true, 'chat id может прийти строкой');
});

// ---- /id и права -----------------------------------------------------------

test('/id отдаёт chat id и статус админа', () => {
  const admin = app.answerFor(ADMIN, '/id');
  assert.match(admin.text, /777001/);
  assert.match(admin.text, /Админ: да/);

  const stranger = app.answerFor(STRANGER, '/id');
  assert.match(stranger.text, /Админ: нет/);
  assert.match(stranger.text, /ADMIN_ID/, 'чужому подсказываем, что такое ADMIN_ID');
});

test('без ADMIN_ID админ-команд нет: /say отказывает', () => {
  const saved = process.env.ADMIN_ID;
  process.env.ADMIN_ID = '';
  try {
    const answer = app.answerFor(ADMIN, '/say привет');
    assert.equal(answer.face, undefined, 'без админа команда морде не уходит');
    assert.match(answer.text, /Не твоё/);
  } finally {
    process.env.ADMIN_ID = saved;
  }
});

// ---- /say: хозяин говорит через морду планшета -----------------------------

test('/say от админа кладёт фразу в очередь морды', () => {
  const answer = app.answerFor(ADMIN, '/say Кусай мой блестящий металлический зад!');
  assert.equal(answer.face.length, 1);
  assert.equal(answer.face[0].kind, 'say');
  assert.equal(answer.face[0].text, 'Кусай мой блестящий металлический зад!');
  assert.match(answer.text, /Морда скажет/);
});

test('/say с упоминанием бота (/say@bot) работает', () => {
  const answer = app.answerFor(ADMIN, '/say@bender_test_bot Я Бендер.');
  assert.deepEqual(answer.face, [{ kind: 'say', text: 'Я Бендер.' }]);
});

test('/say без текста — подсказка, а не пустая реплика', () => {
  const answer = app.answerFor(ADMIN, '/say');
  assert.equal(answer.face, undefined);
  assert.match(answer.text, /Пусто/);
});

test('/say обрезает слишком длинную фразу', () => {
  const answer = app.answerFor(ADMIN, `/say ${'а'.repeat(500)}`);
  assert.equal(answer.face[0].text.length, 400);
  assert.match(answer.text, /обрезал/);
});

test('/say от чужого — отказ без команды морде', () => {
  const answer = app.answerFor(STRANGER, '/say я тут побуду ботом');
  assert.equal(answer.face, undefined);
  assert.match(answer.text, /хозяина/);
});

// ---- /expr -----------------------------------------------------------------

test('/expr из списка уходит морде, левое — нет', () => {
  const ok = app.answerFor(ADMIN, '/expr happy');
  assert.deepEqual(ok.face, [{ kind: 'expr', text: 'happy' }]);

  const bad = app.answerFor(ADMIN, '/expr веселье');
  assert.equal(bad.face, undefined);
  assert.match(bad.text, /idle, happy, angry, surprised/);
});

test('/expr от чужого — отказ', () => {
  const answer = app.answerFor(STRANGER, '/expr angry');
  assert.equal(answer.face, undefined);
  assert.match(answer.text, /Не твоё/);
});

// ---- Прочие команды --------------------------------------------------------

test('/help у админа длиннее: /say и /expr видны только хозяину', () => {
  const admin = app.answerFor(ADMIN, '/help').text;
  const stranger = app.answerFor(STRANGER, '/help').text;
  assert.match(admin, /\/say/);
  assert.match(admin, /\/expr/);
  assert.match(admin, /\/id/);
  assert.doesNotMatch(stranger, /\/say/);
});

test('/start для хозяина упоминает управление мордой', () => {
  assert.match(app.answerFor(ADMIN, '/start').text, /морда скажет вслух/);
  assert.doesNotMatch(app.answerFor(STRANGER, '/start').text, /морда скажет вслух/);
});

test('/ping отвечает про аптайм и очередь', () => {
  const answer = app.answerFor(ADMIN, '/ping');
  assert.match(answer.text, /Аптайм/);
  assert.match(answer.text, /очереди морды/);
});

test('/status помнит про кассу, админа и планшет', () => {
  const text = app.answerFor(ADMIN, '/status').text;
  assert.match(text, /500 000/);
  assert.match(text, /ADMIN_ID/);
  assert.match(text, /планшет/);
});

test('незнакомый текст — не выдумываем команд', () => {
  const answer = app.answerFor(ADMIN, 'сделай мне бутерброд');
  assert.equal(answer.face, undefined);
  assert.match(answer.text, /Не понял/);
});

// ---- Очередь команд морды --------------------------------------------------

test('очередь морды: since отдаёт только новое', () => {
  const before = app.faceCommandsSince(0).now;
  const a = app.facePush('say', 'первая');
  const b = app.facePush('say', 'вторая');

  const all = app.faceCommandsSince(before);
  assert.deepEqual(all.commands.map((c) => c.text), ['первая', 'вторая']);
  assert.equal(all.now, b.id);
  assert.deepEqual(app.faceCommandsSince(a.id).commands.map((c) => c.text), ['вторая']);
  assert.deepEqual(app.faceCommandsSince(b.id).commands, []);
});

test('очередь морды не растёт бесконечно', () => {
  for (let i = 0; i < 80; i += 1) app.facePush('say', `фраза ${i}`);
  const state = app.faceCommandsSince(0);
  assert.ok(state.commands.length <= 50, 'старое вытесняется, память не течёт');
  const ids = state.commands.map((c) => c.id);
  assert.deepEqual(ids, [...ids].sort((x, y) => x - y), 'порядок по id');
});

// ---- HTTP: статика, /health, /api/face -------------------------------------

async function withServer(run) {
  const server = app.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    await run(`http://127.0.0.1:${port}`, port);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function rawRequest(port, path, headers) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method: 'GET', headers: headers || {} }, (res) => {
      let body = '';
      res.setEncoding('utf-8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body, headers: res.headers }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('/health отвечает ok, без токена бот выключен', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/health`);
    const data = await res.json();
    assert.equal(data.ok, true);
    assert.equal(data.bot, false, 'BOT_TOKEN пуст — бот выключен, но сервер жив');
    assert.equal(data.admin, true);
    assert.ok('uptime' in data);
  });
});

test('морда отдаётся и плейсхолдеры подставлены', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/`);
    const html = await res.text();
    assert.equal(res.status, 200);
    assert.match(html, /БЕНДЕР/);
    assert.doesNotMatch(html, /%PUBLIC_URL%/, 'og:image должен получить реальный адрес');
    assert.match(html, /https:\/\/bender\.example\/images\/hero\.jpg/);
  });
});

test('лендинг получает ссылку на бота из TG_BOT_URL', async () => {
  await withServer(async (base) => {
    const html = await (await fetch(`${base}/about.html`)).text();
    assert.doesNotMatch(html, /%TG_BOT_URL%/);
    assert.match(html, /https:\/\/t\.me\/bender_test_bot/);
  });
});

test('/api/face отдаёт команды хозяина и отмечает, что морда на связи', async () => {
  await withServer(async (base) => {
    const since = app.faceCommandsSince(0).now;
    app.facePush('say', 'Проверка связи, старина.');

    const res = await fetch(`${base}/api/face?since=${since}`);
    const data = await res.json();
    assert.equal(data.ok, true);
    assert.deepEqual(data.commands.map((c) => c.text), ['Проверка связи, старина.']);
    assert.ok(data.now > since);

    // повторный опрос с новым курсором — пусто, команда не повторяется
    const again = await (await fetch(`${base}/api/face?since=${data.now}`)).json();
    assert.deepEqual(again.commands, []);

    const health = await (await fetch(`${base}/health`)).json();
    assert.ok(health.face.lastSeenAt, 'после опроса /health знает, что морда на связи');
  });
});

test('/api/face?since=мусор не ломается', async () => {
  await withServer(async (base) => {
    const data = await (await fetch(`${base}/api/face?since=вчера`)).json();
    assert.equal(data.ok, true);
    assert.ok(Array.isArray(data.commands));
  });
});

test('файлы вне public/ не отдаются (path traversal закрыт)', async () => {
  await withServer(async (base, port) => {
    const res = await rawRequest(port, '/..%2fapp.js');
    assert.equal(res.status, 403);
    const missing = await fetch(`${base}/not-here.txt`);
    assert.equal(missing.status, 404);
  });
});

test('записи голоса морды отдаются как аудио, манифест — как JSON', async () => {
  await withServer(async (base) => {
    const manifestRes = await fetch(`${base}/audio/manifest.json`);
    const manifest = await manifestRes.json();
    assert.match(manifestRes.headers.get('content-type'), /application\/json/);
    assert.ok(manifest.lines.length >= 5, 'в наборе голосовых файлов');

    for (const line of manifest.lines) {
      const res = await fetch(`${base}/audio/${line.file}`);
      assert.equal(res.status, 200, `нет файла ${line.file}`);
      assert.match(res.headers.get('content-type'), /audio\/mpeg/, `${line.file} — не аудио`);
      const bytes = (await res.arrayBuffer()).byteLength;
      assert.ok(bytes > 1000, `${line.file} подозрительно пустой: ${bytes} байт`);
    }
  });
});

// ---- Полный путь: хозяин пишет боту → морда планшета говорит ---------------
// Telegram подменяем локальным mock-сервером: проверяем весь путь, без сети.

async function withMockTelegram(run) {
  const calls = [];
  const mock = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      calls.push({ url: req.url, body: JSON.parse(body || '{}') });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, result: [] }));
    });
  });
  await new Promise((resolve) => mock.listen(0, '127.0.0.1', resolve));
  const saved = process.env.TG_API_BASE;
  process.env.TG_API_BASE = `http://127.0.0.1:${mock.address().port}`;
  try {
    await run(calls);
  } finally {
    process.env.TG_API_BASE = saved;
    await new Promise((resolve) => mock.close(resolve));
  }
}

test('хозяин пишет /say — команда доезжает до морды, чужому — отказ', async () => {
  await withMockTelegram(async (calls) => {
    await withServer(async (base) => {
      const since = app.faceCommandsSince(0).now;

      await app.handleUpdate({ message: { chat: { id: ADMIN }, text: '/say Хлещи сильнее, профессор!' } });
      const toAdmin = calls.find((c) => c.url.includes('/sendMessage')).body;
      assert.match(toAdmin.text, /Морда скажет/);

      await app.handleUpdate({ message: { chat: { id: STRANGER }, text: '/say я тоже хочу' } });
      assert.match(calls[calls.length - 1].body.text, /хозяина/);

      // планшет забирает ровно одну команду — от хозяина
      const data = await (await fetch(`${base}/api/face?since=${since}`)).json();
      assert.deepEqual(data.commands.map((c) => c.text), ['Хлещи сильнее, профессор!']);
      assert.equal(data.commands[0].kind, 'say');
    });
  });
});

test('/expr из Telegram доезжает до морды как выражение', async () => {
  await withMockTelegram(async (calls) => {
    const since = app.faceCommandsSince(0).now;
    await app.handleUpdate({ message: { chat: { id: ADMIN }, text: '/expr angry' } });
    assert.match(calls[0].body.text, /Морда: angry/);

    const last = app.faceCommandsSince(since).commands.at(-1);
    assert.equal(last.kind, 'expr');
    assert.equal(last.text, 'angry');
  });
});

test('не текст (стикер) не ломает бота', async () => {
  await withMockTelegram(async (calls) => {
    await app.handleUpdate({ message: { chat: { id: ADMIN }, sticker: { file_id: 'x' } } });
    assert.match(calls[0].body.text, /Пиши текстом/);
  });
});

test('публичный адрес берётся из Host, если WEBAPP_URL не задан', async () => {
  const saved = process.env.WEBAPP_URL;
  delete process.env.WEBAPP_URL;
  try {
    await withServer(async (_base, port) => {
      await rawRequest(port, '/health', { Host: 'bender.bothost.ru' });
      assert.equal(app.publicUrl(), 'https://bender.bothost.ru');
    });
  } finally {
    process.env.WEBAPP_URL = saved;
  }
});

// ---- глаза и уши: камера и микрофон планшета --------------------------------

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 7)]);

function resetEyes() {
  app.eyesStop();
  app.eyes.heard.length = 0;
  app.eyes.frameAt = 0;
  fs.rmSync(app.eyesDir(), { recursive: true, force: true });
}

async function post(base, route, body, headers) {
  return fetch(`${base}${route}`, { method: 'POST', headers: headers || {}, body });
}

test('/eyes on: админ получает одноразовую ссылку с токеном, чужой — отказ', () => {
  resetEyes();
  const stranger = app.answerFor(STRANGER, '/eyes on');
  assert.equal(app.eyesActive(), false, 'чужой не включает камеру');
  assert.match(stranger.text, /хозяину/);

  const admin = app.answerFor(ADMIN, '/eyes on 30');
  assert.equal(app.eyesActive(), true);
  assert.match(admin.text, /30 мин/);
  const link = admin.buttons[0][1];
  assert.match(link, /^\/\?eyes=[A-Za-z0-9_-]{20,}$/, 'токен в ссылке морды');
  assert.equal(admin.text.includes(app.eyes.token), false, 'токен не светится текстом, только кнопкой');
  resetEyes();
});

test('/eyes: время жизни режется до часа, мусор — 15 минут', () => {
  resetEyes();
  assert.match(app.answerFor(ADMIN, '/eyes on 9999').text, /60 мин/);
  assert.match(app.answerFor(ADMIN, '/eyes on чепуха').text, /15 мин/);
  resetEyes();
});

test('/eyes off гасит сессию, токен перестаёт работать', () => {
  resetEyes();
  app.answerFor(ADMIN, '/eyes on');
  const token = app.eyes.token;
  assert.equal(app.eyesTokenOk(token), true);
  app.answerFor(ADMIN, '/eyes off');
  assert.equal(app.eyesTokenOk(token), false);
  assert.match(app.answerFor(ADMIN, '/eyes status').text, /выключены/);
  resetEyes();
});

test('сессия истекает сама: старый токен больше не открывает камеру', () => {
  resetEyes();
  app.answerFor(ADMIN, '/eyes on 1');
  const token = app.eyes.token;
  app.eyes.until = Date.now() - 1;
  assert.equal(app.eyesTokenOk(token), false);
  assert.equal(app.eyesState(token).on, false);
  resetEyes();
});

test('/api/face: состояние глаз видно только владельцу токена', async () => {
  resetEyes();
  app.answerFor(ADMIN, '/eyes on');
  const token = app.eyes.token;
  await withServer(async (base) => {
    const stranger = await (await fetch(`${base}/api/face?since=0`)).json();
    assert.equal(stranger.eyes.on, false, 'без токена — выключено');
    const owner = await (await fetch(`${base}/api/face?since=0&eyes=${token}`)).json();
    assert.equal(owner.eyes.on, true);
    assert.ok(owner.eyes.leftSec > 0);
    const wrong = await (await fetch(`${base}/api/face?since=0&eyes=нет`)).json();
    assert.equal(wrong.eyes.on, false);
  });
  resetEyes();
});

test('кадр: без токена — 403, с токеном и JPEG — сохраняется, не JPEG — 415', async () => {
  resetEyes();
  app.answerFor(ADMIN, '/eyes on');
  const token = app.eyes.token;
  await withServer(async (base) => {
    const noToken = await post(base, '/api/eyes/frame', JPEG, { 'Content-Type': 'image/jpeg' });
    assert.equal(noToken.status, 403);
    assert.equal(fs.existsSync(app.eyesFramePath()), false, 'чужой кадр не пишется');

    const ok = await post(base, `/api/eyes/frame?token=${token}`, JPEG, { 'Content-Type': 'image/jpeg' });
    assert.equal(ok.status, 200);
    assert.deepEqual(fs.readFileSync(app.eyesFramePath()), JPEG);
    assert.ok(app.eyes.frameAt > 0);
    assert.equal(fs.existsSync(`${app.eyesFramePath()}.tmp`), false, 'атомарная запись: tmp убран');

    const notJpeg = await post(base, `/api/eyes/frame?token=${token}`, Buffer.from('hello'));
    assert.equal(notJpeg.status, 415);
  });
  resetEyes();
});

test('кадр: слишком большой — 413, на диск не пишется', async () => {
  resetEyes();
  app.answerFor(ADMIN, '/eyes on');
  const token = app.eyes.token;
  await withServer(async (base) => {
    const huge = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(500 * 1024)]);
    const res = await post(base, `/api/eyes/frame?token=${token}`, huge);
    assert.equal(res.status, 413);
    assert.equal(fs.existsSync(app.eyesFramePath()), false);
  });
  resetEyes();
});

test('речь: фраза морды уходит в память, пустая и без токена — отказ', async () => {
  resetEyes();
  app.answerFor(ADMIN, '/eyes on');
  const token = app.eyes.token;
  await withServer(async (base) => {
    const stranger = await post(base, '/api/eyes/heard', JSON.stringify({ text: 'привет' }));
    assert.equal(stranger.status, 403);

    const ok = await post(base, `/api/eyes/heard?token=${token}`, JSON.stringify({ text: '  Бендер,   ты тут? ' }));
    assert.equal(ok.status, 200);
    assert.equal(app.eyes.heard.length, 1);
    assert.equal(app.eyes.heard[0].text, 'Бендер, ты тут?', 'пробелы схлопнуты');

    const empty = await post(base, `/api/eyes/heard?token=${token}`, JSON.stringify({ text: '   ' }));
    assert.equal(empty.status, 400);
    const broken = await post(base, `/api/eyes/heard?token=${token}`, '{не json');
    assert.equal(broken.status, 400);
  });
  resetEyes();
});

test('речь: память не растёт бесконечно', () => {
  resetEyes();
  for (let i = 0; i < 40; i += 1) app.eyesHear(`фраза ${i}`);
  assert.equal(app.eyes.heard.length, 20);
  assert.equal(app.eyes.heard[19].text, 'фраза 39');
  resetEyes();
});

test('/heard и /look: хозяину, без кадра — подсказка; с кадром — фото', () => {
  resetEyes();
  assert.match(app.answerFor(ADMIN, '/look').text, /Кадров ещё не было/);
  assert.match(app.answerFor(ADMIN, '/heard').text, /Пока тихо/);
  assert.match(app.answerFor(STRANGER, '/look').text, /хозяину/);
  assert.equal(app.answerFor(STRANGER, '/look').photo, undefined);

  app.eyes.frameAt = Date.now();
  app.eyesHear('Бендер, ты тут?');
  const look = app.answerFor(ADMIN, '/look');
  assert.equal(look.photo, true, 'с кадром ответ просит отправить фото');
  assert.match(app.answerFor(ADMIN, '/heard').text, /Бендер, ты тут\?/);
  assert.match(app.answerFor(STRANGER, '/heard').text, /хозяину/);
  resetEyes();
});

test('/help: команды глаз видны хозяину, чужому — нет', () => {
  assert.match(app.answerFor(ADMIN, '/help').text, /\/eyes on/);
  assert.doesNotMatch(app.answerFor(STRANGER, '/help').text, /\/eyes/);
});
