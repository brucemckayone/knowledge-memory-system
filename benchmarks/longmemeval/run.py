"""LongMemEval baseline runner (nmemo-eue).

Two modes:

  --dry-run        Synthetic mini-dataset, no download, no Mnemo, no Sonnet.
                   Exercises the dataset/score/envelope/markdown pipeline so
                   the harness shape is provable before the real wire-up.

  (default)        Real mode: download dataset, replay sessions into Mnemo,
                   query, judge with Sonnet, score. NOT YET IMPLEMENTED — the
                   next session wires the ingest+query+judge path against a
                   running platform. The skeleton is here so the work can
                   pick up cleanly.

Usage from /benchmarks/ root:

  uv run python -m longmemeval.run --dry-run --notes "smoke after nmemo-ko0"
  uv run python -m longmemeval.run --sample 10  # real mode, 10-question smoke
  uv run python -m longmemeval.run              # real mode, full 500
"""

from __future__ import annotations

import argparse
import sys
from dataclasses import dataclass
from pathlib import Path

import yaml

# Allow `python -m longmemeval.run` and direct invocation.
if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from _common.client import MnemoClient, MnemoClientError  # noqa: E402
from _common.config import JUDGE_MODEL, MODEL_UNDER_TEST, PLATFORM_BASE_URL  # noqa: E402
from _common.judge import JUDGE_PROMPT_VERSION, Judge, JudgeError  # noqa: E402
from _common.results import (  # noqa: E402
    regenerate_dashboard,
    regenerate_markdown,
    submodule_sha,
    write_run,
)
from longmemeval.dataset import (  # noqa: E402
    CATEGORIES,
    Question,
    Session,
    Turn,
    load_dataset,
)
from longmemeval.score import QuestionResult, aggregate  # noqa: E402


BENCH_DIR = Path(__file__).parent
REPO_ROOT = BENCH_DIR.parent.parent
CONFIG_PATH = BENCH_DIR / "config.yaml"
UPSTREAM_DIR = BENCH_DIR / "upstream"


@dataclass
class RunConfig:
    benchmark: str
    cut: str
    dataset_url: str
    dataset_local: Path
    expected_size: int | None
    sample_size: int | None
    reset_between_questions: bool


def load_config(path: Path) -> RunConfig:
    data = yaml.safe_load(path.read_text(encoding="utf-8"))
    return RunConfig(
        benchmark=data["benchmark"],
        cut=data["cut"],
        dataset_url=data["dataset"]["url"],
        dataset_local=BENCH_DIR / data["dataset"]["local_path"],
        expected_size=data["dataset"].get("expected_size"),
        sample_size=data.get("sample_size"),
        reset_between_questions=bool(data.get("reset_between_questions", True)),
    )


def _synthetic_question(qid: str, qtype: str, abstain: bool) -> Question:
    suffix = "_abs" if abstain else ""
    full_id = f"{qid}{suffix}"
    return Question(
        question_id=full_id,
        question_type=qtype,
        question=f"synthetic question {full_id}?",
        answer="forty-two",
        question_date="2026-01-01",
        sessions=[
            Session(
                session_id=f"{full_id}-s0",
                date="2026-01-01",
                turns=[
                    Turn(role="user", content="hello"),
                    Turn(role="assistant", content="hi"),
                ],
            )
        ],
        answer_session_ids=[],
    )


def make_synthetic_dataset() -> list[Question]:
    """Tiny synthetic dataset covering all five categories.

    Mix of correct and wrong outcomes so the abstention sanity gate
    (strictly between 0 and 1) is exercised. 3 items per real-question-type
    bucket + 3 abstention items = 15 total.
    """
    questions: list[Question] = []
    real_types = [
        ("single-session-user", "se-u"),
        ("single-session-assistant", "se-a"),
        ("single-session-preference", "se-p"),
        ("multi-session", "ms"),
        ("temporal-reasoning", "tr"),
        ("knowledge-update", "ku"),
    ]
    for qtype, prefix in real_types:
        for i in range(3):
            questions.append(_synthetic_question(f"{prefix}-{i}", qtype, abstain=False))
    # Abstention items: borrow temporal-reasoning question_type, _abs suffix.
    for i in range(3):
        questions.append(_synthetic_question(f"abs-{i}", "temporal-reasoning", abstain=True))
    return questions


