"""Склейка: реплика мясомешка → персона → LLM → tools → ответ в характере."""

from __future__ import annotations

from pathlib import Path

from .llm import LLMError, LLMReply, StubLLM, make_llm
from .lore import recall
from .persona import build_system_prompt, load_persona
from .tools import CATALOG, ToolRuntime

#: Сколько ходов помнить между репликами (для настоящих моделей).
HISTORY_LIMIT = 12
#: Сколько кусков лора подкладывать в промпт на ход.
RECALL_K = 3


class Brain:
    """Рантайм-мозг Бендера без железа.

    Порядок тела: сначала действия (глаза, сигара, люк), потом речь —
    ``say`` зовётся в конце, чтобы озвучить уже готовую реплику.
    """

    def __init__(
        self,
        llm=None,
        speak: bool = True,
        log_file: str | Path | None = None,
        lore: bool = True,
    ):
        self.llm = llm or StubLLM()
        self.speak = speak
        self.executor = ToolRuntime(log_file=Path(log_file) if log_file else None)
        self.persona = load_persona()
        self.history: list[dict] = []
        self.lore = lore
        self.last_memories: list[dict] = []

    # -- публичное ---------------------------------------------------------

    @property
    def engine(self) -> str:
        name = getattr(self.llm, "name", self.llm.__class__.__name__)
        if name == "ollama":
            return f"ollama:{getattr(self.llm, 'model', '?')}"
        return name

    def system_prompt(self, memories: list[dict] | None = None) -> str:
        return build_system_prompt(self.persona, CATALOG, memories=memories)

    def remember(self, user_text: str) -> list[dict]:
        """Что всплывает в долговременной памяти (лор) по реплике."""
        if not self.lore:
            return []
        try:
            return recall(user_text, k=RECALL_K)
        except OSError:
            return []

    def handle(self, user_text: str) -> dict:
        """Один ход: возвращает ``{"reply": ..., "executed": [(call, res), ...]}``."""
        user_text = (user_text or "").strip()
        if not user_text:
            return {"reply": "Я слышу тишину. Как и положено роботу без микрофона.", "executed": [], "memories": []}

        self.last_memories = self.remember(user_text)
        reply = self._respond(user_text, self.last_memories)

        action_calls = [c for c in reply.tool_calls if c.get("tool") != "say"]
        say_calls = [c for c in reply.tool_calls if c.get("tool") == "say"]

        executed: list[tuple[dict, dict]] = []
        for call in action_calls:
            executed.append((call, self.executor.execute(call)))

        final = self._refine(user_text, executed, reply)

        if self.speak and not say_calls and final.strip():
            say_calls.append({"tool": "say", "args": {"text": final}})
        for call in say_calls:
            executed.append((call, self.executor.execute(call)))

        self._remember(user_text, final)
        return {"reply": final, "executed": executed, "memories": self.last_memories}

    # -- внутреннее --------------------------------------------------------

    def _respond(self, user_text: str, memories: list[dict]) -> LLMReply:
        prompt = self.system_prompt(memories)
        try:
            return self.llm.respond(user_text, prompt, CATALOG, self.history, memories=memories)
        except LLMError as exc:
            if not isinstance(self.llm, StubLLM):
                print(f"⚠ {exc}\n⚠ Переключаюсь на заглушку: характер не должен молчать.", flush=True)
                self.llm = StubLLM()
                return self.llm.respond(user_text, prompt, CATALOG, self.history, memories=memories)
            raise

    def _refine(self, user_text: str, executed: list[tuple[dict, dict]], reply: LLMReply) -> str:
        try:
            final = self.llm.refine(user_text, executed, reply)
        except LLMError as exc:
            print(f"⚠ {exc}", flush=True)
            final = reply.text or "Ладно. Лог жив — и я жив."
        return final.strip()

    def _remember(self, user_text: str, final: str) -> None:
        self.history.append({"role": "user", "content": user_text})
        self.history.append({"role": "assistant", "content": final})
        if len(self.history) > HISTORY_LIMIT * 2:
            self.history = self.history[-HISTORY_LIMIT * 2 :]


def make_brain(kind: str = "stub", speak: bool = True, log_file: str | None = None,
               model: str | None = None, host: str | None = None, lore: bool = True) -> Brain:
    return Brain(llm=make_llm(kind, model=model, host=host), speak=speak, log_file=log_file, lore=lore)
