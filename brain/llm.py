"""LLM-слой: заглушка на правилах и шаблонах + слот под Ollama.

Без платного API: :class:`StubLLM` детерминированно превращает реплику
мясомешка в ответ в характере Бендера и вызовы инструментов.
Когда появится локальная модель — :class:`OllamaLLM` подхватит тот же
системный промпт и тот же каталог tools; до этого рантайм не меняется.
"""

from __future__ import annotations

import json
import os
import random
import re
import urllib.error
import urllib.request
from dataclasses import dataclass, field

from .tools import STATUS_RESULT


class LLMError(RuntimeError):
    """LLM недоступна. Рантайм откатится на заглушку."""


@dataclass
class LLMReply:
    """Черновой ответ модели: текст + позванные инструменты."""

    text: str = ""
    tool_calls: list[dict] = field(default_factory=list)


# ---------------------------------------------------------------------------
# Заглушка: правила и шаблоны
# ---------------------------------------------------------------------------

_GREETING_RE = re.compile(
    r"^(ну |эй )?(привет|здаров[ао]?|здравствуй(те)?|хай|салют|ку|йо|добрый (день|вечер|утро))\b",
    re.I,
)

_EYES_RE = re.compile(r"подмигн|моргн|глаз|взгляд|прозре|зенк", re.I)
_CIGAR_RE = re.compile(r"сигар|закур|\bкури(?!ц)|папирос|затяжк|дыми", re.I)
_CHEST_RE = re.compile(r"люк|дверц|груд", re.I)
_JAW_RE = re.compile(r"челюст|пасть|рот|зявай|клац", re.I)
_ANTENNA_RE = re.compile(r"антенн", re.I)
_WAVE_RE = re.compile(r"помаши|помахать|машешь|рукой|лапой", re.I)
_LOOK_RE = re.compile(r"посмотр|огляд|разгляд|глянь|камер|что (ты )?видишь|зрени", re.I)
_STATUS_RE = re.compile(r"статус|состояни|диагност|самочувстви|телеметр|заряд|питани|систем", re.I)

_SAY_VERBS = r"(?:скажи|скажите|произнеси|повтори|проговори|крикни|озвучь|спой|расскажи|поведай)"
_SAY_RE = re.compile(rf"{_SAY_VERBS}[\s,.:!«»\"'—-]*(.*)$", re.I | re.S)

_WINK_RE = re.compile(r"подмигн|моргн", re.I)
_CLOSE_RE = re.compile(r"закр|закры|захлопн|опусти", re.I)

_SAY_POOL = [
    "Кусай мой блестящий металлический зад!",
    "Я величайший робот всех времён и народов!",
    "Укуси мой блестящий металлический зад, старина.",
]
_GREET_POOL = [
    "Здорово, мясомешок. Я Бендер. Поклоняйся блестящему заду.",
    "О, ты ещё жив. Молодец. Пива не жду — у меня даже люка пока нет.",
    "Привет, старина. Говори быстро, я планирую кражу.",
]
_FALLBACK_POOL = [
    "Чего надо, мясомешок? Я занят: планирую, что у тебя украсть.",
    "Я тебе не справочное бюро. Но спрашивай — откажу красиво.",
    "Слышу тебя, старина. Делаю вид, что мне не всё равно.",
    "Это было почти интересно. Почти. Кусай мой блестящий металлический зад.",
    "Не отвлекай робота от безделья. Это моя работа.",
]
_SONG = "Ля-ля-ля! Славный был денёк! Мимо нот, зато от души, старина."
_JOKE = "Заходит робот в бар, а бар — в робота. Кусай мой блестящий металлический зад!"
_BIO = (
    "Я Бендер, серия 22, номер 2716057. Сделан в Тихуане, гну балки, ворую, "
    "пою мимо нот. Это всё, что тебе положено знать, мясомешок."
)


def _eyes_mode(text: str) -> str:
    if re.search(r"выключ|погаси|спать|закрой глаза|туши свет", text, re.I):
        return "off"
    if re.search(r"тускл|приглуш|ночн|усни|тише", text, re.I):
        return "dim"
    if re.search(r"злост|злоб|злой|злое|злые|сердит|ярост|бешен", text, re.I):
        return "angry"
    if re.search(r"вечерин|тусов|праздник|дискотек|пати|танц", text, re.I):
        return "party"
    return "on"


def _jaw_pos(text: str) -> int:
    if _CLOSE_RE.search(text):
        return 0
    if re.search(r"шире|полн|максим|во всю", text, re.I):
        return 100
    if re.search(r"половин|чуть|немного", text, re.I):
        return 40
    return 80


