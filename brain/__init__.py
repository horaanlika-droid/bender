"""BENDER — рантайм-мозг без железа (раунд 3).

Персона берётся из ``PERSONA.md``, каталог инструментов — из ``TOOLS.md``
(здесь он выражен JSON-схемами в :mod:`brain.tools`). Железа пока нет,
поэтому каждый tool честно пишет в сухой лог и возвращает ``dry_run: true``.

Запуск::

    python -m brain            # диалог с мясомешком
    python -m brain подмигни   # одна реплика и выход
    python -m unittest         # проверка критерия раунда
"""

__version__ = "0.3.0"

from .runtime import Brain  # noqa: F401

__all__ = ["Brain", "__version__"]
