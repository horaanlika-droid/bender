// Тесты мозга на Node: lib/brain.js — память в ответе, голос морды, слот под модель.
// Живой LLM подменяем mock-сервером: ни сети, ни ключей, ни денег.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.BOT_TOKEN = '';
process.env.ADMIN_ID = '777001';
process.env.WEBAPP_URL = 'https://bender.example';
process.env.EYES_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bender-eyes-brain-'));
delete process.env.LLM_URL;

const app = require('../app.js');
const { Brain, buildSystemPrompt } = require('../lib/brain.js');

const ADMIN = 777001;
const STRANGER = 900500;

// ---- Заглушка: характер из памяти -------------------------------------------

test('память отвечает по канону: серия, фильм, герой', async () => {
  const brain = new Brain({ seed: 1 });
  const seymour = await brain.answer('помнишь Сеймура?');
  assert.equal(seymour.engine, 'stub');
  assert.match(seymour.text, /S04E07/);
  assert.match(seymour.text, /Сеймур/);

  const episode = await brain.answer('что за серия про Розуэлл');
  assert.match(episode.text, /Roswell That Ends Well/);

  const hero = await brain.answer('кто такой Фрай');
  assert.match(hero.text, /Фрай/);
});

test('чего не помню — говорю «не помню», а не выдумываю', async () => {
  const brain = new Brain({ seed: 2 });
  const reply = await brain.answer('кто такой Вася Пупкин');
  assert.match(reply.text, /Не помню/);
  assert.deepEqual(reply.memories, []);
});

test('приветствие и «скажи …» — не память, а рот', async () => {
  const brain = new Brain({ seed: 3 });
  assert.match((await brain.answer('привет')).text, /мясомешок|старина/);
  assert.equal((await brain.answer('скажи я Бендер, пожалуйста, вставьте балку')).text, 'я Бендер, пожалуйста, вставьте балку');
});

test('в памяти действительно весь канон', () => {
  const stats = new Brain().memoryStats();
  assert.equal(stats.episodes, 168);
  assert.ok(stats.chunks > 250);
});

test('системный промпт собирается из персоны и всплывшей памяти', () => {
  const memories = new Brain().recall('помнишь Сеймура?');
  const prompt = buildSystemPrompt({ memories });
  assert.match(prompt, /Ты — Бендер/);
  assert.match(prompt, /Всплыло в памяти/);
  assert.match(prompt, /Jurassic Bark/);
  assert.match(prompt, /не выдумывай/);
  assert.match(prompt, /Правила тела/);
});

// ---- Слот под живую модель --------------------------------------------------

async function withMockLlm(handler, run) {
  const mock = http.createServer(handler);
  await new Promise((resolve) => mock.listen(0, '127.0.0.1', resolve));
  const saved = {
    LLM_URL: process.env.LLM_URL,
    LLM_MODEL: process.env.LLM_MODEL,
    LLM_KIND: process.env.LLM_KIND,
  };
  process.env.LLM_URL = `http://127.0.0.1:${mock.address().port}`;
  process.env.LLM_KIND = 'ollama';
  process.env.LLM_MODEL = 'test-model';
  try {
    await run();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await new Promise((resolve) => mock.close(resolve));
  }
}

test('LLM_URL задан — отвечает модель, память уходит в системный промпт', async () => {
  let seen = null;
  await withMockLlm((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      seen = JSON.parse(body);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ message: { content: 'Помню, старина. Кусай мой блестящий металлический зад.' } }));
    });
  }, async () => {
    const brain = new Brain({ llm: undefined });
    assert.equal(brain.llm.name, 'ollama:test-model');
    const reply = await brain.answer('помнишь Сеймура?');
    assert.equal(reply.engine, 'ollama:test-model');
    assert.equal(reply.fallback, false);
    assert.match(reply.text, /старина/);
    assert.equal(seen.model, 'test-model');
    const system = seen.messages[0].content;
    assert.match(system, /Всплыло в памяти/);
    assert.match(system, /Jurassic Bark/, 'память доехала до модели');
    assert.equal(seen.messages[1].content, 'помнишь Сеймура?');
  });
});

test('модель молчит — отвечает заглушка и об этом честно сказано', async () => {
  await withMockLlm((req, res) => {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end('{"error":"модель спит"}');
  }, async () => {
    const brain = new Brain({ llm: undefined });
    const reply = await brain.answer('кто такой Фрай');
    assert.equal(reply.fallback, true);
    assert.equal(reply.engine, 'stub');
    assert.match(reply.error, /500/);
    assert.match(reply.text, /Фрай/, 'заглушка всё равно помнит канон');
  });
});

test('LLM_URL не задан — движок не выдумывается', () => {
  delete process.env.LLM_URL;
  const brain = new Brain();
  assert.equal(brain.llm, null);
});

// ---- /ask в боте ------------------------------------------------------------

test('/ask: хозяин — со ртом, чужой — только текстом', () => {
  const admin = app.answerFor(ADMIN, '/ask помнишь Сеймура?');
  assert.equal(admin.ask.query, 'помнишь Сеймура?');
  assert.equal(admin.ask.speak, true);
  assert.equal(admin.face, undefined, 'ответ асинхронный: команду морде кладём после памяти');

  const stranger = app.answerFor(STRANGER, '/ask кто такой Фрай');
  assert.equal(stranger.ask.speak, false, 'чужой не говорит моим ртом');
});

