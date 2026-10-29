#!/usr/bin/env python3
"""Offline evaluation of human labels and exported rankings; never runs a model."""
from __future__ import annotations

import argparse
import json
import math
import statistics
import sys
from pathlib import Path
from typing import Any

RUNS = ("B1", "B2", "B3", "final")
MAX_SAFE_INTEGER = 9007199254740991


class EvaluationError(ValueError):
    pass


def require(condition: bool, message: str) -> None:
    if not condition:
        raise EvaluationError(message)


def object_keys(value: Any, required: set[str], optional: set[str], where: str) -> dict:
    require(isinstance(value, dict), f"{where}: expected object")
    require(required <= value.keys(), f"{where}: missing required fields {sorted(required - value.keys())}")
    require(not value.keys() - required - optional, f"{where}: unexpected fields")
    return value


def identifier(value: Any, where: str) -> str:
    require(isinstance(value, str) and 0 < len(value) <= 256 and value == value.strip()
            and not any(ord(c) < 32 or ord(c) == 127 for c in value), f"{where}: invalid identifier")
    return value


def milliseconds(value: Any, where: str) -> int:
    require(type(value) is int and 0 <= value <= MAX_SAFE_INTEGER, f"{where}: expected nonnegative safe integer milliseconds")
    return value


def interval(value: dict, scope: dict | None, where: str) -> dict | None:
    fields = {"channel_id", "from_ms", "to_ms"}
    present = fields & value.keys()
    if not present:
        return None
    require(present == fields, f"{where}: time metadata requires channel_id, from_ms and to_ms together")
    channel = identifier(value["channel_id"], where + ".channel_id")
    start = milliseconds(value["from_ms"], where + ".from_ms")
    end = milliseconds(value["to_ms"], where + ".to_ms")
    require(end > start, f"{where}: expected nonempty half-open interval")
    if scope:
        require(channel in scope["channel_ids"] and scope["from_ms"] <= start < end <= scope["to_ms"],
                f"{where}: interval outside the explicitly annotated scope")
    return {"channel_id": channel, "from_ms": start, "to_ms": end}


def normalize(raw: Any) -> tuple[dict, list[dict]]:
    data = object_keys(raw, {"schema_version", "annotation", "queries"}, set(), "input")
    require(data["schema_version"] == "1.0", "input: unsupported schema_version")
    annotation = object_keys(data["annotation"], {"source", "id", "corpus_id"}, set(), "annotation")
    require(annotation["source"] == "human", "annotation: real human labels are required; generated/predicted labels are not evaluation truth")
    identifier(annotation["id"], "annotation.id")
    identifier(annotation["corpus_id"], "annotation.corpus_id")
    require(isinstance(data["queries"], list) and 0 < len(data["queries"]) <= 10000, "queries: expected 1..10000 annotated queries")
    queries, query_ids = [], set()
    for position, raw_query in enumerate(data["queries"]):
        where = f"queries[{position}]"
        q = object_keys(raw_query, {"id", "text", "scope", "labels", "runs"}, set(), where)
        qid = identifier(q["id"], where + ".id")
        require(qid not in query_ids, f"{where}: duplicate query id")
        query_ids.add(qid)
        require(isinstance(q["text"], str) and bool(q["text"].strip()) and len(q["text"]) <= 2048, f"{where}: missing query text")
        scope = object_keys(q["scope"], {"channel_ids", "from_ms", "to_ms"}, set(), where + ".scope")
        require(isinstance(scope["channel_ids"], list) and 0 < len(scope["channel_ids"]) <= 100, f"{where}: invalid scope channels")
        channels = [identifier(c, where + ".scope.channel_ids") for c in scope["channel_ids"]]
        require(len(set(channels)) == len(channels), f"{where}: duplicate scope channel")
        start, end = milliseconds(scope["from_ms"], where), milliseconds(scope["to_ms"], where)
        require(end > start, f"{where}: invalid scope interval")
        labels = object_keys(q["labels"], {"reviewed", "complete", "no_match", "relevant"}, set(), where + ".labels")
        require(labels["reviewed"] is True and labels["complete"] is True,
                f"{where}: labels must be human-reviewed and complete for the declared evaluation corpus/scope")
        require(type(labels["no_match"]) is bool, f"{where}: no_match must be explicitly true or false")
        require(isinstance(labels["relevant"], list) and len(labels["relevant"]) <= 10000, f"{where}: invalid relevant labels")
        relevant = {}
        for raw_label in labels["relevant"]:
            label = {"id": raw_label} if isinstance(raw_label, str) else object_keys(
                raw_label, {"id"}, {"grade", "channel_id", "from_ms", "to_ms"}, where + ".relevant")
            rid = identifier(label["id"], where + ".relevant.id")
            require(rid not in relevant, f"{where}: duplicate relevant id")
            grade = label.get("grade", 1)
            require(type(grade) is int and 1 <= grade <= 3, f"{where}: relevance grade must be 1..3 (absent means binary grade 1)")
            relevant[rid] = {"grade": grade, "interval": interval(label, scope, where + ".relevant")}
        require(bool(relevant) != labels["no_match"], f"{where}: a positive query needs relevant IDs; a no-match query must have none")
        runs = object_keys(q["runs"], set(), set(RUNS), where + ".runs")
        rankings = {}
        for name, ranking in runs.items():
            require(isinstance(ranking, list) and len(ranking) <= 10000, f"{where}.{name}: expected an ordered candidate array")
            rows, seen = [], set()
            for raw_candidate in ranking:
                row = {"id": raw_candidate} if isinstance(raw_candidate, str) else object_keys(
                    raw_candidate, {"id"}, {"channel_id", "from_ms", "to_ms"}, where + "." + name)
                rid = identifier(row["id"], where + "." + name + ".id")
                require(rid not in seen, f"{where}.{name}: duplicate candidate id; do not inflate metrics with duplicate results")
                seen.add(rid)
                timing = interval(row, scope, where + "." + name)
                labelled = relevant.get(rid, {}).get("interval")
                require(not timing or not labelled or timing["channel_id"] == labelled["channel_id"],
                        f"{where}.{name}: the same stable ID has inconsistent labelled/result channels")
                rows.append({"id": rid, "interval": timing})
            rankings[name] = rows
        queries.append({"id": qid, "scope": scope, "relevant": relevant, "no_match": labels["no_match"], "runs": rankings})
    return annotation, queries


