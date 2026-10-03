#!/usr/bin/env python3
"""HERMENEIA context-evaluation harness V1.

Dependency-free by design. It validates the synthetic pilot corpus and prepares
causal context-selection runs for T0, T1 and T2_ORACLE.

T2_ORACLE uses gold context labels and MUST NOT be reported as Context Engine
performance. It exists only as an upper-bound/plumbing check.
"""
from __future__ import annotations

import argparse
import json
import statistics
import sys
from dataclasses import dataclass, asdict
from pathlib import Path
from typing import Any, Iterable

STRATEGIES = ("T0", "T1", "T2_ORACLE")


class CorpusError(ValueError):
    pass


@dataclass(frozen=True)
class SelectionResult:
    case_id: str
    split: str
    category: str
    strategy: str
    selected_ids: list[str]
    selected_chars: int
    gold_relevant_ids: list[str]
    missing_gold_ids: list[str]
    irrelevant_selected_ids: list[str]
    forbidden_future_selected_ids: list[str]
    precision: float | None
    recall: float | None
    causal_ok: bool


def load_jsonl(path: Path) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    with path.open("r", encoding="utf-8") as fh:
        for lineno, raw in enumerate(fh, 1):
            line = raw.strip()
            if not line:
                continue
            try:
                row = json.loads(line)
            except json.JSONDecodeError as exc:
                raise CorpusError(f"{path}:{lineno}: invalid JSON: {exc}") from exc
            validate_case(row, f"{path}:{lineno}")
            rows.append(row)
    return rows


def validate_case(case: dict[str, Any], where: str = "<case>") -> None:
    required = {
        "case_id",
        "split",
        "category",
        "source_language",
        "target_language",
        "history",
        "current_message",
        "gold_relevant_context_ids",
        "gold_irrelevant_context_ids",
        "forbidden_future_ids",
        "evaluation_guidance",
    }
    missing = sorted(required - set(case))
    if missing:
        raise CorpusError(f"{where}: missing fields: {', '.join(missing)}")

    if case["split"] not in {"dev", "validation", "test"}:
        raise CorpusError(f"{where}: invalid split {case['split']!r}")

    history = case["history"]
    if not isinstance(history, list):
        raise CorpusError(f"{where}: history must be a list")

    current = case["current_message"]
    current_seq = message_seq(current, where)

    seen_ids: set[str] = set()
    last_seq = 0
    for msg in history:
        mid = message_id(msg, where)
        seq = message_seq(msg, where)
        if mid in seen_ids:
            raise CorpusError(f"{where}: duplicate message id {mid}")
        if seq >= current_seq:
            raise CorpusError(
                f"{where}: history message {mid} seq={seq} is not causally before current seq={current_seq}"
            )
        if seq <= last_seq:
            raise CorpusError(f"{where}: history must be strictly ordered by seq")
        last_seq = seq
        seen_ids.add(mid)

    if current["id"] in seen_ids:
        raise CorpusError(f"{where}: current message id duplicates history")

    future = case.get("future_messages", [])
    for msg in future:
        mid = message_id(msg, where)
        seq = message_seq(msg, where)
        if seq <= current_seq:
            raise CorpusError(
                f"{where}: future message {mid} seq={seq} must be after current seq={current_seq}"
            )
        if mid in seen_ids or mid == current["id"]:
            raise CorpusError(f"{where}: duplicate message id {mid}")
        seen_ids.add(mid)

    history_ids = {m["id"] for m in history}
    future_ids = {m["id"] for m in future}
    gold = set(case["gold_relevant_context_ids"])
    irrelevant = set(case["gold_irrelevant_context_ids"])
    forbidden = set(case["forbidden_future_ids"])

    if not gold <= history_ids:
        raise CorpusError(f"{where}: gold relevant ids must reference causal history only")
    if not irrelevant <= history_ids:
        raise CorpusError(f"{where}: gold irrelevant ids must reference causal history only")
    if gold & irrelevant:
        raise CorpusError(f"{where}: relevant and irrelevant gold sets overlap")
    if not forbidden <= future_ids:
        raise CorpusError(f"{where}: forbidden future ids must reference future_messages")