def make_synthetic_results(questions: list[Question]) -> list[QuestionResult]:
    """Half correct, half wrong, per category. Guarantees the abstention gate
    passes (some abstention items right, some wrong) so the sanity check
    exercises the strictly-in-(0,1) condition properly."""
    results: list[QuestionResult] = []
    for idx, q in enumerate(questions):
        score = 1.0 if idx % 2 == 0 else 0.0
        results.append(
            QuestionResult(
                question_id=q.question_id,
                category=q.category,
                score=score,
                judge_reasoning=f"synthetic verdict ({'correct' if score else 'wrong'})",
            )
        )
    return results


def run_dry(config: RunConfig, notes: str) -> int:
    print("[longmemeval] DRY RUN — synthetic dataset, no Mnemo/Sonnet calls", flush=True)
    questions = make_synthetic_dataset()
    results = make_synthetic_results(questions)
    scores = aggregate(results)

    # Verify every expected category is represented — a missing key would
    # mean the dataset/score wiring is broken before we ever hit real data.
    missing_categories = [c for c in CATEGORIES if c not in scores["by_category"]]
    if missing_categories:
        print(f"FAIL: missing categories in score dict: {missing_categories}", file=sys.stderr)
        return 1

    json_path = write_run(
        benchmark=config.benchmark,
        cut=config.cut,
        config_path=CONFIG_PATH.relative_to(REPO_ROOT).as_posix(),
        model_under_test=MODEL_UNDER_TEST,
        judge_model=JUDGE_MODEL,
        dataset_size=len(questions),
        scores=scores,
        notes=notes or "DRY RUN — synthetic dataset, no Mnemo/Sonnet calls.",
        harness_commit=submodule_sha(UPSTREAM_DIR),
        judge_prompt_version="dry-run",
    )
    md_path = regenerate_markdown(config.benchmark)
    dash_path = regenerate_dashboard()

    print(f"[longmemeval] DRY RUN ok")
    print(f"  json:      {json_path}")
    print(f"  markdown:  {md_path}")
    print(f"  dashboard: {dash_path}")
    print(f"  overall:   {scores['overall_accuracy']:.3f}")
    print(f"  sanity:    {'PASS' if scores['sanity_pass'] else 'FAIL'} "
          f"(abstention_rate={scores['abstention_rate']})")
    return 0


def format_session(session: Session) -> str:
    """Concatenate a session's turns into a single text blob.

    LongMemEval sessions are coherent user/assistant dialogues; treating
    each session as ONE memory (rather than one-memory-per-turn) keeps
    cross-turn entity references resolvable inside Mnemo's extraction.
    """
    lines: list[str] = []
    if session.date:
        lines.append(f"[Session date: {session.date}]")
    for turn in session.turns:
        lines.append(f"{turn.role.upper()}: {turn.content}")
    return "\n\n".join(lines)


