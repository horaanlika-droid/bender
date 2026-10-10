// Тесты памяти на Node: lib/lore.js — порт brain/lore.py на тех же файлах.
// Проверяем не «примерно похоже», а конкретику канона и одинаковый стеммер.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const lore = require('../lib/lore.js');

// ---- Файлы памяти ----------------------------------------------------------

test('память читается: все куски и все серии с фильмами', () => {
  const index = lore.getIndex();
  assert.ok(index.chunks.length > 250, `кусков должно быть много, а их ${index.chunks.length}`);
  const episodes = index.episodes();
  assert.equal(episodes.length, 168, '164 серии + 4 фильма — все на месте');
  assert.ok(episodes.includes('S01E01'));
  assert.ok(episodes.includes('F4'), 'фильмы тоже в памяти');
  assert.equal(episodes.filter((c) => c === 'S04E07').length, 1, 'серия не дублируется');
});

test('README памяти не считается воспоминанием', () => {
  const sources = new Set(lore.getIndex().chunks.map((c) => c.source.toLowerCase()));
  assert.equal(sources.has('readme.md'), false);
});

// ---- Стеммер и токены ------------------------------------------------------

test('ё приводится к е, регистр не важен', () => {
  assert.equal(lore.normalize('КУСАЙ МЁД'), 'кусай мед');
  assert.deepEqual(lore.tokenize('ПОМНИШЬ СЕЙМУРА'), lore.tokenize('помнишь сеймура'));
});

test('грубый стеммер сводит падежи к одной основе', () => {
  assert.equal(lore.stem('розуэллом'), lore.stem('розуэлл'));
  assert.equal(lore.stem('бендера'), lore.stem('бендер'));
  assert.equal(lore.stem('планшета'), lore.stem('планшет'));
  assert.equal(lore.stem('сеймура'), lore.stem('сеймуру'));
});

test('стоп-слова и вопросы не мусорят в токенах', () => {
  const tokens = lore.tokenize('а помнишь, кто такой Сеймур?');
  assert.equal(tokens.includes('помнишь'), false);
  assert.equal(tokens.includes('кто'), false);
  assert.ok(tokens.includes('сеймур'));
});

// ---- Поиск: то, что Бендер вспоминает --------------------------------------

test('помнишь Сеймура — всплывает Jurassic Bark', () => {
  const top = lore.recall('помнишь Сеймура?')[0];
  assert.equal(top.code, 'S04E07');
  assert.match(top.title, /Jurassic Bark/);
  assert.match(top.text, /окаменелость/);
});

test('кто такой Фрай — всплывает досье Фрая, а не случайная серия', () => {
  const top = lore.recall('кто такой Фрай')[0];
  assert.match(top.path, /Фрай/);
  assert.match(top.text, /двадцатого века|1974|Пануччи/);
});

test('вопрос про серию отдаёт кусок-серию, даже если выше досье героя', () => {
  const memories = lore.recall('что за серия про Розуэлл');
  assert.ok(memories.some((m) => m.code === 'S03E19'), 'Roswell That Ends Well в выдаче');
});

test('чего в каноне нет — того память не выдумывает', () => {
  assert.deepEqual(lore.recall('кто такой Вася Пупкин'), []);
  assert.deepEqual(lore.recall('что за серия про мой велосипед'), []);
  assert.deepEqual(lore.recall('расскажи про мой диплом'), []);
});

test('пустой запрос не роняет поиск', () => {
  assert.deepEqual(lore.recall(''), []);
  assert.deepEqual(lore.recall('   ?!  '), []);
});

test('баллы убывают, а порог шума отсекает слабое', () => {
  const memories = lore.recall('Гипножаба', { k: 3 });
  const scores = memories.map((m) => m.score);
  assert.deepEqual(scores, [...scores].sort((a, b) => b - a));
  assert.ok(scores.every((s) => s > lore.MIN_SCORE));
});

// ---- Склейка для промпта и подписи -----------------------------------------

test('firstSentences: два предложения и потолок по символам', () => {
  const text = 'Первое предложение. Второе предложение. Третье предложение.';
  assert.equal(lore.firstSentences(text), 'Первое предложение. Второе предложение.');
  assert.equal(lore.firstSentences(text, { n: 1 }), 'Первое предложение.');
  const long = lore.firstSentences('а'.repeat(500), { limit: 100 });
  assert.equal(long.length, 100);
  assert.ok(long.endsWith('…'));
});

test('formatMemories уважает бюджет и не рвёт память посередине слова зря', () => {
  const memories = lore.recall('кто такой Фрай', { k: 3 });
  const block = lore.formatMemories(memories, 400);
  assert.ok(block.length <= 400);
  assert.match(block, /^### /);
});

test('порт на Node и python-мозг ищут одинаково', () => {
  // Контрольная точка из brain/lore.py: тот же запрос — та же верхушка.
  const cases = [
    ['помнишь Сеймура?', 'S04E07'],
    ['кто такой Фрай', null],
    ['как звали маму Бендера?', 'S02E04'],
  ];
  for (const [query, code] of cases) {
    const top = lore.recall(query)[0];
    assert.ok(top, `пусто по запросу ${query}`);
    if (code) assert.equal(top.code, code, `верхушка по «${query}»`);
  }
});
