"""Тесты раунда 4: Бендер помнит канон «Футурамы».

Критерий раунда: лор полный (все серии всех сезонов + фильмы), поиск
вытаскивает нужное воспоминание, заглушка отвечает из памяти, а чего в
памяти нет — честно «не помню». Тело при этом не ломается.
Запуск: ``python -m unittest`` из корня репозитория.
"""

from __future__ import annotations

import subprocess
import sys
import tempfile
import unittest
from collections import Counter
from pathlib import Path

from brain.llm import StubLLM
from brain.lore import LORE_DIR, format_memories, get_index, recall, stem, tokenize
from brain.persona import build_system_prompt, load_persona
from brain.runtime import make_brain
from brain.tools import CATALOG

REPO_ROOT = Path(__file__).resolve().parent.parent

#: Производственные сезоны: S05 — это четыре фильма (F1–F4).
EXPECTED_EPISODES = {
    "S01": 13, "S02": 19, "S03": 22, "S04": 18,
    "S06": 26, "S07": 26, "S08": 10, "S09": 10, "S10": 10, "S11": 10,
}


def top_title(query: str) -> str:
    hits = recall(query, k=1)
    return hits[0]["title"] if hits else ""


class LoreCompleteness(unittest.TestCase):
    """В памяти все серии, без дублей и дыр."""

    def setUp(self):
        self.codes = get_index().episodes()

    def test_per_season_counts(self):
        seasons = Counter(c[:3] for c in self.codes if c.startswith("S"))
        self.assertEqual(dict(seasons), EXPECTED_EPISODES)

    def test_four_films(self):
        self.assertEqual([c for c in self.codes if c.startswith("F")], ["F1", "F2", "F3", "F4"])

    def test_total_matches_aired_180(self):
        # 164 серии + 4 фильма × 4 части на Comedy Central = 180 эпизодов.
        films = sum(1 for c in self.codes if c.startswith("F"))
        self.assertEqual(len(self.codes) - films + films * 4, 180)

    def test_codes_unique_and_sequential(self):
        self.assertEqual(len(self.codes), len(set(self.codes)))
        for season, n in EXPECTED_EPISODES.items():
            got = [c for c in self.codes if c.startswith(season)]
            self.assertEqual(got, [f"{season}E{i:02d}" for i in range(1, n + 1)], season)

    def test_every_episode_has_text(self):
        for c in get_index().chunks:
            if c.code:
                self.assertTrue(c.text.strip(), c.title)

    def test_readme_is_not_memory(self):
        self.assertTrue((LORE_DIR / "README.md").exists())
        self.assertNotIn("README.md", {c.source for c in get_index().chunks})


class Stemming(unittest.TestCase):
    def test_case_forms_meet(self):
        self.assertEqual(stem("сеймура"), stem("сеймур"))
        self.assertEqual(stem("розуэллом"), stem("розуэлл"))
        self.assertEqual(stem("лилу"), stem("лила"))

    def test_yo_and_stopwords(self):
        self.assertEqual(tokenize("Ёлка"), tokenize("елка"))
        self.assertEqual(tokenize("помнишь про это?"), [])


class Recall(unittest.TestCase):
    """Нужное воспоминание всплывает первым."""

    def test_seymour_is_jurassic_bark(self):
        self.assertEqual(top_title("помнишь Сеймура?"), "S04E07 · Jurassic Bark")
        self.assertEqual(top_title("как звали собаку Фрая"), "S04E07 · Jurassic Bark")

    def test_characters_hit_dossier(self):
        self.assertTrue(top_title("кто такой Зойдберг").startswith("Доктор Зойдберг"))
        self.assertTrue(top_title("расскажи про Флексо").startswith("Флексо"))
        self.assertTrue(top_title("кто такой Фрай").startswith("Фрай"))

    def test_pharaoh_and_god(self):
        self.assertEqual(top_title("когда ты был фараоном"), "S03E17 · A Pharaoh to Remember")
        self.assertEqual(top_title("как ты стал богом"), "S03E20 · Godfellas")

    def test_films_and_codes(self):
        self.assertEqual(top_title("помнишь Йиво"), "Йиво (Yivo)")
        self.assertEqual(top_title("S04E07"), "S04E07 · Jurassic Bark")
        self.assertTrue(top_title("Подземелья и драконы").startswith("F3"))

    def test_hulu_seasons_remembered(self):
        self.assertTrue(top_title("Момазон").startswith("S08E05"))
        self.assertTrue(top_title("кроссовер с Разочарованием").startswith("S11E09"))

    def test_unknown_is_empty(self):
        self.assertEqual(recall("кто такой Вася Пупкин"), [])

    def test_format_respects_budget(self):
        hits = recall("Фрай Лила Бендер Зойдберг", k=5)
        self.assertLessEqual(len(format_memories(hits, budget=600)), 600)


