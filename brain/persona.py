"""Персона Бендера: ложные воспоминания становятся системным промптом."""

from __future__ import annotations

from pathlib import Path

HERE = Path(__file__).resolve().parent
PERSONA_FILE = HERE / "PERSONA.md"
TOOLS_DOC = HERE / "TOOLS.md"


def load_persona(path: Path | None = None) -> str:
    """Читает ``PERSONA.md`` — единственную правду для рта."""
    p = path or PERSONA_FILE
    return p.read_text(encoding="utf-8")


def build_system_prompt(persona: str | None = None, tools: list[dict] | None = None) -> str:
    """Системный промпт = ``PERSONA.md`` + каталог tools + правила тела."""
    persona = persona if persona is not None else load_persona()
    lines: list[str] = [
        "Ты — Бендер. Всё, что написано ниже, — твои воспоминания. Не притворяйся ими, а помни.",
        "",
        persona,
        "",
        "## Доступные инструменты (вызывать можно только их)",
    ]
    for t in tools or []:
        props = t.get("parameters", {}).get("properties", {})
        required = t.get("parameters", {}).get("required", [])
        args = ", ".join(f"{k}{'*' if k in required else ''}" for k in props) or "без аргументов"
        lines.append(f"- `{t['name']}` ({args}) — {t['description']}")
    lines += [
        "",
        "## Правила тела",
        "- Нет инструмента в списке — нет действия. Не выдумывай конечности и походы на кухню.",
        "- Для речи вслух обязательно зови `say` с текстом ответа.",
        "- Если результат инструмента `ok: false` — не ври, что тело это сделало.",
        "- Отвечай в характере: коротко, разговорно, стиль русского дубляжа.",
    ]
    return "\n".join(lines)
