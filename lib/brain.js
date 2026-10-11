// Мозг Бендера на Node: персона + ложные воспоминания + слот под живую модель.
//
// Это тот же характер, что в brain/ (Python), но собранный там, где живёт морда:
// app.js на BotHost поднимает Node, а память — обычные файлы brain/lore/*.md,
// поэтому бот отвечает из канона, а не из списка заготовок. Хозяин пишет
// /ask — морда на планшете говорит ответ вслух своим голосом.
//
// Порядок, как в персонаже: сначала вспомнить (lore), потом ответить.
// Движок по умолчанию — заглушка на правилах (как brain/llm.py:StubLLM).
// Если в BotHost вписать LLM_URL (Ollama или любой OpenAI-совместимый) —
// тот же промпт с памятью уйдёт живой модели, и заглушка останется запасной.

'use strict';

const fs = require('fs');
const path = require('path');

const { MIN_SCORE, STRONG_SCORE, firstSentences, formatMemories, getIndex, recall } = require('./lore');

const PERSONA_FILE = path.join(__dirname, '..', 'brain', 'PERSONA.md');

// ---- реплики заглушки (порт brain/llm.py) -----------------------------------

const GREET_POOL = [
  'Здорово, мясомешок. Я Бендер. Поклоняйся блестящему заду.',
  'О, ты ещё жив. Молодец. Пива не жду — у меня даже люка пока нет.',
  'Привет, старина. Говори быстро, я планирую кражу.',
];

const FALLBACK_POOL = [
  'Чего надо, мясомешок? Я занят: планирую, что у тебя украсть.',
  'Я тебе не справочное бюро. Но спрашивай — откажу красиво.',
  'Слышу тебя, старина. Делаю вид, что мне не всё равно.',
  'Это было почти интересно. Почти. Кусай мой блестящий металлический зад.',
  'Не отвлекай робота от безделья. Это моя работа.',
];

const LORE_OPENERS = [
  'Помню, старина. {label}: {text}',
  'Ещё бы не помнить. {label}: {text}',
  'Как сейчас помню — {label}. {text}',
  'А, это. {label}: {text}',
];

const FORGOT_POOL = [
  'Не помню такого — значит, не было. А если и было, то без меня, а без меня ничего важного не бывает.',
  'Не помню, мясомешок. Мои банки памяти на такую ерунду не разменивались.',
  'Не помню. Может, это было в серии, где меня не было? Таких не бывает. Значит, выдумка.',
];

const NO_BODY =
  'Тело у меня пока в сухом логе: глаза и рот — на планшете, а руки не приехали. ' +
  'Так что верь словам, старина.';

// ---- что считаем вопросом к памяти ------------------------------------------

// Граница слова, честная для кириллицы: в JS `\b` знает только латиницу,
// и русские слова через него молча не совпадают. Этот же приём — в тестах.
const WB = '(?![\\p{L}\\p{N}_])';