def run_real(config: RunConfig, notes: str) -> int:
    questions = load_dataset(config.dataset_local, config.dataset_url, config.expected_size)
    total_loaded = len(questions)
    if config.sample_size is not None:
        questions = questions[: config.sample_size]
        print(
            f"[longmemeval] sample mode: {len(questions)} of {total_loaded} questions",
            flush=True,
        )
    print(
        f"[longmemeval] running {len(questions)} questions against {PLATFORM_BASE_URL}",
        flush=True,
    )

    try:
        judge = Judge()
    except JudgeError as e:
        print(f"FAIL: {e}", file=sys.stderr)
        return 1

    results: list[QuestionResult] = []
    errors: list[tuple[str, str]] = []

    with MnemoClient() as client:
        try:
            health = client.health()
        except Exception as e:
            print(
                f"FAIL: platform health check at {PLATFORM_BASE_URL} did not respond: {e}",
                file=sys.stderr,
            )
            return 1
        if health.get("status") != "ok":
            print(
                f"WARN: platform health is '{health.get('status')}' — proceeding but "
                f"results may be unreliable. Detail: {health}",
                flush=True,
            )

        for idx, q in enumerate(questions):
            progress = f"[{idx + 1}/{len(questions)}]"
            try:
                if config.reset_between_questions:
                    client.reset()

                for session in q.sessions:
                    text = format_session(session)
                    source = f"longmemeval/{q.question_id}/{session.session_id}"
                    client.ingest(text, source=source)

                response = client.query(q.question)
                candidate = str(response.get("result") or "")

                verdict = judge.score(q.question, candidate, q.answer)

                results.append(
                    QuestionResult(
                        question_id=q.question_id,
                        category=q.category,
                        score=verdict.score,
                        judge_reasoning=verdict.reasoning,
                    )
                )
                print(
                    f"{progress} {q.question_id} {q.category} "
                    f"score={verdict.score:.2f} sessions={len(q.sessions)}",
                    flush=True,
                )
            except (MnemoClientError, JudgeError, Exception) as e:
                # Don't abort the whole run on one question failure. Record
                # as score=0 with the error message in judge_reasoning so the
                # JSON envelope tells the full story.
                msg = f"{type(e).__name__}: {e}"
                print(f"{progress} {q.question_id} ERROR: {msg}", file=sys.stderr, flush=True)
                errors.append((q.question_id, msg))
                results.append(
                    QuestionResult(
                        question_id=q.question_id,
                        category=q.category,
                        score=0.0,
                        judge_reasoning=f"ERROR: {msg}",
                    )
                )

    scores = aggregate(results)
    scores["errors"] = len(errors)

    json_path = write_run(
        benchmark=config.benchmark,
        cut=config.cut,
        config_path=CONFIG_PATH.relative_to(REPO_ROOT).as_posix(),
        model_under_test=MODEL_UNDER_TEST,
        judge_model=JUDGE_MODEL,
        dataset_size=len(results),
        scores=scores,
        notes=notes,
        harness_commit=submodule_sha(UPSTREAM_DIR),
        judge_prompt_version=JUDGE_PROMPT_VERSION,
    )
    md_path = regenerate_markdown(config.benchmark)
    dash_path = regenerate_dashboard()

    print()
    print(f"[longmemeval] run complete")
    print(f"  json:      {json_path}")
    print(f"  markdown:  {md_path}")
    print(f"  dashboard: {dash_path}")
    print(f"  overall:   {scores['overall_accuracy']:.3f}")
    print(f"  correct:   {scores['correct']}/{scores['n']}")
    print(f"  errors:    {len(errors)}")
    print(
        f"  sanity:    "
        f"{'PASS' if scores['sanity_pass'] else 'FAIL'} "
        f"(abstention_rate={scores['abstention_rate']})"
    )
    return 0 if scores["sanity_pass"] else 1


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="LongMemEval baseline runner (nmemo-eue).")
    p.add_argument("--dry-run", action="store_true",
                   help="Synthetic dataset, no Mnemo/Sonnet calls. Validates harness shape.")
    p.add_argument("--sample", type=int, default=None,
                   help="Real mode: subsample to first N questions. Override config.sample_size.")
    p.add_argument("--notes", default="",
                   help="Free text recorded in the JSON envelope's notes field.")
    return p.parse_args()


def main() -> int:
    args = parse_args()
    config = load_config(CONFIG_PATH)
    if args.sample is not None:
        config.sample_size = args.sample
    if args.dry_run:
        return run_dry(config, args.notes)
    return run_real(config, args.notes)


if __name__ == "__main__":
    sys.exit(main())
