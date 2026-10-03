import json
import tempfile
import unittest
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "research" / "eval"))

import harness  # noqa: E402


class HarnessTests(unittest.TestCase):
    def setUp(self):
        self.case = {
            "case_id": "unit.case",
            "split": "dev",
            "category": "unit",
            "source_language": "fr-FR",
            "target_language": "en-US",
            "history": [
                {"id": "m1", "seq": 1, "author": "A", "text": "old irrelevant"},
                {"id": "m2", "seq": 2, "author": "B", "text": "useful context"},
                {"id": "m3", "seq": 3, "author": "A", "text": "more useful"},
            ],
            "current_message": {"id": "m4", "seq": 4, "author": "A", "text": "current"},
            "future_messages": [
                {"id": "m5", "seq": 5, "author": "B", "text": "future answer"}
            ],
            "gold_relevant_context_ids": ["m2", "m3"],
            "gold_irrelevant_context_ids": ["m1"],
            "forbidden_future_ids": ["m5"],
            "evaluation_guidance": {"ambiguity": "unit", "preserve": []},
        }

    def test_validate_accepts_well_formed_case(self):
        harness.validate_case(self.case)

    def test_t0_selects_no_history(self):
        self.assertEqual(harness.select_context(self.case, "T0"), [])

    def test_t1_uses_recent_window(self):
        selected = harness.select_context(self.case, "T1", window=2)
        self.assertEqual([m["id"] for m in selected], ["m2", "m3"])

    def test_t2_oracle_uses_only_gold_prior_context(self):
        selected = harness.select_context(self.case, "T2_ORACLE")
        self.assertEqual([m["id"] for m in selected], ["m2", "m3"])

    def test_budget_never_partially_includes_message(self):
        selected = harness.select_context(self.case, "T1", window=3, char_budget=11)
        self.assertTrue(sum(len(m["text"]) for m in selected) <= 11)

    def test_future_history_is_rejected_by_validation(self):
        broken = json.loads(json.dumps(self.case))
        broken["history"].append(
            {"id": "bad", "seq": 6, "author": "A", "text": "future"}
        )
        with self.assertRaises(harness.CorpusError):
            harness.validate_case(broken)

    def test_assert_causal_rejects_future_selection(self):
        with self.assertRaises(harness.CorpusError):
            harness.assert_causal(self.case, self.case["future_messages"])

    def test_scoring_reports_irrelevant_context(self):
        selected = harness.select_context(self.case, "T1", window=3)
        scored = harness.score_selection(self.case, "T1", selected)
        self.assertEqual(scored.irrelevant_selected_ids, ["m1"])
        self.assertAlmostEqual(scored.recall, 1.0)
        self.assertAlmostEqual(scored.precision, 2 / 3)

    def test_jsonl_loader_validates_rows(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "cases.jsonl"
            path.write_text(json.dumps(self.case) + "\n", encoding="utf-8")
            rows = harness.load_jsonl(path)
            self.assertEqual(rows[0]["case_id"], "unit.case")


if __name__ == "__main__":
    unittest.main()