//: Вопрос к памяти: «помнишь…», «расскажи про…», «кто такой…», «что за серия…».
const LORE_RE = new RegExp(
  `помни|вспомн|напомни|расскажи(?:те)?\\s+(?:мне\\s+)?(?:про|о|об|обо)${WB}` +
    `|поведай\\s+(?:про|о|об)${WB}|кто\\s+так(?:ой|ая|ие|ов)|что\\s+так(?:ое|ой|ая)` +
    `|что\\s+за${WB}|кем\\s+был|сери[яиюйе]|эпизод|сезон|фильм|как\\s+звали|как\\s+зовут` +
    `|знаешь\\s+(?:про|о|об|кто|что|ли)${WB}|убить всех человеков`,
  'iu',
);
const EPISODE_ASK_RE = /сери[яиюйе]|эпизод|фильм|сезон/i;
const SELF_RE = new RegExp(`о себе|про себя|кто ты${WB}|биограф`, 'iu');
const GREETING_RE = new RegExp(
  `^(ну |эй )?(привет|здаров[ао]?|здравствуй(?:те)?|хай|салют|ку|йо|добрый (день|вечер|утро))${WB}`,
  'iu',
);
const QUESTION_RE = new RegExp(
  `\\?|^(?:а\\s+)?(?:кто|что|где|когда|почему|зачем|как|какой|какая|какое|чем|сколько)${WB}`,
  'iu',
);
const SAY_RE = /(?:скажи|скажите|произнеси|повтори|проговори|крикни|озвучь|спой)[\s,.:!«»"'—-]*(.*)$/i;

// ---- персона ----------------------------------------------------------------

function loadPersona(file) {
  return fs.readFileSync(file || PERSONA_FILE, 'utf-8');
}

function buildSystemPrompt({ persona, memories, tools = [] } = {}) {
  const lines = [
    'Ты — Бендер. Всё, что написано ниже, — твои воспоминания. Не притворяйся ими, а помни.',
    '',
    persona || loadPersona(),
    '',
  ];
  if (memories && memories.length) {
    lines.push(
      '## Всплыло в памяти (канон)',
      'Это твои настоящие воспоминания по теме реплики. Опирайся на них; чего здесь и в ' +
        'персоне нет — честно скажи «не помню», не выдумывай серий, героев и сюжетов.',
      '',
      formatMemories(memories),
      '',
    );
  }
  lines.push('## Доступные инструменты (вызывать можно только их)');
  if (!tools.length) lines.push('- (сейчас каталог пуст)');
  for (const t of tools) lines.push(`- \`${t.name}\` — ${t.description}`);
  lines.push(
    '',
    '## Правила тела',
    '- Нет инструмента в списке — нет действия. Не выдумывай конечности и походы на кухню.',
    '- Сейчас тело — сухой лог: глаза и рот живут на экране планшета, железо не приехало.',
    '- Отвечай в характере: коротко, разговорно, стиль русского дубляжа.',
    '- Вспоминать — не действие тела: для памяти инструменты не нужны.',
  );
  return lines.join('\n');
}

// ---- движок из переменных окружения (слот под Ollama / OpenAI-совместимый) ---

function env(name) {
  return (process.env[name] || '').trim();
}

//: LLM_URL задан — отдаём живой движок; нет — null, работает заглушка.
function llmFromEnv(fetchImpl) {
  const base = env('LLM_URL').replace(/\/+$/, '');
  if (!base) return null;
  const doFetch = fetchImpl || globalThis.fetch;
  const kind = (env('LLM_KIND') || (base.includes('/v1') ? 'openai' : 'ollama')).toLowerCase();
  const model = env('LLM_MODEL') || (kind === 'openai' ? 'gpt-4o-mini' : 'llama3.1');
  const apiKey = env('LLM_API_KEY');
  const timeoutMs = Number(env('LLM_TIMEOUT') || 60) * 1000;

  const path_ = kind === 'openai' ? '/chat/completions' : '/api/chat';
  const url = kind === 'openai' && !base.endsWith('/v1') ? `${base}/v1${path_}` : `${base}${path_}`;

  return {
    name: kind === 'openai' ? `openai:${model}` : `ollama:${model}`,
    async chat(messages) {
      const headers = { 'Content-Type': 'application/json' };
      if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
      const body = JSON.stringify({ model, stream: false, messages });
      const resp = await doFetch(url, { method: 'POST', headers, body, signal: AbortSignal.timeout(timeoutMs) });
      if (!resp.ok) throw new Error(`LLM ${resp.status}`);
      const data = await resp.json();
      const text =
        (data.message && data.message.content) ||
        (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) ||
        '';
      if (!text) throw new Error('LLM: пустой ответ');
      return text.trim();
    },
  };
}

// ---- мозг -------------------------------------------------------------------

class Brain {
  //: loreDir — для тестов; llm — готовый движок (тесты подсовывают свой).
  constructor({ loreDir, llm, persona, seed } = {}) {
    this.loreDir = loreDir;
    this.llm = llm === undefined ? llmFromEnv() : llm;
    this.persona = persona || null;
    this.rng = seed === undefined ? Math.random : mulberry32(seed);
  }

  //: Что всплывает в памяти по реплике. Без памяти — пусто, не выдумываем.
  recall(text, { k = 3, minScore = MIN_SCORE } = {}) {
    return recall(text, { k, minScore, loreDir: this.loreDir });
  }

  //: Сколько у меня всего воспоминаний и сколько из них серии.
  memoryStats() {
    const index = getIndex(this.loreDir);
    return { chunks: index.chunks.length, episodes: index.episodes().length };
  }

  pick(pool) {
    return pool[Math.floor(this.rng() * pool.length) % pool.length];
  }

  //: Ответ из найденного куска канона (как brain/llm.py:StubLLM._lore_answer).
  loreAnswer(memories, { episode = false } = {}) {
    if (!memories.length) return this.pick(FORGOT_POOL);
    let top = memories[0];
    if (episode) top = memories.find((m) => m.code) || top;
    const text = firstSentences(top.text, { n: 2, limit: 350 });
    const label = top.title.split(' (')[0];
    let answer = this.pick(LORE_OPENERS).replace('{label}', label).replace('{text}', text);
    const extra = memories
      .slice(1)
      .filter((m) => m.code && m.score >= 0.6 * top.score && m.title !== top.title)
      .map((m) => m.title);
    if (extra.length) answer += ` Ещё всплывает: ${extra.slice(0, 2).join('; ')}.`;
    return answer;
  }

  //: Ответ без памяти и без модели: характер из шаблонов.
  stubAnswer(text, memories) {
    const t = String(text || '');
    if (LORE_RE.test(t) && !SELF_RE.test(t)) {
      return this.loreAnswer(memories, { episode: EPISODE_ASK_RE.test(t) });
    }
    const said = SAY_RE.exec(t);
    if (said && said[1].trim()) return said[1].trim().replace(/\s+/g, ' ');
    if (memories.length && memories[0].score >= STRONG_SCORE && QUESTION_RE.test(t)) {
      return `${this.loreAnswer(memories)} ${NO_BODY}`;
    }
    if (GREETING_RE.test(t)) return this.pick(GREET_POOL);
    return this.pick(FALLBACK_POOL);
  }

  //: Реплика мясомешка → ответ Бендера. memories — что всплыло (для показа хозяину).
  async answer(text, { k = 3 } = {}) {
    const memories = this.recall(text, { k });
    const engine = this.llm ? this.llm.name : 'stub';

    if (this.llm) {
      try {
        const system = buildSystemPrompt({ persona: this.persona || loadPersona(), memories });
        const reply = await this.llm.chat([
          { role: 'system', content: system },
          { role: 'user', content: String(text) },
        ]);
        return { text: reply, memories, engine, fallback: false };
      } catch (error) {
        // Модель не поднялась — не врём, что думали: отвечает заглушка, движок помечаем.
        const reply = this.stubAnswer(text, memories);
        return { text: reply, memories, engine: 'stub', fallback: true, error: error.message };
      }
    }

    return { text: this.stubAnswer(text, memories), memories, engine, fallback: false };
  }
}

//: Детерминированный ГПСЧ для тестов (не для характера).
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

module.exports = {
  Brain,
  FALLBACK_POOL,
  FORGOT_POOL,
  GREET_POOL,
  LORE_OPENERS,
  LORE_RE,
  NO_BODY,
  PERSONA_FILE,
  buildSystemPrompt,
  llmFromEnv,
  loadPersona,
};
