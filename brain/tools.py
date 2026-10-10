"""Каталог инструментов Бендера и их исполнение.

Мозг (LLM) не дёргает GPIO. Мозг зовёт tool, рантайм исполняет.
Пока железа нет — каждый вызов честно пишется в сухой лог и возвращает
``{"ok": true, ..., "dry_run": true}`` (см. ``TOOLS.md``).

Запрет на выдуманные конечности: вызов инструмента, которого нет в
каталоге, вернёт ``ok: false``.
"""

from __future__ import annotations

import json
import logging
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

log = logging.getLogger("brain.dryrun")

#: Каталог инструментов, обещанных телу (версия 0 из TOOLS.md).
CATALOG: list[dict] = [
    {
        "name": "say",
        "description": (
            "Озвучить текст голосом Бендера: TTS в динамик, челюсть в такт. "
            "Обязателен для речи в комнату."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "text": {"type": "string", "description": "Текст, который скажет Бендер"}
            },
            "required": ["text"],
        },
    },
    {
        "name": "eyes",
        "description": "Режим подсветки глазниц (кольцо WS2812).",
        "parameters": {
            "type": "object",
            "properties": {
                "mode": {
                    "type": "string",
                    "enum": ["on", "off", "dim", "angry", "party"],
                    "description": "Режим глаз; по умолчанию on",
                }
            },
            "required": [],
        },
    },
    {
        "name": "cigar",
        "description": "Сигара (красный светодиод): зажечь или потушить.",
        "parameters": {
            "type": "object",
            "properties": {
                "on": {"type": "boolean", "description": "true — зажечь, false — потушить"}
            },
            "required": ["on"],
        },
    },
    {
        "name": "chest",
        "description": "Люк в груди (дверца): там пиво и краденое.",
        "parameters": {
            "type": "object",
            "properties": {"open": {"type": "boolean", "description": "true — открыть, false — закрыть"}},
            "required": ["open"],
        },
    },
    {
        "name": "jaw",
        "description": "Челюсть: позиция серво, 0 — закрыта, 100 — открыта.",
        "parameters": {
            "type": "object",
            "properties": {"pos": {"type": "integer", "minimum": 0, "maximum": 100}},
            "required": ["pos"],
        },
    },
    {
        "name": "antenna_bob",
        "description": "Покачать антенной (серво или светодиод антенны, когда появится).",
        "parameters": {"type": "object", "properties": {}, "required": []},
    },
    {
        "name": "wave",
        "description": "Помахать рукой: слева, справа или обеими. Рук пока нет.",
        "parameters": {
            "type": "object",
            "properties": {"side": {"type": "string", "enum": ["left", "right", "both"]}},
            "required": [],
        },
    },
    {
        "name": "look",
        "description": "Кадр с камеры и описание сцены. Камеры пока нет.",
        "parameters": {"type": "object", "properties": {}, "required": []},
    },
    {
        "name": "status",
        "description": "Диагностика тела: питание, серво, связь с ESP32.",
        "parameters": {"type": "object", "properties": {}, "required": []},
    },
]

BY_NAME: dict[str, dict] = {t["name"]: t for t in CATALOG}

#: Что отвечать на `status`, пока тело — стол без питания.
STATUS_RESULT = {
    "движок": "заглушка (правила), слот под Ollama готов",
    "esp32": "не в сети — железо не куплено",
    "питание": "нет, стол",
    "серво": 0,
    "глаза": "сухой лог",
    "сигара": "сухой лог",
    "касса": "см. BUDGET.md",
}


def default_log_path() -> Path:
    """Сухой лог живёт в ``var/`` у корня репозитория (в .gitignore)."""
    root = Path(__file__).resolve().parent.parent
    return root / "var" / "dry_run.log"


