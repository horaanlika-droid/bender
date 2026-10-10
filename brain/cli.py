"""CLI Бендера: диалог в консоли или одна реплика.

::

    python -m brain                 # диалог
    python -m brain подмигни        # одна реплика и выход
    python -m brain --llm ollama    # слот под локальную модель
    python -m brain --recall Сеймур # что всплывает в памяти (лор) по запросу
"""

from __future__ import annotations

import argparse
import os
import sys

from .lore import format_memories, get_index, recall
from .runtime import make_brain
from .tools import format_call_line

BANNER = """\
БЕНДЕР, серия 22, серийный номер 2716057. Рантайм-мозг без железа: раунд 4.
Характер уже здесь, тело ещё в магазине. Движок: {engine}. Память: {memory}.
Попробуй: подмигни · закури · открой люк · статус · что видишь
Или спроси о прошлом: помнишь Сеймура? · кто такой Флексо · как ты стал богом?
Выход: «выход» или Ctrl-D.
"""

EXIT_WORDS = {"выход", "выйти", "хватит", "пока", "exit", "quit", "q"}


def _print_outcome(outcome: dict, file=None) -> None:
    file = file or sys.stdout
    print(f"Бендер> {outcome['reply']}", file=file)
    for call, res in outcome["executed"]:
        print(f"    {format_call_line(call, res)}", file=file)
    print(file=file, flush=True)


def _repl(brain) -> int:
    if brain.lore:
        codes = get_index().episodes()
        films = sum(1 for c in codes if c.startswith("F"))
        memory = f"канон, {len(codes) - films} серии + {films} фильма"
    else:
        memory = "выключена"
    print(BANNER.format(engine=brain.engine, memory=memory), flush=True)
    while True:
        try:
            line = input("мясомешок> ").strip()
        except (EOFError, KeyboardInterrupt):
            print("\nБендер> Сбежал. Правильно. Кусай мой блестящий металлический зад на прощание.")
            return 0
        if not line:
            continue
        if line.lower() in EXIT_WORDS:
            print("Бендер> Свободен, мясомешок. Я остаюсь со своим логом.")
            return 0
        _print_outcome(brain.handle(line))


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="brain",
        description="Бендер: рантайм-мозг без железа. Одна реплика — или диалог.",
    )
    parser.add_argument("text", nargs="*", help="одна реплика мясомешка (режим одиночного выстрела)")
    parser.add_argument("--llm", choices=["stub", "ollama"], default=os.environ.get("BRAIN_LLM", "stub"),
                        help="движок: правила/шаблоны или локальная модель (по умолчанию stub)")
    parser.add_argument("--model", help="модель Ollama (или переменная BRAIN_OLLAMA_MODEL)")
    parser.add_argument("--host", help="хост Ollama (или переменная BRAIN_OLLAMA_HOST)")
    parser.add_argument("--no-say", action="store_true",
                        help="не звать say автоматически (чистая отладка текста)")
    parser.add_argument("--log-file", help="файл сухого лога (по умолчанию var/dry_run.log)")
    parser.add_argument("--no-lore", action="store_true", help="не подкладывать лор в промпт (амнезия)")
    parser.add_argument("--recall", metavar="ЗАПРОС", help="показать, что всплывает в памяти, и выйти")
    parser.add_argument("-k", type=int, default=3, help="сколько кусков памяти показывать с --recall")
    args = parser.parse_args(argv)

    if args.recall:
        hits = recall(args.recall, k=args.k)
        if not hits:
            print("Не помню такого — значит, не было.")
            return 1
        for h in hits:
            print(f"[{h['score']:6.2f}] {h['path']}  ({h['source']})")
        print()
        print(format_memories(hits))
        return 0

    brain = make_brain(
        kind=args.llm,
        speak=not args.no_say,
        log_file=args.log_file,
        model=args.model,
        host=args.host,
        lore=not args.no_lore,
    )

    text = " ".join(args.text).strip()
    if text:
        _print_outcome(brain.handle(text))
        return 0
    return _repl(brain)
