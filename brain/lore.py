"""Долговременная память Бендера: канон «Футурамы» из ``brain/lore/*.md``.

Без зависимостей: файлы режутся на куски по заголовкам ``##``/``###``,
слова грубо стеммятся (русский + английский), поиск — BM25 с бустом
заголовка и строки ``Ключи:``. Рантайм на каждом ходе зовёт :func:`recall`
и подкладывает найденное в системный промпт — это не инструмент тела.

::

    from brain.lore import recall
    recall("помнишь Сеймура?")[0]["title"]   # 'S04E07 · Jurassic Bark'
"""

from __future__ import annotations

import math
import re
from dataclasses import dataclass, field
from functools import lru_cache
from pathlib import Path

LORE_DIR = Path(__file__).resolve().parent / "lore"

#: Код серии в заголовке: ``S04E07`` или ``F1`` (фильмы).
EPISODE_RE = re.compile(r"^(S\d{2}E\d{2}|F\d)\b")

TITLE_WEIGHT = 3
#: Добавка за каждое слово запроса, попавшее прямо в заголовок (досье бьёт упоминания).
TITLE_BONUS = 1.0
#: Добавка, если запрос целиком называет героя заголовка («кто такой Фрай» → «Фрай (Philip J. Fry)»).
HEAD_BONUS = 4.0
KEYS_WEIGHT = 2
BM25_K1 = 1.5
BM25_B = 0.75

_KEYS_RE = re.compile(r"^\s*Ключи\s*:\s*(.*)$", re.I)
_WORD_RE = re.compile(r"[a-zа-я0-9]+")

# Окончания: от длинных к коротким. Стеммер грубый и одинаков для текста
# и для запроса, поэтому точность морфологии не важна — важна стабильность.
_RU_ENDINGS = sorted(
    {
        # прилагательные и причастия
        "ыми", "ими", "ого", "его", "ому", "ему", "ая", "яя", "ое", "ее", "ые", "ие",
        "ый", "ий", "ой", "ую", "юю", "ей", "ых", "их", "ым", "им",
        # существительные
        "ами", "ями", "ах", "ях", "ов", "ев", "ом", "ем", "ам", "ям", "ою", "ею",
        "ия", "ья", "ию", "ью", "ии", "ость", "ости", "ство", "ства",
        "а", "я", "о", "е", "ы", "и", "у", "ю", "ь", "й",
        # глаголы
        "ешь", "ет", "ют", "ут", "ишь", "ит", "ат", "ят", "ете", "ите",
        "ала", "ила", "ела", "ал", "ил", "ел", "ла", "ло", "ли", "л", "ть", "ти",
        "ан", "ян", "ен",
    },
    key=len,
    reverse=True,
)
_EN_ENDINGS = ("'s", "ing", "ed", "es", "s")
_MIN_STEM = 3

_STOP = set(
    """
    и в во не что он на я с со как а то все всё она так его но да ты к у же вы за бы по
    только ее её мне было вот от меня еще ещё нет о об из ему теперь когда даже ну ли если
    уже или ни быть был него до вас нибудь опять уж вам ведь там потом себя ничего ей может
    они тут где есть надо ней для мы тебя их чем была сам чтоб без будто чего раз тоже себе
    под будет ж тогда кто этот того потому этого какой какая какие совсем ним здесь этом
    один почти мой тем чтобы нее сейчас были куда зачем всех никогда можно при наконец два
    другой хоть после над больше тот через эти нас про всего них много разве три эту
    моя впрочем хорошо свою этой перед иногда лучше чуть том нельзя такой такая такое такие
    им более всегда конечно всю между это ли же бы вообще там тебе твой твоя
    помнишь помню вспомни вспомнишь расскажи расскажешь поведай напомни знаешь звали зовут
    старина бендер бендера бендеру бендером мясомешок эй слушай скажи ладно ну-ка
    серия серии серию серий серией эпизод эпизоде эпизода эпизоды
    the a an of and or to in on is was it who what that this
    """.split()
)


def normalize(text: str) -> str:
    return text.lower().replace("ё", "е")


def stem(word: str) -> str:
    """Грубый стеммер: отрезает самое длинное окончание, оставляя ≥3 букв."""
    if word.isdigit():
        return word
    if re.fullmatch(r"[a-z0-9']+", word):
        for end in _EN_ENDINGS:
            if word.endswith(end) and len(word) - len(end) >= _MIN_STEM:
                return word[: -len(end)]
        return word
    for refl in ("ся", "сь"):
        if word.endswith(refl) and len(word) - 2 >= _MIN_STEM:
            word = word[:-2]
            break
    # Несколько проходов: «розуэллом» и «розуэлл» должны сойтись в одну основу.
    for _ in range(3):
        for end in _RU_ENDINGS:
            if word.endswith(end) and len(word) - len(end) >= _MIN_STEM:
                word = word[: -len(end)]
                break
        else:
            break
    return word


def tokenize(text: str) -> list[str]:
    """Нижний регистр, ё→е, стоп-слова прочь, стемминг."""
    return [stem(w) for w in _WORD_RE.findall(normalize(text)) if w not in _STOP and (len(w) > 1 or w.isdigit())]


@dataclass
class Chunk:
    """Один кусок памяти: заголовок + текст (+ ключи для поиска)."""

    title: str
    context: str
    text: str
    source: str
    keys: str = ""
    code: str = ""
    tf: dict[str, float] = field(default_factory=dict, repr=False)
    title_toks: frozenset = field(default_factory=frozenset, repr=False)
    head_toks: frozenset = field(default_factory=frozenset, repr=False)
    length: float = 0.0

    @property
    def path(self) -> str:
        return f"{self.context} › {self.title}" if self.context and self.context != self.title else self.title


