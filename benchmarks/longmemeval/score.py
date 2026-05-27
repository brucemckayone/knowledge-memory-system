"""LongMemEval scoring aggregator.

Takes per-question judge verdicts and aggregates into the five-category
breakdown + overall accuracy + abstention rate. Sanity check: abstention
must be strictly between 0% and 100% (nmemo-eue acceptance criterion 4)
— a fully-broken pipeline would abstain at the boundary.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from .dataset import CATEGORIES, Question


@dataclass
class QuestionResult:
    question_id: str
    category: str
    score: float  # 0.0 = wrong, 1.0 = right
    judge_reasoning: str

    @property
    def is_correct(self) -> bool:
        return self.score >= 0.5


def aggregate(question_results: list[QuestionResult]) -> dict[str, Any]:
    """Return the score dict for the JSON envelope.

    Shape:
      {
        "overall_accuracy": 0.42,
        "by_category": {
            "information_extraction": {"accuracy": 0.5, "n": 200, "correct": 100},
            ...five entries, one per category...
        },
        "abstention_rate": 0.18,    # fraction of items where Mnemo declined
                                    # to answer (judge marked 0 on abstention
                                    # = candidate did NOT abstain when it
                                    # should have; abstention_rate is the
                                    # FRACTION of abstention items where the
                                    # candidate correctly abstained.
        "sanity_pass": true,        # abstention strictly in (0,1)
        "n": 500,
        "correct": 211
      }
    """
    by_category: dict[str, list[QuestionResult]] = {c: [] for c in CATEGORIES}
    for qr in question_results:
        by_category.setdefault(qr.category, []).append(qr)

    cat_scores: dict[str, dict[str, Any]] = {}
    for category, items in by_category.items():
        n = len(items)
        correct = sum(1 for item in items if item.is_correct)
        cat_scores[category] = {
            "accuracy": round(correct / n, 4) if n else None,
            "n": n,
            "correct": correct,
        }

    total = len(question_results)
    total_correct = sum(1 for r in question_results if r.is_correct)

    # Abstention rate = fraction of abstention items the candidate correctly
    # abstained on. Sanity check is the bracket test: strictly between 0% and
    # 100%. A pipeline that abstains 0% (never declines) or 100% (always
    # declines) is broken in two different ways; both should fail the gate.
    abstention_items = by_category.get("abstention", [])
    abstention_correct = sum(1 for item in abstention_items if item.is_correct)
    abstention_rate = (
        abstention_correct / len(abstention_items) if abstention_items else None
    )
    sanity_pass = (
        abstention_rate is not None and 0.0 < abstention_rate < 1.0
    )

    return {
        "overall_accuracy": round(total_correct / total, 4) if total else 0.0,
        "by_category": cat_scores,
        "abstention_rate": (
            round(abstention_rate, 4) if abstention_rate is not None else None
        ),
        "sanity_pass": sanity_pass,
        "n": total,
        "correct": total_correct,
    }


def categorise(question: Question) -> str:
    """Convenience: ask a Question for its bucket. Mirrors Question.category
    but explicit at the score module level for grep-ability."""
    return question.category