class StubAnswersFromMemory(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.brain = make_brain(speak=False, log_file=Path(self._tmp.name) / "dry.log")

    def tearDown(self):
        self._tmp.cleanup()

    def test_seymour_answer(self):
        out = self.brain.handle("помнишь Сеймура?")
        self.assertIn("Jurassic Bark", out["reply"])
        self.assertIn("Сеймур", out["reply"])
        self.assertEqual(out["executed"], [], "вспоминать — не действие тела")
        self.assertEqual(out["memories"][0]["code"], "S04E07")

    def test_episode_question_prefers_episode(self):
        out = self.brain.handle("помнишь серию, где Лила получила второй глаз?")
        self.assertIn("S03E09", out["reply"])

    def test_question_without_trigger_word(self):
        out = self.brain.handle("когда ты был фараоном?")
        self.assertIn("Pharaoh", out["reply"])

    def test_unknown_is_not_invented(self):
        out = self.brain.handle("помнишь серию про Васю Пупкина?")
        self.assertIn("не помню", out["reply"].lower())

    def test_bio_still_bio(self):
        out = self.brain.handle("расскажи о себе")
        self.assertIn("2716057", out["reply"])

    def test_wink_still_eyes(self):
        out = self.brain.handle("подмигни")
        self.assertIn("eyes", [c["tool"] for c, _ in out["executed"]])

    def test_amnesia_switch(self):
        brain = make_brain(speak=False, log_file=Path(self._tmp.name) / "dry2.log", lore=False)
        out = brain.handle("помнишь Сеймура?")
        self.assertEqual(out["memories"], [])
        self.assertIn("не помню", out["reply"].lower())

    def test_stub_without_memories_forgets(self):
        reply = StubLLM(seed=1).respond("помнишь Сеймура?", memories=None)
        self.assertIn("не помню", reply.text.lower())


class PromptCarriesMemories(unittest.TestCase):
    def test_memories_block_in_prompt(self):
        hits = recall("помнишь Сеймура?")
        prompt = build_system_prompt(load_persona(), CATALOG, memories=hits)
        self.assertIn("## Всплыло в памяти (канон)", prompt)
        self.assertIn("Jurassic Bark", prompt)
        self.assertIn("не выдумывай", prompt)
        self.assertIn("Нет инструмента в списке — нет действия", prompt)

    def test_no_memories_no_block(self):
        prompt = build_system_prompt(load_persona(), CATALOG)
        self.assertNotIn("Всплыло в памяти", prompt)

    def test_brain_passes_memories_to_llm(self):
        seen = {}

        class Spy(StubLLM):
            def respond(self, user_text, system_prompt="", tools=None, history=None, memories=None):
                seen["prompt"], seen["memories"] = system_prompt, memories
                return super().respond(user_text, system_prompt, tools, history, memories=memories)

        with tempfile.TemporaryDirectory() as tmp:
            from brain.runtime import Brain

            Brain(llm=Spy(), speak=False, log_file=Path(tmp) / "d.log").handle("кто такой Флексо?")
        self.assertTrue(seen["memories"])
        self.assertIn("Флексо", seen["prompt"])


class CliRecall(unittest.TestCase):
    def test_recall_flag(self):
        proc = subprocess.run(
            [sys.executable, "-m", "brain", "--recall", "Сеймур"],
            cwd=REPO_ROOT, capture_output=True, text=True, timeout=60,
        )
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertIn("Jurassic Bark", proc.stdout)

    def test_recall_unknown(self):
        proc = subprocess.run(
            [sys.executable, "-m", "brain", "--recall", "Вася Пупкин"],
            cwd=REPO_ROOT, capture_output=True, text=True, timeout=60,
        )
        self.assertEqual(proc.returncode, 1)
        self.assertIn("Не помню", proc.stdout)


if __name__ == "__main__":
    unittest.main()