def _parse_file(path: Path) -> list[Chunk]:
    chunks: list[Chunk] = []
    h1 = h2 = ""
    title = ""
    level = 0
    body: list[str] = []
    keys: list[str] = []

    def flush() -> None:
        text = "\n".join(body).strip()
        if title and (text or keys):
            ctx = h2 if level == 3 and h2 else h1
            m = EPISODE_RE.match(title)
            chunks.append(
                Chunk(
                    title=title,
                    context=ctx,
                    text=text,
                    source=path.name,
                    keys=", ".join(keys),
                    code=m.group(1) if m else "",
                )
            )

    for raw in path.read_text(encoding="utf-8").splitlines():
        m = re.match(r"^(#{1,3})\s+(.*?)\s*$", raw)
        if m:
            flush()
            body, keys = [], []
            level = len(m.group(1))
            title = m.group(2)
            if level == 1:
                h1, h2 = title, ""
            elif level == 2:
                h2 = title
            continue
        km = _KEYS_RE.match(raw)
        if km:
            keys.append(km.group(1).strip())
        else:
            body.append(raw)
    flush()
    return chunks


class LoreIndex:
    """BM25 по кускам лора."""

    def __init__(self, chunks: list[Chunk]):
        self.chunks = chunks
        df: dict[str, int] = {}
        for c in chunks:
            tf: dict[str, float] = {}
            for weight, part in ((TITLE_WEIGHT, c.title), (KEYS_WEIGHT, c.keys), (1, c.text)):
                for tok in tokenize(part):
                    tf[tok] = tf.get(tok, 0.0) + weight
            c.tf = tf
            c.title_toks = frozenset(tokenize(c.title))
            c.head_toks = frozenset(tokenize(re.split(r"[(·:—]", c.title)[0]))
            c.length = sum(tf.values())
            for tok in tf:
                df[tok] = df.get(tok, 0) + 1
        n = max(len(chunks), 1)
        self.avg_len = sum(c.length for c in chunks) / n if chunks else 1.0
        self.idf = {t: math.log(1 + (n - d + 0.5) / (d + 0.5)) for t, d in df.items()}

    @classmethod
    def from_dir(cls, lore_dir: Path | None = None) -> "LoreIndex":
        d = Path(lore_dir) if lore_dir else LORE_DIR
        chunks: list[Chunk] = []
        for p in sorted(d.glob("*.md")):
            if p.name.lower() == "readme.md":
                continue
            chunks.extend(_parse_file(p))
        return cls(chunks)

    def search(self, query: str, k: int = 3, min_score: float = 0.0) -> list[dict]:
        q = list(dict.fromkeys(tokenize(query)))
        if not q:
            return []
        qset = set(q)
        scored: list[tuple[float, Chunk]] = []
        for c in self.chunks:
            s = 0.0
            for tok in q:
                f = c.tf.get(tok)
                if not f:
                    continue
                norm = BM25_K1 * (1 - BM25_B + BM25_B * c.length / self.avg_len)
                s += self.idf[tok] * f * (BM25_K1 + 1) / (f + norm)
                if tok in c.title_toks:
                    s += self.idf[tok] * TITLE_BONUS
            if s and c.head_toks and c.head_toks <= qset:
                s += HEAD_BONUS
            if s > min_score:
                scored.append((s, c))
        scored.sort(key=lambda x: -x[0])
        return [
            {
                "title": c.title,
                "path": c.path,
                "code": c.code,
                "text": c.text,
                "source": c.source,
                "score": round(s, 3),
            }
            for s, c in scored[:k]
        ]

    def episodes(self) -> list[str]:
        """Коды всех серий и фильмов в порядке файлов."""
        return [c.code for c in self.chunks if c.code]


@lru_cache(maxsize=4)
def _index(lore_dir: str | None = None) -> LoreIndex:
    return LoreIndex.from_dir(Path(lore_dir) if lore_dir else None)


def get_index(lore_dir: str | Path | None = None) -> LoreIndex:
    return _index(str(lore_dir) if lore_dir else None)


#: Ниже этого балла кусок считаем шумом, а не воспоминанием.
MIN_SCORE = 4.0
#: С таким баллом вспоминаем даже без вопроса «помнишь…».
STRONG_SCORE = 6.5


def recall(query: str, k: int = 3, min_score: float = MIN_SCORE, lore_dir: str | Path | None = None) -> list[dict]:
    """Что всплывает в памяти по реплике: до ``k`` кусков, лучшие первыми."""
    return get_index(lore_dir).search(query, k=k, min_score=min_score)


def format_memories(memories: list[dict] | None, budget: int = 2500) -> str:
    """Склейка кусков для промпта: заголовок + текст, не длиннее ``budget``."""
    out: list[str] = []
    used = 0
    for m in memories or []:
        block = f"### {m['path']}\n{m['text']}".strip()
        if used + len(block) > budget:
            room = budget - used
            if room < 200:
                break
            block = block[: room - 1].rstrip() + "…"
        out.append(block)
        used += len(block) + 2
    return "\n\n".join(out)


def first_sentences(text: str, n: int = 2, limit: int = 350) -> str:
    """Первые ``n`` предложений, не длиннее ``limit`` символов."""
    flat = " ".join(text.split())
    parts = re.split(r"(?<=[.!?…»])\s+(?=[А-ЯЁA-Z«\"(])", flat)
    out = ""
    for p in parts[:n]:
        cand = f"{out} {p}".strip()
        if len(cand) > limit:
            break
        out = cand
    if not out:
        out = flat[: limit - 1].rstrip() + "…" if len(flat) > limit else flat
    return out
