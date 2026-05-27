"""Results envelope writer + markdown regenerator.

One module owns both the JSON write and the markdown regeneration so they
stay in sync. After every benchmark run:

    write_run(...)            # writes one JSON
    regenerate_markdown(name) # rewrites docs/benchmarks/results/{name}.md
    regenerate_dashboard()    # rewrites docs/benchmarks/results/README.md

The JSON envelope schema is locked in docs/benchmarks/plan.md §1.4.
"""

from __future__ import annotations

import json
import subprocess
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from _common.config import DOCS_RESULTS_DIR, REPO_ROOT, RESULTS_DIR


@dataclass
class RunEnvelope:
    """The JSON envelope every benchmark run produces. Schema from plan.md §1.4."""

    benchmark: str
    cut: str
    mnemo_git_sha: str
    harness_commit: str
    config_path: str
    model_under_test: str
    judge_model: str
    timestamp: str
    dataset_size: int
    scores: dict[str, Any]
    notes: str = ""
    judge_prompt_version: str = ""

    def filename(self) -> str:
        date = self.timestamp.split("T")[0]
        sha7 = self.mnemo_git_sha[:7] if self.mnemo_git_sha else "unknown"
        return f"{date}-{sha7}.json"


def current_git_sha(repo: Path = REPO_ROOT) -> str:
    try:
        result = subprocess.run(
            ["git", "-C", str(repo), "rev-parse", "HEAD"],
            capture_output=True,
            text=True,
            check=True,
        )
        return result.stdout.strip()
    except (subprocess.CalledProcessError, FileNotFoundError):
        return "unknown"


def submodule_sha(path: Path) -> str:
    """Return the submodule's pinned commit, or 'unknown' if not a submodule."""
    try:
        result = subprocess.run(
            ["git", "-C", str(path), "rev-parse", "HEAD"],
            capture_output=True,
            text=True,
            check=True,
        )
        return result.stdout.strip()
    except (subprocess.CalledProcessError, FileNotFoundError):
        return "unknown"


def write_run(
    benchmark: str,
    cut: str,
    config_path: str,
    model_under_test: str,
    judge_model: str,
    dataset_size: int,
    scores: dict[str, Any],
    notes: str = "",
    harness_commit: str = "unknown",
    judge_prompt_version: str = "",
    timestamp: str | None = None,
) -> Path:
    """Write the JSON envelope under results/{benchmark}/runs/{file}.json.

    Returns the path written. mnemo_git_sha and timestamp are auto-filled
    from the current repo state and clock.
    """
    if timestamp is None:
        timestamp = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

    envelope = RunEnvelope(
        benchmark=benchmark,
        cut=cut,
        mnemo_git_sha=current_git_sha(),
        harness_commit=harness_commit,
        config_path=config_path,
        model_under_test=model_under_test,
        judge_model=judge_model,
        timestamp=timestamp,
        dataset_size=dataset_size,
        scores=scores,
        notes=notes,
        judge_prompt_version=judge_prompt_version,
    )

    target_dir = RESULTS_DIR / benchmark / "runs"
    target_dir.mkdir(parents=True, exist_ok=True)
    target = target_dir / envelope.filename()
    target.write_text(json.dumps(asdict(envelope), indent=2), encoding="utf-8")
    return target


def _load_runs(benchmark: str) -> list[dict[str, Any]]:
    runs_dir = RESULTS_DIR / benchmark / "runs"
    if not runs_dir.exists():
        return []
    runs: list[dict[str, Any]] = []
    for path in sorted(runs_dir.glob("*.json")):
        try:
            runs.append(json.loads(path.read_text(encoding="utf-8")))
        except json.JSONDecodeError:
            continue
    runs.sort(key=lambda r: r.get("timestamp", ""), reverse=True)
    return runs


def _format_score_summary(scores: dict[str, Any]) -> str:
    """Flatten the benchmark-specific scores dict into a "k=v, k=v" string."""
    pieces: list[str] = []
    for key, value in scores.items():
        if isinstance(value, (int, float)):
            pieces.append(f"{key}={value:.3f}" if isinstance(value, float) else f"{key}={value}")
        elif isinstance(value, dict):
            pieces.append(f"{key}=<dict>")
        else:
            pieces.append(f"{key}={value}")
    return ", ".join(pieces)