def _validate(spec: dict, args: Any) -> str | None:
    """Мини-валидация аргументов против схемы. Возвращает текст ошибки или None."""
    if not isinstance(args, dict):
        return "аргументы должны быть объектом"
    props = spec["parameters"]["properties"]
    for r in spec["parameters"].get("required", []):
        if r not in args:
            return f"не хватает обязательного аргумента '{r}'"
    for key, val in args.items():
        if key not in props:
            return f"неизвестный аргумент '{key}'"
        p = props[key]
        t = p.get("type")
        if t == "string" and not isinstance(val, str):
            return f"'{key}' должен быть строкой"
        if t == "boolean" and not isinstance(val, bool):
            return f"'{key}' должен быть true/false"
        if t == "integer" and (isinstance(val, bool) or not isinstance(val, int)):
            return f"'{key}' должен быть целым числом"
        if t == "number" and (isinstance(val, bool) or not isinstance(val, (int, float))):
            return f"'{key}' должен быть числом"
        if "enum" in p and val not in p["enum"]:
            return f"'{key}'={val!r} не из списка {p['enum']}"
        if isinstance(val, (int, float)) and not isinstance(val, bool):
            if "minimum" in p and val < p["minimum"]:
                return f"'{key}' меньше {p['minimum']}"
            if "maximum" in p and val > p["maximum"]:
                return f"'{key}' больше {p['maximum']}"
    return None


class ToolRuntime:
    """Исполнитель инструментов. Пока нет железа — честный сухой лог."""

    def __init__(self, log_file: Path | None = None):
        self.log_file = Path(log_file) if log_file else default_log_path()
        self.log_file.parent.mkdir(parents=True, exist_ok=True)

    # -- публичное ---------------------------------------------------------

    def execute(self, call: dict) -> dict:
        """Выполняет один вызов вида ``{"tool": ..., "args": {...}}``."""
        name = str(call.get("tool") or call.get("name") or "").strip().lower()
        args = call.get("args")
        if args is None:
            args = call.get("arguments") or {}
        if isinstance(args, str):
            try:
                args = json.loads(args)
            except json.JSONDecodeError:
                args = {}

        spec = BY_NAME.get(name)
        if spec is None:
            err = f"нет такого инструмента в каталоге: {name!r}. Я не выдумываю конечности, старина."
            return self._finish({"ok": False, "tool": name, "error": err}, args)

        problem = _validate(spec, args)
        if problem:
            return self._finish(
                {"ok": False, "tool": name, "error": problem, "dry_run": True}, args
            )

        body = dict(args)
        if name == "eyes":
            body.setdefault("mode", "on")
        if name == "wave":
            body.setdefault("side", "both")

        if name == "look":
            res = {
                "ok": False,
                "tool": name,
                "error": "камеры нет, старина. Глазею в темноту собственной головы.",
                "dry_run": True,
            }
        elif name == "wave":
            res = {
                "ok": False,
                "tool": name,
                "error": "рук нет, старина. Морально помахал — и хватит с тебя.",
                "dry_run": True,
            }
        elif name == "status":
            res = {"ok": True, "tool": name, "result": dict(STATUS_RESULT), "dry_run": True}
        else:
            res = {"ok": True, "tool": name, "result": body, "dry_run": True}
        return self._finish(res, args)

    # -- внутреннее --------------------------------------------------------

    def _finish(self, res: dict, args: dict) -> dict:
        self._append_log(res, args)
        if res.get("ok"):
            log.info("[dry-run] %s → ok", format_call(res.get("tool", "?"), args))
        else:
            log.info("[dry-run] %s → отказ: %s", format_call(res.get("tool", "?"), args), res.get("error"))
        return res

    def _append_log(self, res: dict, args: dict) -> None:
        entry = {"ts": datetime.now(timezone.utc).isoformat(), "call": args, **res}
        try:
            with self.log_file.open("a", encoding="utf-8") as fh:
                fh.write(json.dumps(entry, ensure_ascii=False) + "\n")
        except OSError as exc:  # лог не должен ронять характер
            log.warning("не удалось записать сухой лог: %s", exc)


def format_call(name: str, args: dict | None = None) -> str:
    """Человекочитаемая строка вызова: ``eyes(mode='angry')``."""
    args = args or {}
    if name == "say":
        text = str(args.get("text", ""))
        if len(text) > 60:
            text = text[:57] + "..."
        return f'say(text="{text}")'
    inner = ", ".join(f"{k}={v!r}" for k, v in args.items())
    return f"{name}({inner})"


def format_call_line(call: dict, res: dict) -> str:
    """Строка для консоли: что позвали и что ответило (сухое) железо."""
    name = str(call.get("tool", "?"))
    shown = format_call(name, call.get("args") or {})
    if res.get("ok"):
        return f"[dry-run] {shown} → ok"
    return f"[dry-run] {shown} → отказ: {res.get('error', '?')}"
