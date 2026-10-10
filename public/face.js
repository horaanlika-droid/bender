// БЕНДЕР — морда: состояние лица, моргание, речь, реакции на тапы.
'use strict';

const $ = (id) => document.getElementById(id);

// ---- Telegram Mini App (если открыли из бота) ------------------------------
const tg = window.Telegram && window.Telegram.WebApp;
if (tg) {
  tg.ready();
  tg.expand();
  if (tg.setHeaderColor) tg.setHeaderColor('#14161a');
  if (tg.setBackgroundColor) tg.setBackgroundColor('#0d0f13');
}

// ---- реплики (канон из brain/lore/90_quotes.md) ----------------------------
const QUOTES = [
  'Кусай мой блестящий металлический зад!',
  'Построю свой собственный парк — с блэкджеком и шлюхами!',
  'Убить всех человеков!',
  'Мы в пролёте.',
  'Я люблю вас, мясомешки!',
  'Сматываемся!',
  'Сегодня у меня больше никаких планов. Пошли напьёмся!',
  'Это худший вид дискриминации — дискриминация против меня!',
  'Я Бендер. Пожалуйста, вставьте балку.',
  'Эй, красотка, не хочешь убить всех человеков?',
  'Мне так стыдно. Лучше бы все остальные умерли.',
  'Хлещи сильнее, профессор!',
];
const GREETING = 'Привет, мясомешок. Я — Бендер.';

// ---- состояние лица -------------------------------------------------------
const S = {
  // моргание: 0 — открыты, 1 — закрыты
  blinkEnv: 0,
  nextBlink: performance.now() + 2500,
  blinkStart: 0,
  blinking: false,
  // зрачки
  pupil: { x: 0, y: 0 },
  pupilTarget: { x: 0, y: 0 },
  nextGaze: 0,
  // выражение (целевые значения, к которым ползём)
  exp: {
    lidL: 0, lidR: 0,
    mouthX: 1, mouthY: 1,
    pupilR: 52, eyeScale: 1,
  },
  // разговор
  talking: false,
  talkPhase: 0,
  smokeUntil: performance.now() + 12000,
};

const lidRects = { L: $('lidL').querySelector('rect'), R: $('lidR').querySelector('rect') };
const pupils = { L: $('pupilL'), R: $('pupilR') };
const mouth = $('mouth');
const mouthGroup = $('mouthGroup');
const eyeGroups = { L: $('eyeL'), R: $('eyeR') };

const EYE = { L: 420, R: 780, cy: 310, r: 130, lidH: 280 };

function setLid(side, closed) {
  const cx = EYE[side];
  const y = EYE.cy - EYE.r - EYE.lidH + closed * EYE.lidH;
  const rect = lidRects[side];
  rect.setAttribute('x', cx - 140);
  rect.setAttribute('y', y);
  rect.setAttribute('width', 280);
  rect.setAttribute('height', EYE.lidH);
}

function setPupil(side, x, y, r) {
  const cx = EYE[side];
  const g = pupils[side];
  g.setAttribute('transform', `translate(${cx + x} ${EYE.cy + y})`);
  const circle = g.querySelector('circle');
  circle.setAttribute('r', r);
}

// ---- выражения ------------------------------------------------------------
function setExpression(name) {
  const t = S.exp;
  switch (name) {
    case 'happy':
      t.lidL = 0.3; t.lidR = 0.3;
      t.mouthX = 1.12; t.mouthY = 1.15;
      t.pupilR = 52; t.eyeScale = 1;
      break;
    case 'angry':
      t.lidL = 0.45; t.lidR = 0.45;
      t.mouthX = 1.05; t.mouthY = 0.75;
      t.pupilR = 38; t.eyeScale = 0.98;
      break;
    case 'surprised':
      t.lidL = 0; t.lidR = 0;
      t.mouthX = 0.85; t.mouthY = 2.1;
      t.pupilR = 58; t.eyeScale = 1.07;
      break;
    case 'idle':
    default:
      t.lidL = 0; t.lidR = 0;
      t.mouthX = 1; t.mouthY = 1;
      t.pupilR = 52; t.eyeScale = 1;
      break;
  }
}