def mean(values: list[float]) -> float | None:
    return statistics.fmean(values) if values else None


def distribution(values: list[float]) -> dict:
    ordered = sorted(values)
    return {"samples": len(values), "mean": mean(values), "median": statistics.median(values) if values else None,
            "p95": ordered[math.ceil(0.95 * len(ordered)) - 1] if values else None}


def dcg(grades: list[int]) -> float:
    return sum((2 ** grade - 1) / math.log2(rank + 2) for rank, grade in enumerate(grades))


def time_errors(candidate: dict, truth: dict) -> dict:
    a, b, x, y = candidate["from_ms"], candidate["to_ms"], truth["from_ms"], truth["to_ms"]
    return {"start_abs_error_ms": abs(a - x), "end_abs_error_ms": abs(b - y),
            "midpoint_abs_error_ms": abs((a + b) - (x + y)) / 2,
            "interval_gap_ms": max(x - b, a - y, 0)}


def evaluate(raw: Any, cutoffs: list[int] | tuple[int, ...] = (1, 5, 10, 20)) -> dict:
    require(bool(cutoffs) and all(type(k) is int and 1 <= k <= 10000 for k in cutoffs), "k: expected cutoffs in 1..10000")
    ks = sorted(set(cutoffs))
    annotation, queries = normalize(raw)
    report = {"schema_version": "1.0", "evaluation": "offline_human_labelled_rankings",
              "annotation": annotation, "cutoffs": ks,
              "dataset": {"queries": len(queries), "positive_queries": sum(not q["no_match"] for q in queries),
                          "no_match_queries": sum(q["no_match"] for q in queries),
                          "relevant_ids": sum(len(q["relevant"]) for q in queries)},
              "notes": ["No model, inference, threshold tuning or label generation was performed.",
                        "Rankings are evaluated in supplied order; IDs must share the human annotation namespace.",
                        "Recall and nDCG are macro averages over positive queries with a supplied run; absent grades mean binary relevance 1.",
                        "No-match false-return rate means at least one returned candidate; it does not assert that the UI claimed a match.",
                        "Time errors use only a relevant top-1 result with both labelled and returned intervals. Failures/missing dimensions are counted separately.",
                        "Null means not measurable, never zero error. P95 uses the nearest-rank method.",
                        "This report alone does not establish field acceptance or frozen quality thresholds."],
              "runs": {}}
    for name in RUNS:
        present = [q for q in queries if name in q["runs"]]
        positives = [q for q in present if not q["no_match"]]
        negatives = [q for q in present if q["no_match"]]
        missing = {"run_queries": len(queries) - len(present),
                   "relevant_ids_without_time": sum(v["interval"] is None for q in positives for v in q["relevant"].values()),
                   "candidates_without_time_or_channel": sum(r["interval"] is None for q in present for r in q["runs"][name]),
                   "top1_no_candidate": 0, "top1_irrelevant": 0,
                   "top1_label_time_missing": 0, "top1_candidate_time_missing": 0}
        timing_values = {key: [] for key in ("start_abs_error_ms", "end_abs_error_ms", "midpoint_abs_error_ms", "interval_gap_ms")}
        per_query, top1_relevant = [], 0
        for q in present:
            rows, relevant = q["runs"][name], q["relevant"]
            scores = {}
            for k in ks:
                top = rows[:k]
                if q["no_match"]:
                    scores[str(k)] = {"recall": None, "ndcg": None, "no_match_false_return": bool(top), "returned": len(top)}
                else:
                    grades = [relevant.get(r["id"], {}).get("grade", 0) for r in top]
                    ideal = sorted((v["grade"] for v in relevant.values()), reverse=True)[:k]
                    scores[str(k)] = {"recall": sum(r["id"] in relevant for r in top) / len(relevant),
                                      "ndcg": dcg(grades) / dcg(ideal), "no_match_false_return": None, "returned": len(top)}
            timing, reason = None, None
            if not q["no_match"]:
                if not rows:
                    missing["top1_no_candidate"] += 1; reason = "no_candidate"
                elif rows[0]["id"] not in relevant:
                    missing["top1_irrelevant"] += 1; reason = "top1_irrelevant"
                else:
                    top1_relevant += 1
                    truth = relevant[rows[0]["id"]]["interval"]
                    candidate = rows[0]["interval"]
                    if truth is None:
                        missing["top1_label_time_missing"] += 1
                    if candidate is None:
                        missing["top1_candidate_time_missing"] += 1
                    if truth is None or candidate is None:
                        reason = "missing_time_metadata"
                    else:
                        timing = time_errors(candidate, truth)
                        for key, value in timing.items():
                            timing_values[key].append(value)
            per_query.append({"query_id": q["id"], "at_k": scores, "time_top1": timing, "time_unmeasured_reason": reason})
        aggregate = {}
        for k in ks:
            rows = [r["at_k"][str(k)] for r in per_query]
            recall = [r["recall"] for r in rows if r["recall"] is not None]
            ndcg = [r["ndcg"] for r in rows if r["ndcg"] is not None]
            false_returns = [r["no_match_false_return"] for r in rows if r["no_match_false_return"] is not None]
            aggregate[str(k)] = {"recall": mean(recall), "ndcg": mean(ndcg), "positive_query_samples": len(recall),
                                 "no_match_false_return_rate": mean(false_returns), "no_match_false_return_queries": sum(false_returns),
                                 "no_match_query_samples": len(false_returns)}
        measured = len(timing_values["interval_gap_ms"])
        report["runs"][name] = {"query_samples": len(present), "positive_query_samples": len(positives),
                                "no_match_query_samples": len(negatives), "at_k": aggregate,
                                "time_top1": {"positive_query_samples": len(positives), "relevant_top1_samples": top1_relevant,
                                              "measured_samples": measured,
                                              "measurement_rate": measured / len(positives) if positives else None,
                                              **{key: distribution(values) for key, values in timing_values.items()}},
                                "missing_dimensions": missing, "per_query": per_query}
    return report


