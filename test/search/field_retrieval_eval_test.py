"""Synthetic unit oracles only; these are not field labels or quality results."""
import contextlib
import copy
import io
import json
import math
import tempfile
import unittest
from pathlib import Path

from field_retrieval_eval import EvaluationError, evaluate, load_input, main


def dataset():
    return {"schema_version": "1.0", "annotation": {"source": "human", "id": "unit-oracle-not-field", "corpus_id": "synthetic-unit-corpus"},
            "queries": [{"id": "q1", "text": "人工查询标签的单测替身", "scope": {"channel_ids": ["cam1", "cam2"], "from_ms": 0, "to_ms": 20000},
                         "labels": {"reviewed": True, "complete": True, "no_match": False,
                                    "relevant": [{"id": "a", "grade": 3, "channel_id": "cam1", "from_ms": 10000, "to_ms": 13000}, {"id": "b", "grade": 1}]},
                         "runs": {"B1": ["a", "b"], "B2": ["b", "a"], "B3": ["noise", "a", "b"], "final": ["a", "b"]}}]}


class FieldRetrievalEvaluationTest(unittest.TestCase):
    def test_ordering_recall_and_graded_ndcg(self):
        report = evaluate(dataset(), [1, 2, 3])
        self.assertEqual(report["runs"]["B1"]["at_k"]["1"]["recall"], 0.5)
        self.assertEqual(report["runs"]["B1"]["at_k"]["2"]["recall"], 1)
        self.assertEqual(report["runs"]["B1"]["at_k"]["2"]["ndcg"], 1)
        swapped = (1 + 7 / math.log2(3)) / (7 + 1 / math.log2(3))
        self.assertAlmostEqual(report["runs"]["B2"]["at_k"]["2"]["ndcg"], swapped)
        self.assertEqual(report["runs"]["B3"]["at_k"]["1"]["recall"], 0)
        self.assertEqual(report["runs"]["B3"]["at_k"]["3"]["recall"], 1)

    def test_string_labels_use_binary_ndcg_without_inventing_grades(self):
        data = dataset(); data["queries"][0]["labels"]["relevant"] = ["a", "b"]
        report = evaluate(data, [2])
        self.assertEqual(report["runs"]["B2"]["at_k"]["2"]["ndcg"], 1)
        self.assertEqual(report["runs"]["B2"]["missing_dimensions"]["relevant_ids_without_time"], 2)

    def test_macro_average_includes_empty_positive_run(self):
        data = dataset(); second = copy.deepcopy(data["queries"][0]); second["id"] = "q2"; second["runs"]["final"] = []
        data["queries"].append(second)
        result = evaluate(data, [2])["runs"]["final"]
        self.assertEqual(result["at_k"]["2"]["recall"], 0.5)
        self.assertEqual(result["at_k"]["2"]["ndcg"], 0.5)
        self.assertEqual(result["time_top1"]["positive_query_samples"], 2)
        self.assertEqual(result["missing_dimensions"]["top1_no_candidate"], 1)

    def test_no_match_false_returns_use_a_separate_denominator(self):
        data = dataset(); q = data["queries"][0]
        q["labels"] = {"reviewed": True, "complete": True, "no_match": True, "relevant": []}; q["runs"]["final"] = []
        second = copy.deepcopy(q); second["id"] = "q2"; second["runs"]["final"] = ["noise"]
        data["queries"].append(second)
        result = evaluate(data, [1, 5])["runs"]["final"]
        self.assertEqual(result["at_k"]["1"]["no_match_false_return_rate"], 0.5)
        self.assertEqual(result["at_k"]["1"]["no_match_query_samples"], 2)
        self.assertEqual(result["at_k"]["1"]["no_match_false_return_queries"], 1)
        self.assertIsNone(result["at_k"]["1"]["recall"])
        self.assertIsNone(result["at_k"]["1"]["ndcg"])
        self.assertIsNone(result["time_top1"]["interval_gap_ms"]["mean"])

    def test_top1_time_errors_include_boundary_midpoint_and_disjoint_gap(self):
        data = dataset(); q = data["queries"][0]
        q["runs"]["final"] = [{"id": "a", "channel_id": "cam1", "from_ms": 11000, "to_ms": 14000}]
        result = evaluate(data)["runs"]["final"]["time_top1"]
        self.assertEqual(result["measured_samples"], 1)
        self.assertEqual(result["start_abs_error_ms"]["mean"], 1000)
        self.assertEqual(result["end_abs_error_ms"]["mean"], 1000)
        self.assertEqual(result["midpoint_abs_error_ms"]["mean"], 1000)
        self.assertEqual(result["interval_gap_ms"]["mean"], 0)
        q["runs"]["final"][0].update(from_ms=16000, to_ms=18000)
        result = evaluate(data)["runs"]["final"]["time_top1"]
        self.assertEqual(result["interval_gap_ms"]["p95"], 3000)
        self.assertEqual(result["start_abs_error_ms"]["mean"], 6000)

    def test_irrelevant_top1_is_counted_and_not_replaced_by_a_later_good_time(self):
        data = dataset(); data["queries"][0]["runs"]["final"] = ["noise", {"id": "a", "channel_id": "cam1", "from_ms": 10000, "to_ms": 13000}]
        result = evaluate(data)["runs"]["final"]
        self.assertEqual(result["missing_dimensions"]["top1_irrelevant"], 1)
        self.assertEqual(result["time_top1"]["measured_samples"], 0)
        self.assertIsNone(result["time_top1"]["start_abs_error_ms"]["mean"])

    def test_missing_runs_and_time_are_null_and_counted_not_perfect_scores(self):
        data = dataset(); q = data["queries"][0]; del q["runs"]["B1"]
        report = evaluate(data)
        self.assertIsNone(report["runs"]["B1"]["at_k"]["1"]["recall"])
        self.assertEqual(report["runs"]["B1"]["missing_dimensions"]["run_queries"], 1)
        self.assertEqual(report["runs"]["final"]["missing_dimensions"]["top1_candidate_time_missing"], 1)
        self.assertEqual(report["runs"]["final"]["time_top1"]["measured_samples"], 0)

    def test_refuses_missing_unreviewed_incomplete_or_automatic_labels(self):
        variants = []
        data = dataset(); del data["queries"][0]["labels"]; variants.append(data)
        data = dataset(); data["queries"][0]["labels"]["reviewed"] = False; variants.append(data)
        data = dataset(); data["queries"][0]["labels"]["complete"] = False; variants.append(data)
        data = dataset(); data["annotation"]["source"] = "model"; variants.append(data)
        data = dataset(); data["queries"][0]["labels"]["relevant"] = []; variants.append(data)
        data = dataset(); data["queries"][0]["labels"]["no_match"] = True; variants.append(data)
        for data in variants:
            with self.subTest(data=data), self.assertRaises(EvaluationError):
                evaluate(data)

    def test_refuses_duplicate_ids_partial_time_and_out_of_scope_results(self):
        variants = []
        data = dataset(); data["queries"][0]["runs"]["final"] = ["a", "a"]; variants.append(data)
        data = dataset(); data["queries"][0]["labels"]["relevant"] = ["a", "a"]; variants.append(data)
        data = dataset(); data["queries"].append(copy.deepcopy(data["queries"][0])); variants.append(data)
        data = dataset(); data["queries"][0]["runs"]["final"] = [{"id": "a", "from_ms": 10000}]; variants.append(data)
        data = dataset(); data["queries"][0]["runs"]["final"] = [{"id": "a", "channel_id": "unknown", "from_ms": 10000, "to_ms": 13000}]; variants.append(data)
        data = dataset(); data["queries"][0]["runs"]["final"] = [{"id": "a", "channel_id": "cam2", "from_ms": 10000, "to_ms": 13000}]; variants.append(data)
        data = dataset(); data["queries"][0]["runs"]["final"] = [{"id": "a", "channel_id": "cam1", "from_ms": 10000, "to_ms": 30000}]; variants.append(data)
        data = dataset(); data["queries"][0]["runs"]["FINAL"] = []; variants.append(data)
        for data in variants:
            with self.subTest(data=data), self.assertRaises(EvaluationError):
                evaluate(data)

    def test_cli_refusal_writes_no_accuracy_report_and_does_not_overwrite_labels(self):
        with tempfile.TemporaryDirectory() as directory:
            source, output = Path(directory) / "labels.json", Path(directory) / "report.json"
            data = dataset(); data["queries"][0]["labels"]["reviewed"] = False
            source.write_text(json.dumps(data), encoding="utf-8")
            with contextlib.redirect_stderr(io.StringIO()), contextlib.redirect_stdout(io.StringIO()) as stdout:
                self.assertEqual(main(["--input", str(source), "--output", str(output)]), 2)
            self.assertEqual(stdout.getvalue(), ""); self.assertFalse(output.exists())
            source.write_text(json.dumps(dataset()), encoding="utf-8"); original = source.read_bytes()
            with contextlib.redirect_stderr(io.StringIO()):
                self.assertEqual(main(["--input", str(source), "--output", str(source)]), 2)
            self.assertEqual(source.read_bytes(), original)
            self.assertEqual(main(["--input", str(source), "--output", str(output), "--k", "1,2"]), 0)
            self.assertEqual(json.loads(output.read_text())["runs"]["final"]["at_k"]["2"]["recall"], 1)

    def test_rejects_duplicate_json_keys_and_nonfinite_values(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "invalid.json"
            for text in ('{"queries":[],"queries":[]}', '{"value":NaN}', '{"value":Infinity}'):
                source.write_text(text, encoding="utf-8")
                with self.subTest(text=text), self.assertRaises(EvaluationError):
                    load_input(source)

    def test_empty_dataset_and_invalid_cutoffs_are_refused(self):
        data = dataset(); data["queries"] = []
        with self.assertRaises(EvaluationError): evaluate(data)
        for cutoffs in ([], [0], [-1], [True], [1.5], [10001]):
            with self.subTest(cutoffs=cutoffs), self.assertRaises(EvaluationError): evaluate(dataset(), cutoffs)


if __name__ == "__main__":
    unittest.main()