// ---- речь -----------------------------------------------------------------
let ruVoice = null;
function pickVoice() {
  const voices = window.speechSynthesis ? speechSynthesis.getVoices() : [];
  ruVoice =
    voices.find((v) => /ru/i.test(v.lang) && /google|yandex|milena|female/i.test(v.name)) ||
    voices.find((v) => /ru/i.test(v.lang)) ||
    null;
}
if (window.speechSynthesis) {
  pickVoice();
  speechSynthesis.onvoiceschanged = pickVoice;
}

const caption = $('caption');
let captionTimer = 0;

function showCaption(text, ms) {
  caption.textContent = text;
  caption.classList.add('show');
  clearTimeout(captionTimer);
  captionTimer = setTimeout(() => caption.classList.remove('show'), ms);
}

let talkStopTimer = 0;

function speak(text) {
  showCaption(text, Math.max(2600, text.length * 90));
  S.talking = true;
  clearTimeout(talkStopTimer);

  const estMs = Math.max(1400, text.length * 75);
  talkStopTimer = setTimeout(() => { S.talking = false; }, estMs); // страховка

  if (!window.speechSynthesis) return;
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  if (ruVoice) u.voice = ruVoice;
  u.lang = 'ru-RU';
  u.rate = 1.0;
  u.pitch = 0.65; // железный бас
  u.onend = () => { S.talking = false; };
  u.onerror = () => { S.talking = false; };
  speechSynthesis.speak(u);
}

let lastQuote = -1;
function randomQuote() {
  let i = Math.floor(Math.random() * QUOTES.length);
  if (i === lastQuote) i = (i + 1) % QUOTES.length;
  lastQuote = i;
  return QUOTES[i];
}

// ---- реакции на тапы ------------------------------------------------------
let greeted = false;
function greet() {
  if (greeted) return;
  greeted = true;
  setExpression('happy');
  setTimeout(() => setExpression('idle'), 1200);
  speak(GREETING);
}

function wink(side) {
  const key = side === 'L' ? 'lidL' : 'lidR';
  S.exp[key] = 1;
  setTimeout(() => { S.exp[key] = 0; }, 320);
  showCaption('Подмигиваю.', 1200);
}

function haptic(style) {
  if (tg && tg.HapticFeedback) tg.HapticFeedback.impactOccurred(style || 'light');
}

function onTapZone(zone) {
  greet();
  haptic('light');
  $('hint').classList.add('hide');
  switch (zone) {
    case 'eyeL': wink('L'); break;
    case 'eyeR': wink('R'); break;
    case 'mouth':
      setExpression('happy');
      speak(randomQuote());
      setTimeout(() => { if (!S.talking) setExpression('idle'); }, 3200);
      break;
    case 'forehead':
      setExpression('surprised');
      speak('Эй!');
      setTimeout(() => setExpression('idle'), 1600);
      break;
    case 'plate':
    default:
      setExpression('angry');
      speak('Кусай мой блестящий металлический зад!');
      setTimeout(() => { if (!S.talking) setExpression('idle'); }, 2600);
      break;
  }
}

$('eyeL').addEventListener('pointerdown', () => onTapZone('eyeL'));
$('eyeR').addEventListener('pointerdown', () => onTapZone('eyeR'));
$('mouthGroup').addEventListener('pointerdown', (e) => { e.stopPropagation(); onTapZone('mouth'); });
$('plate').addEventListener('pointerdown', (e) => {
  const rect = $('face').getBoundingClientRect();
  const y = (e.clientY - rect.top) / rect.height;
  onTapZone(y < 0.45 ? 'forehead' : 'plate');
});

// ---- кнопки HUD -----------------------------------------------------------
$('btnTalk').addEventListener('click', () => {
  greet();
  haptic('medium');
  setExpression('happy');
  speak(randomQuote());
  setTimeout(() => { if (!S.talking) setExpression('idle'); }, 3200);
});

$('btnFull').addEventListener('click', async () => {
  haptic('medium');
  try {
    if (!document.fullscreenElement) {
      await document.documentElement.requestFullscreen();
      $('btnFull').textContent = 'Свернуть';
    } else {
      await document.exitFullscreen();
      $('btnFull').textContent = 'Полный экран';
    }
  } catch (_) { /* iOS Safari: просто игнорируем */ }
  // держим экран включённым (iPad kiosk)
  try {
    if (navigator.wakeLock) await navigator.wakeLock.request('screen');
  } catch (_) { /* не критично */ }
});