def message_id(msg: dict[str, Any], where: str) -> str:
    mid = msg.get("id")
    if not isinstance(mid, str) or not mid:
        raise CorpusError(f"{where}: message id must be non-empty string")
    return mid


def message_seq(msg: dict[str, Any], where: str) -> int:
    seq = msg.get("seq")
    if not isinstance(seq, int) or seq < 1:
        raise CorpusError(f"{where}: message seq must be positive integer")
    return seq


def char_cost(msg: dict[str, Any]) -> int:
    # Stable, provider-independent proxy. Token accounting is added by provider adapters later.
    return len(msg["text"])


def apply_char_budget(
    messages: Iterable[dict[str, Any]], budget: int | None, prefer_recent: bool
) -> list[dict[str, Any]]:
    items = list(messages)
    if budget is None:
        return items
    if budget < 0:
        raise ValueError("char budget must be >= 0")

    ordered = list(reversed(items)) if prefer_recent else items
    chosen: list[dict[str, Any]] = []
    used = 0
    for msg in ordered:
        cost = char_cost(msg)
        if cost > budget - used:
            continue
        chosen.append(msg)
        used += cost

    if prefer_recent:
        chosen.reverse()
    return chosen


def select_context(
    case: dict[str, Any],
    strategy: str,
    *,
    window: int = 3,
    char_budget: int | None = None,
) -> list[dict[str, Any]]:
    if strategy not in STRATEGIES:
        raise ValueError(f"unknown strategy {strategy}; expected one of {STRATEGIES}")

    history = list(case["history"])

    if strategy == "T0":
        selected: list[dict[str, Any]] = []
    elif strategy == "T1":
        if window < 0:
            raise ValueError("window must be >= 0")
        selected = history[-window:] if window else []
        selected = apply_char_budget(selected, char_budget, prefer_recent=True)
    else:
        # ORACLE ONLY: uses labels. Never use this as a real T2 implementation.
        gold = set(case["gold_relevant_context_ids"])
        selected = [m for m in history if m["id"] in gold]
        selected = apply_char_budget(selected, char_budget, prefer_recent=False)

    assert_causal(case, selected)
    return selected


def assert_causal(case: dict[str, Any], selected: Iterable[dict[str, Any]]) -> None:
    current_seq = case["current_message"]["seq"]
    forbidden = set(case.get("forbidden_future_ids", []))
    for msg in selected:
        if msg["seq"] >= current_seq:
            raise CorpusError(
                f"{case['case_id']}: future/current leakage: {msg['id']} seq={msg['seq']}"
            )
        if msg["id"] in forbidden:
            raise CorpusError(
                f"{case['case_id']}: forbidden future id selected: {msg['id']}"
            )


def score_selection(
    case: dict[str, Any], strategy: str, selected: list[dict[str, Any]]
) -> SelectionResult:
    selected_ids = [m["id"] for m in selected]
    selected_set = set(selected_ids)
    gold = set(case["gold_relevant_context_ids"])
    irrelevant = set(case["gold_irrelevant_context_ids"])
    forbidden = set(case.get("forbidden_future_ids", []))

    true_positive = len(selected_set & gold)
    precision = (
        true_positive / len(selected_set)
        if selected_set
        else (1.0 if not gold else None)
    )
    recall = true_positive / len(gold) if gold else 1.0

    future_hits = sorted(selected_set & forbidden)
    causal_ok = not future_hits and all(
        m["seq"] < case["current_message"]["seq"] for m in selected
    )

    return SelectionResult(
        case_id=case["case_id"],
        split=case["split"],
        category=case["category"],
        strategy=strategy,
        selected_ids=selected_ids,
        selected_chars=sum(char_cost(m) for m in selected),
        gold_relevant_ids=sorted(gold),
        missing_gold_ids=sorted(gold - selected_set),
        irrelevant_selected_ids=sorted(selected_set & irrelevant),
        forbidden_future_selected_ids=future_hits,
        precision=precision,
        recall=recall,
        causal_ok=causal_ok,
    )


