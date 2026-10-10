"""Тесты раунда 3: рантайм-мозг без железа (тело; память — в test_lore.py).

Главный критерий: «подмигни» вызывает инструмент ``eyes``, а не сказку.
Запуск: ``python -m unittest`` из корня репозитория.
"""

from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from brain.llm import StubLLM
from brain.persona import build_system_prompt, load_persona
from brain.runtime import make_brain
from brain.tools import CATALOG, ToolRuntime, default_log_path

REPO_ROOT = Path(__file__).resolve().parent.parent


def executed_tools(outcome: dict) -> dict[str, dict]:
    """{имя инструмента: результат} из ответа Brain.handle."""
    return {call["tool"]: res for call, res in outcome["executed"]}


class WinkCriterion(unittest.TestCase):
    """«подмигни» → вызов инструмента, не рассказ без вызова."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.log_file = Path(self._tmp.name) / "dry_run.log"
        self.brain = make_brain(speak=False, log_file=self.log_file)

    def tearDown(self):
        self._tmp.cleanup()

    def test_wink_calls_eyes(self):
        out = self.brain.handle("подмигни")
        tools = executed_tools(out)
        self.assertIn("eyes", tools, "должен быть вызов инструмента, а не сказка")
        self.assertTrue(tools["eyes"]["ok"])
        self.assertTrue(tools["eyes"]["dry_run"])
        self.assertNotIn("я подмигнул и ушёл спать", out["reply"].lower())

    def test_wink_writes_dry_log(self):
        self.brain.handle("подмигни")
        lines = [json.loads(l) for l in self.log_file.read_text(encoding="utf-8").splitlines()]
        self.assertTrue(any(l.get("tool") == "eyes" and l.get("dry_run") for l in lines))


class Intents(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.brain = make_brain(speak=False, log_file=Path(self._tmp.name) / "dry_run.log")

    def tearDown(self):
        self._tmp.cleanup()

    def test_cigar_and_angry_eyes(self):
        out = self.brain.handle("закури и подмигни злобно")
        tools = executed_tools(out)
        self.assertTrue(tools["cigar"]["ok"])
        self.assertTrue(tools["cigar"]["result"]["on"])
        self.assertEqual(tools["eyes"]["result"]["mode"], "angry")

    def test_chest_close(self):
        out = self.brain.handle("закрой люк")
        tools = executed_tools(out)
        self.assertFalse(tools["chest"]["result"]["open"])

    def test_say_explicit_phrase(self):
        out = self.brain.handle("скажи «я красавчик»")
        tools = executed_tools(out)
        self.assertEqual(tools["say"]["result"]["text"], "я красавчик")

    def test_wave_without_arms(self):
        out = self.brain.handle("помаши левой рукой")
        tools = executed_tools(out)
        self.assertFalse(tools["wave"]["ok"])
        self.assertIn("рук нет", tools["wave"]["error"])

    def test_look_without_frame(self):
        # кадра нет (морда не открыта или глаза выключены) — честный отказ, а не выдумка
        with tempfile.TemporaryDirectory() as empty:
            brain = make_brain(speak=False, log_file=Path(self._tmp.name) / "dry_run3.log")
            brain.executor.eyes_dir = Path(empty)
            out = brain.handle("что ты видишь?")
        tools = executed_tools(out)
        self.assertFalse(tools["look"]["ok"])
        self.assertIn("кадра нет", tools["look"]["error"])
        self.assertIn("/eyes on", tools["look"]["error"])

    def test_status_ok(self):
        out = self.brain.handle("статус")
        tools = executed_tools(out)
        self.assertTrue(tools["status"]["ok"])
        self.assertIn("esp32", tools["status"]["result"])

    def test_auto_say_speaks_final_reply(self):
        brain = make_brain(speak=True, log_file=Path(self._tmp.name) / "dry_run2.log")
        out = brain.handle("открой люк")
        tools = executed_tools(out)
        self.assertIn("say", tools)
        self.assertEqual(tools["say"]["result"]["text"], out["reply"])

    def test_no_tools_no_invented_actions(self):
        out = self.brain.handle("привет")
        self.assertEqual(out["executed"], [])
        self.assertTrue(out["reply"])


class LookFrame(unittest.TestCase):
    """``look`` читает кадр, который кладёт морда (var/eyes/latest.jpg)."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.eyes = Path(self._tmp.name) / "eyes"
        self.eyes.mkdir()
        self.runtime = ToolRuntime(log_file=Path(self._tmp.name) / "dry_run.log", eyes_dir=self.eyes)

    def tearDown(self):
        self._tmp.cleanup()

    def test_fresh_frame_is_read(self):
        frame = self.eyes / "latest.jpg"
        frame.write_bytes(b"\xff\xd8\xff\xe0fake")
        res = self.runtime.execute({"tool": "look", "args": {}})
        self.assertTrue(res["ok"])
        self.assertEqual(res["result"]["байт"], frame.stat().st_size)
        self.assertLessEqual(res["result"]["возраст_с"], 5)
        self.assertIn("vision", res["result"]["описание"])

    def test_stale_frame_refused(self):
        import os
        import time
        frame = self.eyes / "latest.jpg"
        frame.write_bytes(b"\xff\xd8\xff\xe0old")
        old = time.time() - 600
        os.utime(frame, (old, old))
        res = self.runtime.execute({"tool": "look", "args": {}})
        self.assertFalse(res["ok"])
        self.assertIn("старый", res["error"])

    def test_eyes_dir_from_env(self):
        import os
        from brain.tools import default_eyes_dir
        saved = os.environ.get("EYES_DIR")
        os.environ["EYES_DIR"] = str(self.eyes)
        try:
            self.assertEqual(default_eyes_dir(), self.eyes)
        finally:
            if saved is None:
                os.environ.pop("EYES_DIR", None)
            else:
                os.environ["EYES_DIR"] = saved