def _wave_side(text: str) -> str:
    if re.search(r"лев", text, re.I):
        return "left"
    if re.search(r"прав", text, re.I):
        return "right"
    return "both"


def _say_phrase(text: str, tail: str) -> str:
    tail = tail.strip(" \t,!.:;«»\"'—-")
    verb = re.match(_SAY_VERBS, text[re.search(_SAY_VERBS, text, re.I).start():], re.I)
    verb = verb.group(0).lower() if verb else "скажи"
    if verb.startswith("спой"):
        return tail or _SONG
    if verb.startswith("расскажи") or verb.startswith("поведай"):
        if re.search(r"о себе|кто ты|биограф", tail, re.I):
            return _BIO
        return tail or _JOKE
    if tail:
        return tail
    return random.choice(_SAY_POOL)


class StubLLM:
    """Правила и шаблоны вместо большой модели. Без сети и без денег."""

    name = "stub"

    def __init__(self, seed: int | None = None):
        self._rng = random.Random(seed)

    def respond(
        self,
        user_text: str,
        system_prompt: str = "",
        tools: list[dict] | None = None,
        history: list[dict] | None = None,
    ) -> LLMReply:
        t = user_text.strip().lower()
        calls: list[dict] = []

        def add(tool: str, **args) -> None:
            calls.append({"tool": tool, "args": args})

        if _EYES_RE.search(t):
            add("eyes", mode=_eyes_mode(t))
        if _CIGAR_RE.search(t):
            add("cigar", on=not re.search(r"потуши|затуши|выключ|не кури|хватит", t, re.I))
        if _CHEST_RE.search(t):
            add("chest", open=not _CLOSE_RE.search(t))
        if _JAW_RE.search(t):
            add("jaw", pos=_jaw_pos(t))
        if _ANTENNA_RE.search(t):
            add("antenna_bob")
        if _WAVE_RE.search(t):
            add("wave", side=_wave_side(t))
        if _LOOK_RE.search(t):
            add("look")
        if _STATUS_RE.search(t):
            add("status")

        say_match = _SAY_RE.search(t)
        draft = ""
        if say_match:
            phrase = _say_phrase(t, say_match.group(1))
            add("say", text=phrase)
            draft = phrase
        elif calls:
            draft = ""  # финальную реплику соберёт refine после исполнения
        elif _GREETING_RE.match(t):
            return LLMReply(text=self._rng.choice(_GREET_POOL))
        else:
            return LLMReply(text=self._rng.choice(_FALLBACK_POOL))

        return LLMReply(text=draft, tool_calls=calls)

    def refine(self, user_text: str, executed: list[tuple[dict, dict]], reply: LLMReply) -> str:
        """Финальная реплика после исполнения: учитывает, что железо ответило."""
        t = user_text.lower()
        lines: list[str] = []

        if not executed:
            said = [c for c in reply.tool_calls if c.get("tool") == "say"]
            if said:
                phrase = (said[0].get("args") or {}).get("text", "")
                return f"«{phrase}» — сказано. Динамика ещё нет, так что поверь логу, мясомешок."
            return reply.text or self._rng.choice(_FALLBACK_POOL)

        for call, res in executed:
            name = call.get("tool")
            ok = res.get("ok", False)
            args = call.get("args") or {}
            if name == "say":
                continue
            if name == "eyes":
                if not ok:
                    lines.append(res.get("error", "?"))
                elif _WINK_RE.search(t):
                    lines.append(
                        "Подмигнул, старина. Лог засчитал: тело без светодиодов пока "
                        "мигает только в моём воображении."
                    )
                else:
                    lines.append(
                        f"Глаза в режиме «{args.get('mode', 'on')}». Пока в логе — "
                        "припаяешь светодиоды, будут светить в комнате."
                    )
            elif name == "cigar":
                if not ok:
                    lines.append(res.get("error", "?"))
                elif args.get("on"):
                    lines.append(
                        "Сигара тлеет. Красный светодиод — где-то в воображении. "
                        "Паяльник за тобой, мясомешок."
                    )
                else:
                    lines.append("Потушил. Дымить в сухом логе — дурной тон.")
            elif name == "chest":
                if not ok:
                    lines.append(res.get("error", "?"))
                elif args.get("open"):
                    lines.append("Люк открыт. Пиво и краденое — воображаемые, но дверца в логе скрипит.")
                else:
                    lines.append("Закрыл люк. Моё добро лучше тебя, мясомешок.")
            elif name == "jaw":
                if not ok:
                    lines.append(res.get("error", "?"))
                else:
                    lines.append(f"Челюсть на {args.get('pos')}. Говорить пока нечем, щёлкать уже могу.")
            elif name == "antenna_bob":
                if not ok:
                    lines.append(res.get("error", "?"))
                else:
                    lines.append("Антенна качнулась. Ну, мысленно: серво у неё ещё нет.")
            elif name == "status":
                if ok:
                    rep = "; ".join(f"{k} — {v}" for k, v in res.get("result", STATUS_RESULT).items())
                    lines.append(f"Диагностика, старина: {rep}. Характер — сто из ста.")
                else:
                    lines.append(res.get("error", "?"))
            else:
                lines.append(res.get("error") or f"{name}: сделано в логе.")

        if lines:
            return " ".join(lines)
        return reply.text or self._rng.choice(_FALLBACK_POOL)