def regenerate_markdown(benchmark: str) -> Path:
    """Rewrite docs/benchmarks/results/{benchmark}.md with the trend table."""
    runs = _load_runs(benchmark)
    DOCS_RESULTS_DIR.mkdir(parents=True, exist_ok=True)
    target = DOCS_RESULTS_DIR / f"{benchmark}.md"

    if not runs:
        target.write_text(
            f"# {benchmark} — results\n\n"
            "_No runs yet. Run the benchmark to populate this page._\n",
            encoding="utf-8",
        )
        return target

    lines: list[str] = [f"# {benchmark} — results", ""]
    lines.append(
        "Trend table; latest run first. JSON envelopes live in "
        f"`/benchmarks/results/{benchmark}/runs/`. Schema in "
        "[`docs/benchmarks/plan.md`](../plan.md) §1.4."
    )
    lines.append("")
    lines.append("| Date | Mnemo SHA | Cut | Model | Judge | N | Scores | Notes |")
    lines.append("|------|-----------|-----|-------|-------|---|--------|-------|")
    for run in runs:
        date = run.get("timestamp", "").split("T")[0]
        sha = (run.get("mnemo_git_sha") or "?")[:7]
        cut = run.get("cut", "?")
        model = run.get("model_under_test", "?")
        judge = run.get("judge_model", "?")
        size = run.get("dataset_size", "?")
        scores = _format_score_summary(run.get("scores", {}))
        notes = (run.get("notes", "") or "").replace("\n", " ").replace("|", "\\|")
        if len(notes) > 80:
            notes = notes[:77] + "..."
        lines.append(f"| {date} | {sha} | {cut} | {model} | {judge} | {size} | {scores} | {notes} |")

    target.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return target


def regenerate_dashboard() -> Path:
    """Rewrite docs/benchmarks/results/README.md with one row per benchmark.

    Pulls the latest run for each benchmark that has any runs at all. Quiet
    on benchmarks with no runs yet — they just don't appear.
    """
    DOCS_RESULTS_DIR.mkdir(parents=True, exist_ok=True)
    target = DOCS_RESULTS_DIR / "README.md"

    # Discover all benchmark dirs that have runs.
    benchmarks: list[str] = []
    if RESULTS_DIR.exists():
        for child in sorted(RESULTS_DIR.iterdir()):
            if child.is_dir() and (child / "runs").exists():
                benchmarks.append(child.name)

    lines: list[str] = [
        "# Mnemo benchmark dashboard",
        "",
        "Cross-benchmark snapshot. One row per benchmark, latest run only. "
        "See per-benchmark `.md` files for trend history; see "
        "[`docs/benchmarks/plan.md`](../plan.md) for the contract.",
        "",
    ]

    if not benchmarks:
        lines.append("_No benchmark runs yet._")
        target.write_text("\n".join(lines) + "\n", encoding="utf-8")
        return target

    lines.append("| Benchmark | Date | Mnemo SHA | Cut | N | Scores | Notes |")
    lines.append("|-----------|------|-----------|-----|---|--------|-------|")
    for benchmark in benchmarks:
        runs = _load_runs(benchmark)
        if not runs:
            continue
        latest = runs[0]
        date = latest.get("timestamp", "").split("T")[0]
        sha = (latest.get("mnemo_git_sha") or "?")[:7]
        cut = latest.get("cut", "?")
        size = latest.get("dataset_size", "?")
        scores = _format_score_summary(latest.get("scores", {}))
        notes = (latest.get("notes", "") or "").replace("\n", " ").replace("|", "\\|")
        if len(notes) > 60:
            notes = notes[:57] + "..."
        lines.append(
            f"| [{benchmark}]({benchmark}.md) | {date} | {sha} | {cut} | {size} | {scores} | {notes} |"
        )

    target.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return target
