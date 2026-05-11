#!/usr/bin/env python3
"""
guard-check.py — run guard checks against current git working tree + scenario state.

Exit codes:
  0 — within all guards
  1 — soft warning (any guard breached soft limit)
  2 — HARD CAP HIT — skill should exit cleanly

Usage:
  guard-check.py [--phase <phase>] [--scenario <scenario>] [--verbose]
"""

import argparse
import json
import re
import subprocess
import sys
from pathlib import Path

SKILL_ROOT = Path(__file__).parent.parent
REPO_ROOT = SKILL_ROOT.parent.parent.parent  # nmemo/

# Thresholds
LOC_SOFT = 500
LOC_HARD = 2000
FIXTURES_SOFT = 3
FIXTURES_HARD = 10
ITER_SOFT = 3
ITER_HARD = 5
FAIL_STREAK_HARD = 3
COMPLEXITY_SOFT = 100
COMPLEXITY_HARD = 200


def run(cmd: list[str], **kwargs) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, capture_output=True, text=True, cwd=REPO_ROOT, **kwargs)


def loc_delta() -> tuple[int, int, str]:
    """Return (added, deleted, summary_line) for uncommitted + staged changes vs HEAD."""
    p = run(["git", "diff", "HEAD", "--shortstat"])
    if p.returncode != 0 or not p.stdout.strip():
        return (0, 0, "")
    # Format: " N files changed, M insertions(+), K deletions(-)"
    line = p.stdout.strip()
    m_ins = re.search(r"(\d+) insertion", line)
    m_del = re.search(r"(\d+) deletion", line)
    added = int(m_ins.group(1)) if m_ins else 0
    deleted = int(m_del.group(1)) if m_del else 0
    return (added, deleted, line)


def new_fixtures_count() -> tuple[int, list[str]]:
    """Count newly-added fixture files under platform/src/test/data/."""
    p = run(["git", "status", "--porcelain", "platform/src/test/data/"])
    if p.returncode != 0:
        return (0, [])
    files = []
    for line in p.stdout.splitlines():
        if line.startswith("?? ") or line.startswith("A  "):
            path = line[3:]
            if path.endswith(".sql"):
                files.append(path)
    return (len(files), files)


def fixture_complexity(path: Path) -> int:
    """Estimate fixture complexity from SQL file.

    Score = row_insert_count + edge_insert_count*2 + stressor_count*10
    """
    if not path.exists():
        return 0
    content = path.read_text(encoding="utf-8", errors="ignore")
    # Count INSERTs
    insert_matches = re.findall(r"INSERT INTO public\.(\w+)", content, re.IGNORECASE)
    rows = 0
    edges = 0
    for tbl in insert_matches:
        if tbl in ("causal_edges", "edge_source_refs"):
            edges += 1
        else:
            rows += 1
    stressors = len(re.findall(r"--\s*STRESSOR:", content))
    # VALUES block row counts (crude — count commas at top level of VALUES)
    values_blocks = re.findall(r"VALUES\s*(\(.*?\));", content, re.DOTALL)
    value_rows = sum(v.count("),") + 1 for v in values_blocks)
    return value_rows + edges * 2 + stressors * 10


def check_scenario_state(phase: str, scenario: str) -> dict:
    state_path = SKILL_ROOT / "scenario-state" / f"{phase}-{scenario}.json"
    if not state_path.exists():
        return {}
    with open(state_path) as f:
        return json.load(f)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--phase")
    ap.add_argument("--scenario")
    ap.add_argument("--verbose", action="store_true")
    args = ap.parse_args()

    results = []
    worst = 0  # 0=ok, 1=soft, 2=hard

    # 1. LoC delta
    added, deleted, _ = loc_delta()
    if added >= LOC_HARD:
        worst = max(worst, 2)
        results.append(("HARD", "loc", added, LOC_HARD, "LoC added exceeds hard cap"))
    elif added >= LOC_SOFT:
        worst = max(worst, 1)
        results.append(("SOFT", "loc", added, LOC_SOFT, "LoC added exceeds soft limit"))
    else:
        results.append(("OK", "loc", added, LOC_SOFT, ""))

    # 2. New fixtures
    n_fix, fix_files = new_fixtures_count()
    if n_fix >= FIXTURES_HARD:
        worst = max(worst, 2)
        results.append(("HARD", "fixtures", n_fix, FIXTURES_HARD, f"{n_fix} new fixtures"))
    elif n_fix >= FIXTURES_SOFT:
        worst = max(worst, 1)
        results.append(("SOFT", "fixtures", n_fix, FIXTURES_SOFT, f"{n_fix} new fixtures"))
    else:
        results.append(("OK", "fixtures", n_fix, FIXTURES_SOFT, ""))

    # 3. Scenario state (consecutive fails + complexity)
    if args.phase and args.scenario:
        state = check_scenario_state(args.phase, args.scenario)
        cfail = state.get("consecutive_fails", 0)
        cscore = state.get("complexity_score", 0)
        if cfail >= FAIL_STREAK_HARD:
            worst = max(worst, 2)
            results.append(("HARD", "fail_streak", cfail, FAIL_STREAK_HARD, "park scenario"))
        else:
            results.append(("OK", "fail_streak", cfail, FAIL_STREAK_HARD, ""))

        if cscore >= COMPLEXITY_HARD:
            worst = max(worst, 2)
            results.append(("HARD", "complexity", cscore, COMPLEXITY_HARD, "graduate or stop"))
        elif cscore >= COMPLEXITY_SOFT:
            worst = max(worst, 1)
            results.append(("SOFT", "complexity", cscore, COMPLEXITY_SOFT, ""))
        else:
            results.append(("OK", "complexity", cscore, COMPLEXITY_SOFT, ""))

    # Print result
    if args.verbose or worst > 0:
        print(f"{'STATUS':<6} {'CHECK':<14} {'VALUE':<10} {'LIMIT':<10} NOTE")
        for status, check, value, limit, note in results:
            print(f"{status:<6} {check:<14} {value:<10} {limit:<10} {note}")

    sys.exit(worst)


if __name__ == "__main__":
    main()
