// Тесты морды: public/face.js крутится в jsdom — той же программой, что и на iPad.
// Проверяем не картинку, а поведение: команда из Telegram сказана, тап подмигнул,
// голос хозяина применился, «Голос» листает голоса планшета.
//
// Движок запуска — общий с tools/shots.js (тот же jsdom-стенд, что рисует PNG).
// Важно: окно jsdom нужно закрывать всегда — его requestAnimationFrame держит
// процесс живым (поэтому here withFace, а не голый bootFace в тестах).

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.BOT_TOKEN = '';
process.env.ADMIN_ID = '777001';
process.env.WEBAPP_URL = 'https://bender.example';
process.env.EYES_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bender-eyes-face-'));
delete process.env.LLM_URL;

const { bootFace, snapshot } = require('../tools/shots.js');
const { Brain } = require('../lib/brain.js');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

//: Морда на время теста; окно закрывается даже если проверка упала.
async function withFace(options, run) {
  const ctx = await bootFace(options);
  try {
    await run(ctx);
  } finally {
    ctx.dom.window.close();
  }
}

// ---- Бот говорит через морду ------------------------------------------------

test('команда /say из очереди: морда выбирает ответ мозга и говорит его', async () => {
  const brain = new Brain({ seed: 20261010 });
  const reply = await brain.answer('помнишь Сеймура?');
  await withFace({ commands: [{ id: 1, kind: 'say', text: reply.text, at: Date.now() }] }, async ({ win, spoken }) => {
    await sleep(120); // первый опрос /api/face идёт сразу при загрузке
    const state = snapshot(win);
    assert.match(state.caption, /S04E07/, 'подпись — это ответ из памяти');
    assert.ok(spoken.some((u) => u.text.includes('Jurassic Bark')), 'морда сказала вслух');
    assert.equal(state.link, true, 'индикатор связи зелёный: сервер ответил');
  });
});

test('старую команду морда не проигрывает: выключенный планшет не заговорит сам', async () => {
  await withFace({ commands: [{ id: 1, kind: 'say', text: 'старое эхо', at: Date.now() - 60000 }] }, async ({ win, spoken }) => {
    await sleep(120);
    assert.equal(snapshot(win).caption, '');
    assert.equal(spoken.length, 0);
  });
});

test('/expr из Telegram ставит выражение: веки приопускаются, стихов не читаем', async () => {
  await withFace({ commands: [{ id: 1, kind: 'expr', text: 'angry', at: Date.now() }] }, async ({ win, spoken }) => {
    await sleep(120);
    // открытое веко в этой геометрии стоит на y = −100, гнев (0.45) даёт y = +26
    const y = Number(win.document.querySelector('#lidL rect').getAttribute('y'));
    assert.ok(y > -50, `веко приопущено, y=${y}`);
    // первое касание хозяина морда отмечает приветствием, но выражение — не реплика
    assert.deepEqual(
      spoken.map((u) => u.text),
      ['Привет, мясомешок. Я — Бендер.'],
    );
  });
});

// ---- Жесты морды ------------------------------------------------------------

test('тап по глазу подмигивает: веко закрывает глаз и отпускает', async () => {
  await withFace({}, async ({ win }) => {
    const lid = win.document.querySelector('#lidL rect');
    const openY = Number(lid.getAttribute('y'));

    win.document.getElementById('eyeL').dispatchEvent(new win.MouseEvent('pointerdown', { bubbles: true }));
    await sleep(120);
    const winkedY = Number(lid.getAttribute('y'));
    assert.ok(winkedY > openY + 100, `веко должно опуститься: было ${openY}, стало ${winkedY}`);

    await sleep(320);
    assert.equal(Number(lid.getAttribute('y')), openY, 'веко вернулось на место');
  });
});

test('тап по рту — реплика из канона, подпись видна', async () => {
  await withFace({}, async ({ win, spoken }) => {
    win.document.getElementById('mouthGroup').dispatchEvent(new win.MouseEvent('pointerdown', { bubbles: true }));
    await sleep(80);
    assert.ok(snapshot(win).caption.length > 5, 'подпись с репликой');
    assert.ok(
      spoken.some((u) => /Кусай|Построю|Убить|Бендер|красотка|стыдно|Хлещи|Сматываемся|планов|дискриминация|мясомешки/.test(u.text)),
      'сказана реплика из канона',
    );
  });
});

// ---- Голос ------------------------------------------------------------------

test('голос хозяина из Telegram применяется к речи морды', async () => {
  await withFace({ voice: { rate: 1.1, pitch: 0.4 } }, async ({ win, spoken }) => {
    await sleep(120); // даём морде получить /api/face с настройкой голоса
    win.document.getElementById('btnTalk').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    await sleep(80);
    const last = spoken.at(-1);
    assert.equal(last.pitch, 0.4, 'тон из /voice pitch=0.4');
    assert.equal(last.rate, 1.1, 'темп из /voice rate=1.1');
  });
});

test('кнопка «Голос» листает русские голоса планшета и запоминает выбор', async () => {
  await withFace({}, async ({ win, spoken }) => {
    win.document.getElementById('btnVoice').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    await sleep(80);
    assert.equal(spoken.at(-1).voice.name, 'Google русский', 'с первого Яндекс — на второй Google');
    assert.match(snapshot(win).caption, /Голос: Google русский \(2\/3\)/);
    assert.equal(win.localStorage.getItem('bender.voice'), 'Google русский', 'выбор переживёт перезагрузку');
  });
});

// ---- Глаза и уши: пилюля состояния ------------------------------------------

test('без токена пилюля глаз скрыта: морда ничего не снимает и не слушает', async () => {
  await withFace({ eyes: { on: true } }, async ({ win }) => {
    await sleep(120);
    assert.equal(snapshot(win).eyes.hidden, true);
  });
});

test('с токеном хозяина морда ждёт тапа: iPad не даёт камеру без жеста', async () => {
  await withFace({ eyesToken: 'demo-token', eyes: { on: true, leftSec: 300 } }, async ({ win }) => {
    await sleep(120);
    const state = snapshot(win);
    assert.equal(state.eyes.hidden, false, 'пилюля видна владельцу токена');
    assert.equal(state.eyes.cls, 'wait', 'статус: тапни');
    assert.match(state.eyes.text, /тапни/);
  });
});
