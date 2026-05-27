"""Centralised config for the benchmark harness.

Single source of truth for model ids, platform URLs, and result paths. Each
benchmark's own config.yaml overrides only what it needs (cut name, dataset
path, anything benchmark-specific).
"""

from __future__ import annotations

import os
from pathlib import Path

from dotenv import load_dotenv

load_dotenv()

# Platform endpoint. Override with MNEMO_PLATFORM_URL.
PLATFORM_BASE_URL = os.environ.get("MNEMO_PLATFORM_URL", "http://localhost:3000")

# Model ids. The model_under_test is what Mnemo ships with (per haiku-first
# policy in feedback_haiku_first). The judge model is what scores LLM-as-judge
# evals — needs to be capable enough that judge variance doesn't dominate.
MODEL_UNDER_TEST = os.environ.get("MNEMO_BENCH_MODEL", "claude-haiku-4-5-20251001")
JUDGE_MODEL = os.environ.get("MNEMO_BENCH_JUDGE", "claude-sonnet-4-6")

# Paths. Resolved relative to the repo root (the parent of /benchmarks/).
BENCHMARKS_ROOT = Path(__file__).resolve().parent.parent
REPO_ROOT = BENCHMARKS_ROOT.parent
RESULTS_DIR = BENCHMARKS_ROOT / "results"
DOCS_RESULTS_DIR = REPO_ROOT / "docs" / "benchmarks" / "results"

# HTTP client defaults. Reasoning agent queries can take minutes; pick a
# generous timeout so a benchmark doesn't fail mid-run.
HTTP_TIMEOUT_SECONDS = float(os.environ.get("MNEMO_BENCH_HTTP_TIMEOUT", "300"))

# Anthropic API key for the judge. Read lazily so missing-key doesn't fail
# imports; the judge module raises a clear error if absent at call time.
ANTHROPIC_API_KEY = os.environ.get("ANTHROPIC_API_KEY")