def no_duplicate_keys(pairs: list[tuple[str, Any]]) -> dict:
    value = {}
    for key, item in pairs:
        require(key not in value, "input: duplicate JSON object key")
        value[key] = item
    return value


def load_input(path: Path) -> Any:
    require(path.stat().st_size <= 64 * 1024 * 1024, "input exceeds the 64 MiB offline evaluation limit")
    def reject_constant(_value: str) -> None:
        raise EvaluationError("input: non-finite JSON numbers are forbidden")
    return json.loads(path.read_text(encoding="utf-8-sig"), object_pairs_hook=no_duplicate_keys, parse_constant=reject_constant)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", required=True, type=Path, help="Human annotations plus exported B1/B2/B3/final rankings")
    parser.add_argument("--output", type=Path, help="Write JSON report here; default is stdout")
    parser.add_argument("--k", default="1,5,10,20", help="Comma-separated positive cutoffs, default 1,5,10,20")
    args = parser.parse_args(argv)
    try:
        ks = [int(k) for k in args.k.split(",")]
        report = evaluate(load_input(args.input), ks)
        text = json.dumps(report, ensure_ascii=False, indent=2, allow_nan=False) + "\n"
        if args.output:
            require(args.output.resolve() != args.input.resolve(), "output must not overwrite human annotations")
            args.output.write_text(text, encoding="utf-8")
        else:
            sys.stdout.write(text)
        return 0
    except (EvaluationError, ValueError, OSError) as error:
        sys.stderr.write(f"Evaluation refused: {error}\n")
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