class CatalogAndValidation(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.runtime = ToolRuntime(log_file=Path(self._tmp.name) / "dry_run.log")

    def tearDown(self):
        self._tmp.cleanup()

    def test_catalog_covers_tools_md(self):
        names = {t["name"] for t in CATALOG}
        expected = {"say", "eyes", "cigar", "chest", "jaw", "antenna_bob", "wave", "look", "status"}
        self.assertEqual(names, expected)

    def test_unknown_tool_refused(self):
        res = self.runtime.execute({"tool": "walk", "args": {}})
        self.assertFalse(res["ok"])
        self.assertIn("каталог", res["error"])

    def test_bad_enum_refused(self):
        res = self.runtime.execute({"tool": "eyes", "args": {"mode": "синий"}})
        self.assertFalse(res["ok"])

    def test_missing_required_refused(self):
        res = self.runtime.execute({"tool": "cigar", "args": {}})
        self.assertFalse(res["ok"])

    def test_jaw_out_of_range_refused(self):
        res = self.runtime.execute({"tool": "jaw", "args": {"pos": 146}})
        self.assertFalse(res["ok"])

    def test_eyes_default_mode(self):
        res = self.runtime.execute({"tool": "eyes", "args": {}})
        self.assertTrue(res["ok"])
        self.assertEqual(res["result"]["mode"], "on")
        self.assertTrue(res["dry_run"])


class PersonaAndPrompt(unittest.TestCase):
    def test_system_prompt_carries_persona_and_tools(self):
        prompt = build_system_prompt(load_persona(), CATALOG)
        self.assertIn("2716057", prompt)
        self.assertIn("мясомешок", prompt)
        for name in ("say", "eyes", "cigar"):
            self.assertIn(name, prompt)
        self.assertIn("Нет инструмента в списке — нет действия", prompt)


class CliEndToEnd(unittest.TestCase):
    def test_one_shot_wink(self):
        proc = subprocess.run(
            [sys.executable, "-m", "brain", "--no-say", "подмигни"],
            cwd=REPO_ROOT,
            capture_output=True,
            text=True,
            timeout=60,
        )
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertIn("Бендер>", proc.stdout)
        self.assertIn("eyes(mode='on') → ok", proc.stdout)

    def test_log_goes_where_told(self):
        with tempfile.TemporaryDirectory() as tmp:
            log_file = Path(tmp) / "log.jsonl"
            proc = subprocess.run(
                [sys.executable, "-m", "brain", "--no-say", "--log-file", str(log_file), "закури"],
                cwd=REPO_ROOT,
                capture_output=True,
                text=True,
                timeout=60,
            )
            self.assertEqual(proc.returncode, 0, proc.stderr)
            self.assertTrue(log_file.exists())


if __name__ == "__main__":
    unittest.main()