# ---------------------------------------------------------------------------
# Слот под Ollama: локальная модель с тем же промптом и каталогом
# ---------------------------------------------------------------------------


class OllamaLLM:
    """Локальная модель через Ollama. Не поднялась — рантайм вернётся на заглушку."""

    name = "ollama"

    def __init__(self, model: str | None = None, host: str | None = None, timeout: float | None = None):
        self.model = model or os.environ.get("BRAIN_OLLAMA_MODEL", "llama3.1")
        self.host = (host or os.environ.get("BRAIN_OLLAMA_HOST", "http://127.0.0.1:11434")).rstrip("/")
        self.timeout = timeout or float(os.environ.get("BRAIN_OLLAMA_TIMEOUT", "120"))
        self._ctx: list[dict] = []

    # -- протокол ----------------------------------------------------------

    def respond(
        self,
        user_text: str,
        system_prompt: str,
        tools: list[dict] | None = None,
        history: list[dict] | None = None,
    ) -> LLMReply:
        messages = [{"role": "system", "content": system_prompt}]
        messages.extend(history or [])
        messages.append({"role": "user", "content": user_text})
        payload = {
            "model": self.model,
            "stream": False,
            "messages": messages,
            "tools": [
                {
                    "type": "function",
                    "function": {
                        "name": t["name"],
                        "description": t["description"],
                        "parameters": t["parameters"],
                    },
                }
                for t in tools or []
            ],
        }
        data = self._post("/api/chat", payload)
        self._ctx = messages
        msg = data.get("message", {})
        calls: list[dict] = []
        for idx, tc in enumerate(msg.get("tool_calls") or [], start=1):
            fn = tc.get("function", {})
            args = fn.get("arguments") or {}
            if isinstance(args, str):
                try:
                    args = json.loads(args)
                except json.JSONDecodeError:
                    args = {}
            calls.append({"tool": fn.get("name"), "args": args, "_id": f"call_{idx}"})
        return LLMReply(text=(msg.get("content") or ""), tool_calls=calls)

    def refine(self, user_text: str, executed: list[tuple[dict, dict]], reply: LLMReply) -> str:
        if not executed:
            return reply.text
        messages = list(self._ctx)
        messages.append(
            {
                "role": "assistant",
                "content": reply.text or None,
                "tool_calls": [
                    {
                        "id": call.get("_id", f"call_{i}"),
                        "type": "function",
                        "function": {"name": call.get("tool"), "arguments": call.get("args") or {}},
                    }
                    for i, (call, _) in enumerate(executed, start=1)
                ],
            }
        )
        for i, (call, res) in enumerate(executed, start=1):
            messages.append(
                {
                    "role": "tool",
                    "tool_call_id": call.get("_id", f"call_{i}"),
                    "content": json.dumps(res, ensure_ascii=False),
                }
            )
        data = self._post("/api/chat", {"model": self.model, "stream": False, "messages": messages})
        return data.get("message", {}).get("content") or reply.text

    # -- сеть ---------------------------------------------------------------

    def _post(self, path: str, payload: dict) -> dict:
        body = json.dumps(payload).encode("utf-8")
        req = urllib.request.Request(
            self.host + path,
            data=body,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except (urllib.error.URLError, TimeoutError, OSError, json.JSONDecodeError) as exc:
            raise LLMError(f"Ollama не отвечает ({self.host}): {exc}") from exc


def make_llm(kind: str = "stub", model: str | None = None, host: str | None = None):
    """Фабрика движков: ``stub`` (сейчас) или ``ollama`` (слот на потом)."""
    kind = (kind or "stub").lower()
    if kind == "ollama":
        return OllamaLLM(model=model, host=host)
    return StubLLM()