test('/ask без текста — подсказка', () => {
  const answer = app.answerFor(ADMIN, '/ask');
  assert.equal(answer.ask, undefined);
  assert.match(answer.text, /Спроси по-человечески/);
});

test('полный путь: /ask хозяина → ответ из памяти в чат и команда морде', async () => {
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
  const savedBase = process.env.TG_API_BASE;
  const savedBrain = app.getBrain();
  process.env.TG_API_BASE = `http://127.0.0.1:${mock.address().port}`;
  try {
    app.setBrain(new Brain({ seed: 5 }));
    const since = app.faceCommandsSince(0).now;
    await app.handleUpdate({ message: { chat: { id: ADMIN }, text: '/ask помнишь Сеймура?' } });

    const text = calls.find((c) => c.url.includes('/sendMessage')).body.text;
    assert.match(text, /S04E07/);
    assert.match(text, /Всплыло в памяти/);
    assert.match(text, /Jurassic Bark/);
    assert.match(text, /Морда скажет это вслух/);

    const commands = app.faceCommandsSince(since).commands;
    assert.equal(commands.length, 1);
    assert.equal(commands[0].kind, 'say');
    assert.match(commands[0].text, /S04E07/);

    // чужому — ответ без рта морды
    const before = app.faceCommandsSince(0).now;
    await app.handleUpdate({ message: { chat: { id: STRANGER }, text: '/ask кто такой Фрай' } });
    assert.deepEqual(app.faceCommandsSince(before).commands, []);
  } finally {
    process.env.TG_API_BASE = savedBase;
    app.setBrain(savedBrain);
    await new Promise((resolve) => mock.close(resolve));
  }
});

// ---- /voice: голос морды ----------------------------------------------------

test('/voice: пресеты, числа и заводской голос', () => {
  app.voiceApply('reset');
  assert.match(app.answerFor(ADMIN, '/voice bass').text, /пресет «bass»/);
  assert.deepEqual(app.voiceState(), { rate: 0.92, pitch: 0.32 });

  assert.match(app.answerFor(ADMIN, '/voice pitch=0.4 rate=1.1').text, /pitch 0.4, rate 1.1/);
  assert.deepEqual(app.voiceState(), { rate: 1.1, pitch: 0.4 });

  app.answerFor(ADMIN, '/voice reset');
  assert.deepEqual(app.voiceState(), app.VOICE_DEFAULT);

  assert.match(app.answerFor(ADMIN, '/voice pitch=9').text, /pitch 2/, 'тон режется по потолку');
  app.answerFor(ADMIN, '/voice reset');
});

test('/voice: чужому не даём, мусор — подсказка со списком', () => {
  assert.match(app.answerFor(STRANGER, '/voice bass').text, /хозяину/);
  const answer = app.answerFor(ADMIN, '/voice булькай как чайник');
  assert.match(answer.text, /Не понял/);
  assert.match(answer.text, /\/voice bass/);
});

test('/voice доезжает до морды: /api/face отдаёт настройки голоса', async () => {
  app.voiceApply('bass');
  const server = app.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const data = await (await fetch(`http://127.0.0.1:${server.address().port}/api/face?since=0`)).json();
    assert.deepEqual(data.voice, { rate: 0.92, pitch: 0.32 });
  } finally {
    app.voiceApply('reset');
    await new Promise((resolve) => server.close(resolve));
  }
});

// ---- /recall и /api/recall: память наружу -----------------------------------

test('/recall показывает, что всплыло, и не врёт про пустоту', () => {
  const found = app.answerFor(ADMIN, '/recall Сеймур').text;
  assert.match(found, /Jurassic Bark/);
  assert.match(found, /балл/);

  const empty = app.answerFor(ADMIN, '/recall Вася Пупкин').text;
  assert.match(empty, /Не|не всплыло/);

  assert.match(app.answerFor(STRANGER, '/recall Сеймур').text, /хозяину/);
  assert.match(app.answerFor(ADMIN, '/recall').text, /Что вспомнить/);
});

test('/api/recall отдаёт память как JSON, а пустой запрос — 400', async () => {
  const server = app.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const res = await fetch(`${base}/api/recall?q=${encodeURIComponent('помнишь Сеймура?')}`);
    const data = await res.json();
    assert.equal(data.ok, true);
    assert.equal(data.memories[0].code, 'S04E07');
    assert.ok(data.memories[0].preview.length > 0);

    assert.equal((await fetch(`${base}/api/recall`)).status, 400);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('/health рассказывает про память и движок', async () => {
  const server = app.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const data = await (await fetch(`http://127.0.0.1:${server.address().port}/health`)).json();
    assert.equal(data.memory.episodes, 168);
    assert.equal(data.memory.engine, 'stub', 'LLM_URL не задан — так и говорим');
    assert.ok('voice' in data);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('/help и /status знают про память, голос и /ask', () => {
  const help = app.answerFor(ADMIN, '/help').text;
  assert.match(help, /\/ask/);
  assert.match(help, /\/voice/);
  assert.match(help, /\/recall/);
  assert.doesNotMatch(app.answerFor(STRANGER, '/help').text, /\/voice/);

  const status = app.answerFor(ADMIN, '/status').text;
  assert.match(status, /память: \d+ кусков канона, 168 серий/);
  assert.match(status, /Голос морды: pitch/);
});