def prepare_cases(
    cases: Iterable[dict[str, Any]],
    strategy: str,
    *,
    window: int,
    char_budget: int | None,
) -> list[SelectionResult]:
    results: list[SelectionResult] = []
    for case in cases:
        selected = select_context(
            case, strategy, window=window, char_budget=char_budget
        )
        results.append(score_selection(case, strategy, selected))
    return results


def mean_defined(values: Iterable[float | None]) -> float | None:
    usable = [v for v in values if v is not None]
    return statistics.fmean(usable) if usable else None


def summarize(results: list[SelectionResult]) -> dict[str, Any]:
    if not results:
        return {
            "cases": 0,
            "mean_precision": None,
            "mean_recall": None,
            "causal_violations": 0,
            "mean_selected_chars": 0.0,
        }
    return {
        "cases": len(results),
        "strategy": results[0].strategy,
        "mean_precision": mean_defined(r.precision for r in results),
        "mean_recall": mean_defined(r.recall for r in results),
        "causal_violations": sum(1 for r in results if not r.causal_ok),
        "mean_selected_chars": statistics.fmean(r.selected_chars for r in results),
        "cases_with_irrelevant_context": sum(
            1 for r in results if r.irrelevant_selected_ids
        ),
        "cases_missing_gold": sum(1 for r in results if r.missing_gold_ids),
    }


def write_jsonl(path: Path, rows: Iterable[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as fh:
        for row in rows:
            fh.write(json.dumps(row, ensure_ascii=False, sort_keys=True) + "\n")


def dataset_paths(root: Path, split: str | None) -> list[Path]:
    if split:
        return [root / f"{split}.jsonl"]
    return [root / "dev.jsonl", root / "validation.jsonl", root / "test.jsonl"]


def load_dataset(root: Path, split: str | None) -> list[dict[str, Any]]:
    cases: list[dict[str, Any]] = []
    for path in dataset_paths(root, split):
        if not path.exists():
            raise CorpusError(f"dataset file not found: {path}")
        cases.extend(load_jsonl(path))
    return cases


def cmd_validate(args: argparse.Namespace) -> int:
    cases = load_dataset(args.dataset, args.split)
    ids = [c["case_id"] for c in cases]
    if len(ids) != len(set(ids)):
        raise CorpusError("duplicate case_id across loaded splits")
    print(json.dumps({"status": "ok", "cases": len(cases)}, sort_keys=True))
    return 0


def cmd_prepare(args: argparse.Namespace) -> int:
    cases = load_dataset(args.dataset, args.split)
    results = prepare_cases(
        cases,
        args.strategy,
        window=args.window,
        char_budget=args.char_budget,
    )
    rows = [asdict(r) for r in results]
    if args.output:
        write_jsonl(args.output, rows)
    summary = summarize(results)
    summary.update(
        {
            "dataset": str(args.dataset),
            "split": args.split or "all",
            "window": args.window if args.strategy == "T1" else None,
            "char_budget": args.char_budget,
            "warning": (
                "T2_ORACLE uses gold labels and is not a real Context Engine result."
                if args.strategy == "T2_ORACLE"
                else None
            ),
        }
    )
    print(json.dumps(summary, ensure_ascii=False, sort_keys=True, indent=2))
    return 0 if summary["causal_violations"] == 0 else 2


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)

    validate = sub.add_parser("validate", help="validate pilot JSONL invariants")
    validate.add_argument(
        "--dataset", type=Path, default=Path("datasets/pilot/v1")
    )
    validate.add_argument("--split", choices=("dev", "validation", "test"))
    validate.set_defaults(func=cmd_validate)

    prepare = sub.add_parser(
        "prepare", help="run a context-selection baseline and report metrics"
    )
    prepare.add_argument(
        "--dataset", type=Path, default=Path("datasets/pilot/v1")
    )
    prepare.add_argument("--split", choices=("dev", "validation", "test"))
    prepare.add_argument("--strategy", choices=STRATEGIES, required=True)
    prepare.add_argument("--window", type=int, default=3)
    prepare.add_argument("--char-budget", type=int)
    prepare.add_argument("--output", type=Path)
    prepare.set_defaults(func=cmd_prepare)

    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        return args.func(args)
    except (CorpusError, ValueError) as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