$('btnAbout').addEventListener('click', () => {
  haptic('light');
  if (tg && tg.openLink) tg.openLink('about.html');
  else window.location.href = 'about.html';
});

// клавиатура (для отладки на десктопе)
window.addEventListener('keydown', (e) => {
  if (e.code === 'Space') { e.preventDefault(); $('btnTalk').click(); }
  if (e.key === 'f' || e.key === 'а') $('btnFull').click();
});

// ---- главный цикл ---------------------------------------------------------
const lerp = (a, b, t) => a + (b - a) * t;

function frame(now) {
  // моргание
  if (!S.blinking && now >= S.nextBlink) {
    S.blinking = true;
    S.blinkStart = now;
  }
  if (S.blinking) {
    const dt = now - S.blinkStart;
    if (dt < 130) S.blinkEnv = dt / 130;
    else if (dt < 240) S.blinkEnv = 1 - (dt - 130) / 110;
    else {
      S.blinkEnv = 0;
      S.blinking = false;
      S.nextBlink = now + 2200 + Math.random() * 3800;
    }
  }

  // блуждающий взгляд
  if (now >= S.nextGaze) {
    S.pupilTarget.x = (Math.random() * 2 - 1) * 34;
    S.pupilTarget.y = (Math.random() * 2 - 1) * 22;
    S.nextGaze = now + 1600 + Math.random() * 3200;
  }
  if (S.talking) {
    // при речи чуть сводим зрачки к центру
    S.pupilTarget.x = lerp(S.pupilTarget.x, 0, 0.02);
    S.pupilTarget.y = lerp(S.pupilTarget.y, 6, 0.02);
  }
  S.pupil.x = lerp(S.pupil.x, S.pupilTarget.x, 0.06);
  S.pupil.y = lerp(S.pupil.y, S.pupilTarget.y, 0.06);

  // рот: осцилляция при разговоре
  let mouthY = S.exp.mouthY;
  if (S.talking) {
    S.talkPhase += 0.28 + Math.random() * 0.12;
    mouthY = 1 + (0.75 + 0.55 * Math.sin(S.talkPhase)) * Math.max(S.exp.mouthY, 1);
  }
  mouth.setAttribute('transform', `scale(${S.exp.mouthX} ${mouthY})`);

  // зрачки
  const pr = S.exp.pupilR;
  setPupil('L', S.pupil.x, S.pupil.y, pr);
  setPupil('R', S.pupil.x, S.pupil.y, pr);

  // веки: моргание поверх выражения
  const lidL = Math.min(1, S.exp.lidL + S.blinkEnv * (1 - S.exp.lidL * 0.5));
  const lidR = Math.min(1, S.exp.lidR + S.blinkEnv * (1 - S.exp.lidR * 0.5));
  setLid('L', lidL);
  setLid('R', lidR);

  // лёгкое «дыхание» глаз и пластины
  const breathe = 1 + 0.004 * Math.sin(now / 900);
  const s = breathe * S.exp.eyeScale;
  $('plate').setAttribute('transform', `translate(600 400) scale(${s} ${s}) translate(-600 -400)`);
  eyeGroups.L.setAttribute('transform', `translate(${EYE.L} ${EYE.cy}) scale(${s}) translate(${-EYE.L} ${-EYE.cy})`);
  eyeGroups.R.setAttribute('transform', `translate(${EYE.R} ${EYE.cy}) scale(${s}) translate(${-EYE.R} ${-EYE.cy})`);

  // дым
  const smoke = $('smoke');
  if (now < S.smokeUntil) smoke.classList.add('puffing');
  else {
    smoke.classList.remove('puffing');
    if (now > S.smokeUntil + 4000) S.smokeUntil = now + 9000 + Math.random() * 15000;
  }

  requestAnimationFrame(frame);
}

// старт
setLid('L', 0);
setLid('R', 0);
requestAnimationFrame(frame);

// приветствие: сразу на десктопе, по первому тапу — на iOS
setTimeout(greet, 900);
window.addEventListener('pointerdown', greet, { once: true });

// подсказка гаснет сама
setTimeout(() => $('hint').classList.add('hide'), 9000);
