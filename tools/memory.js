// tools/memory.js — посмотреть, что у Бендера всплывает в памяти. Без железа и сети.
//
// Память у мозга одна на оба слоя: brain/lore/*.md читают и python-мозг
// (brain/lore.py), и Node-морда (lib/lore.js). Этот тул — лупа:
//
//   node tools/memory.js                          # сколько всего помню
//   node tools/memory.js помнишь Сеймура          # что всплывает и с каким баллом
//   node tools/memory.js --answer кто такой Фрай  # что скажет Бендер (заглушка)
//   node tools/memory.js --top 10 серия           # больше кусков

'use strict';

const { Brain } = require('../lib/brain');
const lore = require('../lib/lore');

function parseArgs(argv) {
  const options = { k: 3, answer: false, words: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--answer' || arg === '-a') options.answer = true;
    else if (arg === '--top' || arg === '-k') {
      options.k = Number(argv[i + 1]) || options.k;
      i += 1;
    } else options.words.push(arg);
  }
  options.query = options.words.join(' ');
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const brain = new Brain({ seed: 20261010 });
  const stats = brain.memoryStats();

  if (!options.query) {
    console.log('Бендер помнит:');
    console.log(`  кусков канона: ${stats.chunks}`);
    console.log(`  серий и фильмов: ${stats.episodes}`);
    console.log('');
    console.log('Спроси: node tools/memory.js помнишь Сеймура');
    console.log('С ответом: node tools/memory.js --answer кто такой Фрай');
    return;
  }

  const memories = lore.recall(options.query, { k: options.k });
  console.log(`> ${options.query}`);
  if (!memories.length) {
    console.log('  пусто — Бендер скажет «не помню», а не выдумает');
  } else {
    for (const m of memories) {
      console.log(`  ${m.score.toFixed(3).padStart(7)}  ${m.path}  [${m.source}, строка куска]`);
      console.log(`           ${m.text.split('\n')[0].slice(0, 150)}`);
    }
  }

  if (options.answer) {
    const reply = await brain.answer(options.query);
    console.log('');
    console.log(`Бендер (${reply.engine}): ${reply.text}`);
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error('Память не открылась:', error.message);
    process.exit(1);
  });
}
