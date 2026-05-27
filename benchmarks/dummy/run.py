"""Self-test for the _common harness pipeline.

Produces one JSON envelope with synthetic scores, then regenerates the
markdown summary + cross-benchmark dashboard. Verifies that the whole
write+regen path is wired correctly before any real benchmark exists.

Per nmemo-ko0 acceptance criterion: "a dummy benchmark stub produces a
valid JSON envelope and the dashboard regenerator handles it correctly."
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import yaml

# Allow `python -m dummy.run` and `python dummy/run.py` from /benchmarks/ root.
if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from _common.config import JUDGE_MODEL, MODEL_UNDER_TEST  # noqa: E402
from _common.results import (  # noqa: E402
    regenerate_dashboard,
    regenerate_markdown,
    write_run,
)


def main() -> int:
    config_path = Path(__file__).parent / "config.yaml"
    config = yaml.safe_load(config_path.read_text(encoding="utf-8"))

    # Synthetic scores — three made-up categories so we exercise the
    # score-summary formatter without calling Sonnet or the platform.
    synthetic_scores = {
        "overall": 0.42,
        "category_a": 0.33,
        "category_b": 0.51,
        "items_correct": 1,
        "items_total": int(config["dataset_size"]),
    }

    json_path = write_run(
        benchmark=config["benchmark"],
        cut=config["cut"],
        config_path=config_path.relative_to(config_path.parent.parent.parent).as_posix(),
        model_under_test=MODEL_UNDER_TEST,
        judge_model=JUDGE_MODEL,
        dataset_size=int(config["dataset_size"]),
        scores=synthetic_scores,
        notes="Self-test for nmemo-ko0. Synthetic scores; no real benchmark or platform calls.",
    )

    md_path = regenerate_markdown(config["benchmark"])
    dashboard_path = regenerate_dashboard()

    # Sanity-check the JSON is well-formed and the envelope contains the
    # required fields. A silent malformed write would defeat the point of
    # this self-test.
    written = json.loads(json_path.read_text(encoding="utf-8"))
    required = {
        "benchmark",
        "cut",
        "mnemo_git_sha",
        "config_path",
        "model_under_test",
        "judge_model",
        "timestamp",
        "dataset_size",
        "scores",
    }
    missing = required - set(written.keys())
    if missing:
        print(f"FAIL: envelope missing required fields: {missing}", file=sys.stderr)
        return 1

    print(f"OK json:      {json_path}")
    print(f"OK markdown:  {md_path}")
    print(f"OK dashboard: {dashboard_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
