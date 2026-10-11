// tools/shots.js — скриншоты морды для PR и документации. Без браузера.
//
// В песочнице нет Chrome и нет экрана, поэтому «скриншот» собирается честно:
//   1. jsdom загружает настоящий public/index.html;
//   2. в него запускаются настоящие public/eyes.js и public/face.js — те же файлы,
//      что уедут на BotBoard/BotHost, с заглушками только на голос и сеть;
//   3. после реальных событий (тап по глазу, по рту, команда /say из бота) снимок
//      состояния берётся из живого DOM: SVG морды, подпись, индикаторы;
//   4. @resvg/resvg-js рисует этот SVG в PNG, а обвязку страницы (фон, кнопки,
//      подпись) тул собирает сам — по значениям из public/face.css.
//
// Так это рендер морды, а не снимок экрана iPad: браузерной вёрстки тул не знает.
// Запуск: npm run shots
//
// Картинки: docs/shots/*.png

'use strict';

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const { Resvg } = require('@resvg/resvg-js');

const { memoryHighlights } = require('../app.js');
const { Brain } = require('../lib/brain');
const lore = require('../lib/lore');

const ROOT = path.join(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public');
const OUT = path.join(ROOT, 'docs', 'shots');

const SCREEN = { w: 1180, h: 820 };
const FONT = 'DejaVu Sans';
const MONO = 'DejaVu Sans Mono';

// Палитра — из public/face.css
const C = {
  bg: '#0d0f13',
  bgTop: '#1a1e25',
  gold: '#f2c94c',
  goldSoft: 'rgba(242, 201, 76, 0.45)',
  goldFaint: 'rgba(242, 201, 76, 0.35)',
  btnBg: 'rgba(20, 23, 29, 0.85)',
  btnActive: 'rgba(242, 201, 76, 0.18)',
  captionBg: 'rgba(10, 12, 16, 0.72)',
  pillBg: 'rgba(20, 23, 29, 0.7)',
  pillBorder: 'rgba(120, 130, 145, 0.35)',
  pillText: 'rgba(200, 208, 218, 0.55)',
  green: '#5ee07a',
  greenText: 'rgba(126, 224, 143, 0.9)',
  hint: 'rgba(220, 225, 232, 0.45)',
  muted: 'rgba(200, 208, 218, 0.35)',
};

// ---- мелкие помощники -------------------------------------------------------

function esc(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

//: Детерминированный ГПСЧ: одинаковый сценарий — одинаковые картинки в PR.
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

//: Прикидка ширины строки: точной метрики у нас нет, шрифт — DejaVu, кириллица.
function textWidth(text, size, mono = false) {
  return String(text).length * size * (mono ? 0.62 : 0.55);
}

function wrap(text, size, maxWidth, mono = false) {
  const lines = [];
  for (const paragraph of String(text).split('\n')) {
    const words = paragraph.split(/\s+/).filter(Boolean);
    let line = '';
    for (const word of words) {
      const candidate = line ? `${line} ${word}` : word;
      if (textWidth(candidate, size, mono) > maxWidth && line) {
        lines.push(line);
        line = word;
      } else {
        line = candidate;
      }
    }
    lines.push(line); // пустая строка — это тоже строка абзаца
  }
  return lines;
}

//: Шрифты песочницы (DejaVu) не знают эмодзи — в картинке они станут пустым
//: квадратом. Убираем символы и оставляем текст: карточка — иллюстрация, не копия.
function stripEmoji(text) {
  return String(text)
    .replace(/\p{Extended_Pictographic}[\uFE0F\u200D\u20E3]*/gu, '')
    .replace(/[\u2600-\u27BF]/g, '')
    .replace(/  +/g, ' ')
    .trimStart();
}

function rect(x, y, w, h, r, attrs = '') {
  return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" ${attrs}/>`;
}

function textLine(x, y, text, attrs = '') {
  return `<text x="${x}" y="${y}" ${attrs}>${esc(text)}</text>`;
}

// ---- окно морды: jsdom + настоящий face.js ----------------------------------

//: Голоса, которые «нашёл» планшет: у iPad их несколько, у песочницы — ни одного.
const VOICES = [
  { name: 'Yandex Milena', lang: 'ru-RU', voiceURI: 'Yandex Milena' },
  { name: 'Google русский', lang: 'ru-RU', voiceURI: 'Google русский' },
  { name: 'Алёна (системный)', lang: 'ru-RU', voiceURI: 'Алёна (системный)' },
];

async function bootFace({ commands = [], voice = { rate: 1, pitch: 0.55 }, eyes = { on: false }, eyesToken = '', seed = 20261010 } = {}) {
  const html = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf-8');
  const dom = new JSDOM(html, {
    url: 'http://localhost:3000/',
    runScripts: 'outside-only', // внешние скрипты (Telegram) не тянем
    pretendToBeVisual: true, // настоящий requestAnimationFrame
  });
  const win = dom.window;
  win.Math.random = mulberry32(seed);

  // Звука в песочнице нет — подменяем только speechSynthesis, логика морды та же.
  // Всё, что морда «сказала», складываем в spoken: скриншотам не нужно, тестам — да.
  const spoken = [];
  win.speechSynthesis = {
    getVoices: () => VOICES,
    speak(utterance) { spoken.push(utterance); },
    cancel() {},
    onvoiceschanged: null,
  };
  win.SpeechSynthesisUtterance = class {
    constructor(text) {
      this.text = text;
    }
  };

  if (eyesToken) {
    try {
      win.localStorage.setItem('bender_eyes_token', eyesToken);
    } catch (_) { /* не критично */ }
  }

  // Записи настоящего голоса лежат файлами; в песочнице звука нет, поэтому
  // играем в пустоту, но честно проигрываем: манифест читаем с диска.
  const played = [];
  win.Audio = class {
    constructor(url) { this.url = String(url); }
    play() { played.push(this.url); return Promise.resolve(); }
    pause() {}
  };

  // Сеть: сервер отдаёт ровно то, что нам нужно показать. Настоящий путь
  // «бот → очередь → морда» проверяется в tests/, здесь — декорация состояния.
  // Манифест записей читаем с диска: это тот же файл, что отдаст BotHost.
  win.fetch = async (url) => {
    const target = String(url);
    if (target.includes('audio/manifest.json')) {
      const text = fs.readFileSync(path.join(PUBLIC, 'audio', 'manifest.json'), 'utf-8');
      return { ok: true, status: 200, json: async () => JSON.parse(text) };
    }
    return {
      ok: true,
      status: 200,
      json: async () =>
        target.includes('heard')
          ? { ok: true }
          : { ok: true, now: commands.length, commands, eyes, voice },
    };
  };

  for (const file of ['eyes.js', 'face.js']) {
    win.eval(fs.readFileSync(path.join(PUBLIC, file), 'utf-8'));
  }
  return { dom, win, spoken, played };
}

//: Снимок живого DOM: морда, подпись, индикаторы — то же, что видит планшет.
function snapshot(win) {
  const doc = win.document;
  const pill = doc.getElementById('eyes');
  return {
    face: doc.getElementById('face').outerHTML,
    caption: doc.getElementById('caption').classList.contains('show')
      ? doc.getElementById('caption').textContent
      : '',
    hint: !doc.getElementById('hint').classList.contains('hide'),
    link: doc.getElementById('link').classList.contains('on'),
    eyes: {
      hidden: pill.hidden,
      cls: pill.className,
      text: pill.querySelector('.txt').textContent,
    },
  };
}

function press(win, id, options = {}) {
  const el = win.document.getElementById(id);
  el.dispatchEvent(new win.MouseEvent('pointerdown', { bubbles: true, ...options }));
}

function click(win, id) {
  win.document.getElementById(id).dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
}

// ---- сборка кадра страницы --------------------------------------------------

function faceInner(svgText) {
  return svgText.replace(/^<svg[^>]*>/, '').replace(/<\/svg>$/, '');
}

function hudButtons(active) {
  const buttons = ['Реплика', 'Голос', 'Полный экран', 'О проекте'];
  const ids = { Реплика: 'btnTalk', Голос: 'btnVoice', 'Полный экран': 'btnFull', 'О проекте': 'btnAbout' };
  const size = 15;
  const gap = 10;
  const widths = buttons.map((label) => textWidth(label, size) + 36);
  const total = widths.reduce((a, b) => a + b, 0) + gap * (buttons.length - 1);
  let x = SCREEN.w / 2 - total / 2;
  const y = SCREEN.h - 26 - 44;
  const parts = [];
  buttons.forEach((label, index) => {
    const w = widths[index];
    const on = ids[label] === active;
    parts.push(
      rect(x, y, w, 44, 22, `fill="${on ? C.btnActive : C.btnBg}" stroke="${C.goldSoft}" stroke-width="1"`),
    );
    parts.push(
      textLine(x + w / 2, y + 28, label, `fill="${C.gold}" font-size="${size}" font-weight="600" text-anchor="middle"`),
    );
    x += w + gap;
  });
  return parts.join('\n');
}

function captionBlock(caption) {
  if (!caption) return '';
  const size = 20;
  const maxWidth = Math.min(SCREEN.w * 0.86, 720) - 44;
  const lines = wrap(caption, size, maxWidth);
  const lineH = 29;
  const widest = Math.max(...lines.map((l) => textWidth(l, size)));
  const boxW = widest + 44;
  const boxH = lines.length * lineH + 24;
  const x = SCREEN.w / 2 - boxW / 2;
  const y = SCREEN.h - 96 - boxH;
  const parts = [
    rect(x, y, boxW, boxH, 16, `fill="${C.captionBg}" stroke="${C.goldFaint}" stroke-width="1"`),
  ];
  lines.forEach((line, index) => {
    parts.push(
      textLine(x + boxW / 2, y + 22 + index * lineH + 6, line, `fill="${C.gold}" font-size="${size}" text-anchor="middle"`),
    );
  });
  return parts.join('\n');
}

function pills(state) {
  const parts = [];
  // индикатор связи с ботом — правый верхний угол.
  // Заглавные буквы с letter-spacing шире прикидки: считаем и разрядку.
  const ls = 0.7;
  const pillWidth = (text) => textWidth(text, 12) + String(text).length * ls + 44;

  const label = 'БОТ';
  const w = pillWidth(label);
  const x = SCREEN.w - 16 - w;
  const y = 16;
  parts.push(rect(x, y, w, 30, 15, `fill="${C.pillBg}" stroke="${state.link ? 'rgba(94, 224, 122, 0.45)' : C.pillBorder}" stroke-width="1"`));
  parts.push(`<circle cx="${x + 16}" cy="${y + 15}" r="4" fill="${state.link ? C.green : '#6a7280'}"/>`);
  parts.push(
    textLine(x + 30, y + 20, label, `fill="${state.link ? C.greenText : C.pillText}" font-size="12" letter-spacing="0.7"`),
  );

  if (!state.eyes.hidden) {
    const eyesText = String(state.eyes.text).toUpperCase();
    const ew = pillWidth(eyesText);
    const ex = SCREEN.w - 16 - ew;
    const ey = 58;
    const tone = state.eyes.cls === 'on' ? C.green : state.eyes.cls === 'wait' ? C.gold : '#6a7280';
    const toneText = state.eyes.cls === 'on' ? C.greenText : state.eyes.cls === 'wait' ? 'rgba(242, 201, 76, 0.9)' : C.pillText;
    parts.push(rect(ex, ey, ew, 30, 15, `fill="${C.pillBg}" stroke="${state.eyes.cls === 'off' ? C.pillBorder : tone}" stroke-width="1"`));
    parts.push(`<circle cx="${ex + 16}" cy="${ey + 15}" r="4" fill="${tone}"/>`);
    parts.push(textLine(ex + 30, ey + 20, eyesText, `fill="${toneText}" font-size="12" letter-spacing="0.7"`));
  }

  if (state.hint) {
    parts.push(
      textLine(SCREEN.w / 2, 34, 'Тапни по глазу, рту или лбу', `fill="${C.hint}" font-size="13" letter-spacing="0.5" text-anchor="middle"`),
    );
  }
  return parts.join('\n');
}

//: Полный кадр: фон, морда, подпись, кнопки, индикаторы.
function screenSvg(state, { active = '', label = '' } = {}) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${SCREEN.w}" height="${SCREEN.h}" viewBox="0 0 ${SCREEN.w} ${SCREEN.h}">
  <defs>
    <radialGradient id="stageBg" cx="50%" cy="20%" r="120%">
      <stop offset="0%" stop-color="${C.bgTop}"/>
      <stop offset="70%" stop-color="${C.bg}"/>
    </radialGradient>
  </defs>
  <rect width="${SCREEN.w}" height="${SCREEN.h}" fill="url(#stageBg)"/>
  <svg x="0" y="0" width="${SCREEN.w}" height="${SCREEN.h}" viewBox="0 0 1200 800" preserveAspectRatio="xMidYMid meet">
${faceInner(state.face)}
  </svg>
${captionBlock(state.caption)}
${pills(state)}
${hudButtons(active)}
${label ? textLine(20, SCREEN.h - 16, label, `fill="${C.muted}" font-size="12" font-family="${MONO}"`) : ''}
</svg>`;
}

//: Карточка с логом памяти или перепиской — тоже SVG, чтобы не тащить браузер.
function cardSvg({ title, subtitle, lines, width = SCREEN.w, height = SCREEN.h, font = MONO, size = 17 }) {
  const pad = 36;
  const body = [];
  let y = 132;
  for (const line of lines) {
    const attrs = line.tone || `fill="rgba(214, 221, 232, 0.86)"`;
    for (const part of wrap(stripEmoji(line.text), size, width - pad * 2, font === MONO)) {
      body.push(textLine(pad, y, part, `font-family="${font}" font-size="${size}" ${attrs}`));
      y += line.gap || Math.round(size * 1.45);
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <defs>
    <radialGradient id="cardBg" cx="50%" cy="0%" r="130%">
      <stop offset="0%" stop-color="#171b22"/>
      <stop offset="75%" stop-color="${C.bg}"/>
    </radialGradient>
  </defs>
  <rect width="${width}" height="${height}" fill="url(#cardBg)"/>
  ${rect(pad / 2, pad / 2, width - pad, height - pad, 22, `fill="rgba(16, 18, 23, 0.92)" stroke="${C.goldFaint}" stroke-width="1"`)}
  ${textLine(pad, 78, title, `fill="${C.gold}" font-size="24" font-weight="600"`)}
  ${subtitle ? textLine(pad, 104, subtitle, `fill="${C.muted}" font-size="14"`) : ''}
  ${body.join('\n')}
</svg>`;
}

//: Переписка в Telegram — макет: в песочнице нет ни Telegram, ни браузера.
function chatSvg({ title, messages }) {
  const pad = 36;
  const width = 760;
  const height = 900;
  const body = [];
  let y = 108;
  for (const message of messages) {
    const left = message.from === 'bender';
    const size = 17;
    const maxW = width * 0.78;
    const lines = wrap(stripEmoji(message.text), size, maxW - 32);
    const boxW = Math.min(maxW, Math.max(...lines.map((l) => textWidth(l, size))) + 32);
    const boxH = lines.length * 24 + 20;
    const x = left ? pad : width - pad - boxW;
    body.push(rect(x, y, boxW, boxH, 14, `fill="${left ? 'rgba(28, 32, 40, 0.95)' : 'rgba(242, 201, 76, 0.16)'}" stroke="${left ? C.pillBorder : C.goldFaint}" stroke-width="1"`));
    lines.forEach((line, index) => {
      body.push(
        textLine(x + 16, y + 28 + index * 24, line, `fill="${left ? 'rgba(220, 226, 234, 0.92)' : C.gold}" font-size="${size}"`),
      );
    });
    y += boxH + 14;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <rect width="${width}" height="${height}" fill="#0f1216"/>
  <rect x="0" y="0" width="${width}" height="72" fill="#141a21"/>
  ${textLine(pad, 46, title, `fill="#e8edf4" font-size="20" font-weight="600"`)}
  <circle cx="${width - pad - 10}" cy="36" r="16" fill="#1f2831"/>
  ${textLine(width - pad - 10, 42, 'Б', `fill="${C.gold}" font-size="17" text-anchor="middle"`)}
  ${body.join('\n')}
  ${textLine(pad, height - 20, 'макет переписки — собран из ответов настоящего lib/brain.js', `fill="${C.muted}" font-family="${MONO}" font-size="12"`)}
</svg>`;
}

// ---- рендер -----------------------------------------------------------------

function render(svg, file, width) {
  const resvg = new Resvg(svg, {
    fitTo: { mode: 'width', value: width || SCREEN.w },
    font: { loadSystemFonts: true, defaultFontFamily: FONT },
  });
  const png = resvg.render().asPng();
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, file), png);
  console.log(`  ✓ docs/shots/${file} — ${(png.length / 1024).toFixed(0)} КБ`);
  return png.length;
}

// ---- сценарии ---------------------------------------------------------------

const INTRO_MS = 3400; // приветствие сказано, подпись погасла — дальше чистое состояние

async function shotIdle() {
  const { dom, win } = await bootFace();
  await sleep(INTRO_MS);
  return { dom, state: snapshot(win), label: 'состояние: idle · палец не тронул морду' };
}

async function shotMouthTalk() {
  const { dom, win } = await bootFace();
  await sleep(INTRO_MS);
  press(win, 'mouthGroup'); // тап по рту: реплика из канона
  await sleep(700);
  return { dom, state: snapshot(win), active: 'btnTalk', label: 'тап по рту: реплика из канона + рот говорит' };
}

async function shotAngry() {
  const { dom, win } = await bootFace();
  await sleep(INTRO_MS);
  press(win, 'plate', { clientY: 600 }); // тап по щеке-пластине: гнев
  await sleep(700);
  return { dom, state: snapshot(win), label: 'тап по щеке: гнев, «Кусай мой блестящий металлический зад!»' };
}

async function shotSurprised() {
  const { dom, win } = await bootFace();
  await sleep(INTRO_MS);
  press(win, 'plate', { clientY: -1 }); // тап по лбу
  await sleep(600);
  return { dom, state: snapshot(win), label: 'тап по лбу: «Эй!» — удивление' };
}

async function shotWink() {
  const { dom, win } = await bootFace();
  await sleep(INTRO_MS);
  press(win, 'eyeL');
  await sleep(140); // веко закрыто 320 мс — ловим на пике
  return { dom, state: snapshot(win), label: 'тап по глазу: подмигивание (веко SVG, железо — сухой лог)' };
}

async function shotVoice() {
  const { dom, win } = await bootFace();
  await sleep(INTRO_MS);
  click(win, 'btnVoice');
  await sleep(420);
  return { dom, state: snapshot(win), active: 'btnVoice', label: 'кнопка «Голос»: планшет листает свои русские голоса' };
}

async function shotAnswer() {
  // Реплику берём у настоящего мозга: тот же ответ, что ушёл бы в Telegram на /ask.
  const brain = new Brain({ seed: 20261010 });
  const reply = await brain.answer('помнишь Сеймура?');
  const { dom, win } = await bootFace({
    commands: [{ id: 1, kind: 'say', text: reply.text, at: Date.now() }],
    voice: { rate: 1, pitch: 0.55 },
  });
  await sleep(1200); // морда получила /say, говорит
  return {
    dom,
    state: snapshot(win),
    label: 'хозяин из Telegram: /ask помнишь Сеймура? — морда говорит ответ',
    answer: reply,
  };
}

async function shotEyes() {
  const { dom, win } = await bootFace({
    eyesToken: 'demo-token-for-screenshot',
    eyes: { on: true, leftSec: 900 },
  });
  await sleep(INTRO_MS);
  return { dom, state: snapshot(win), label: 'хозяин включил /eyes on: камера и микрофон ждут тапа (iPad требует жест)' };
}

async function shotMemory() {
  const queries = ['помнишь Сеймура?', 'кто такой Фрай', 'что за серия про Розуэлл', 'кто такой Вася Пупкин'];
  const brain = new Brain({ seed: 1 });
  const lines = [
    { text: `$ node tools/memory.js — память: ${brain.memoryStats().chunks} кусков, ${brain.memoryStats().episodes} серий и фильмов`, tone: 'fill="rgba(126, 224, 143, 0.9)"' },
    { text: '', gap: 18 },
  ];
  for (const query of queries) {
    const memories = lore.recall(query);
    lines.push({ text: `> ${query}`, tone: `fill="${C.gold}"` });
    if (!memories.length) {
      lines.push({ text: '  — пусто: говорю «не помню», а не выдумываю', tone: 'fill="rgba(230, 130, 130, 0.85)"' });
    } else {
      for (const m of memories) {
        lines.push({ text: `  ${m.score.toFixed(2).padStart(6)}  ${m.path}  [${m.source}]` });
      }
    }
    lines.push({ text: '', gap: 14 });
  }
  return {
    svg: cardSvg({
      title: 'Память Бендера: что всплывает (lib/lore.js, те же файлы, что в brain/lore.py)',
      subtitle: 'BM25 по кускам канона · порог шума 4.0 · /ask отвечает верхним куском (node tools/memory.js)',
      lines,
    }),
    file: '08-memory.png',
  };
}

async function shotChat() {
  const brain = new Brain({ seed: 20261010 });
  const reply = await brain.answer('помнишь Сеймура?');
  const memory = memoryHighlights(reply.memories)
    .map((m) => `• ${m.path} (${m.source}, балл ${m.score})`)
    .join('\n');
  return {
    svg: chatSvg({
      title: 'Бендер · бот',
      messages: [
        { from: 'host', text: '/ask помнишь Сеймура?' },
        { from: 'bender', text: reply.text },
        { from: 'bender', text: `🧠 Всплыло в памяти:\n${memory}\n\nМорда скажет это вслух.` },
      ],
    }),
    file: '09-telegram-ask.png',
  };
}

// ---- запуск -----------------------------------------------------------------

async function main() {
  console.log('Скриншоты морды (jsdom + resvg, без браузера):');
  const shots = [
    ['01-idle.png', shotIdle],
    ['02-wink.png', shotWink],
    ['03-mouth-replika.png', shotMouthTalk],
    ['04-angry.png', shotAngry],
    ['05-surprised.png', shotSurprised],
    ['06-voice.png', shotVoice],
    ['07-say-from-telegram.png', shotAnswer],
  ];
  for (const [file, run] of shots) {
    const shot = await run();
    render(screenSvg(shot.state, { active: shot.active, label: shot.label }), file);
    shot.dom.window.close(); // jsdom держит таймеры: окно закрываем, иначе процесс не выйдет
  }
  const eyes = await shotEyes();
  render(screenSvg(eyes.state, { label: eyes.label }), '10-eyes-on.png');
  eyes.dom.window.close();

  const memory = await shotMemory();
  render(memory.svg, memory.file, SCREEN.w);
  const chat = await shotChat();
  render(chat.svg, chat.file, 760);
  console.log(`Готово: ${OUT}`);
}

if (require.main === module) {
  main()
    .then(() => process.exit(0)) // у jsdom могут остаться внутренние таймеры
    .catch((error) => {
      console.error('Скриншоты не собрались:', error);
      process.exit(1);
    });
}

module.exports = { bootFace, snapshot, screenSvg, cardSvg, chatSvg, main };
