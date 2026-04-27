#!/usr/bin/env python3
"""
assemble-evolver-prompt.py — build the full prompt for the Test-Data Evolver subagent.

Concatenates:
  1. data-evolver.md verbatim (the role + rules + output format)
  2. An "Inputs" block containing:
     - Current fixture content
     - Current expected JSON
     - Scenario state summary (passes/fails, stressors, complexity)
     - Last 3 benchmark reports for this scenario
     - Redacted reasoning_reports from recent runs
     - The gap description (mode-specific)
     - Phase doc acceptance criteria

The output is the *final text to pass to the Agent tool*. The orchestrator
(SKILL.md) is expected to take stdout from this script and pass it as the
`prompt` argument to the Agent tool with subagent_type=general-purpose.

Usage:
  assemble-evolver-prompt.py <phase> <scenario> --mode <mode> [--reports-since <ts>] [--no-reports]

Modes:
  plateau              — scenario has 3+ consecutive passes; push complexity along an axis
  reproduce-difficulty — agent reports show difficulty pattern; reproduce in fixture
  fix-malformed        — fixture has a malformed assertion; correct it (do NOT evolve)

Environment:
  PGHOST, PGPORT, PGUSER, PGDATABASE, PGPASSWORD — for collect-agent-reports.sh
"""

import argparse
import json
import os
import re
import subprocess
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

# Force UTF-8 on stdout — subagent prompts contain arrows/em-dashes; on Windows the
# default cp1252 encoder dies on those.
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

SKILL_ROOT = Path(__file__).parent.parent
SUBAGENT_PROMPT = SKILL_ROOT / "subagents" / "data-evolver.md"
SCENARIO_STATE_DIR = SKILL_ROOT / "scenario-state"
PHASES_FILE = SCENARIO_STATE_DIR / "phases.json"
COLLECT_REPORTS = SKILL_ROOT / "scripts" / "collect-agent-reports.sh"
REDACT_REPORT = SKILL_ROOT / "scripts" / "redact-report.py"
REPO_ROOT = SKILL_ROOT.parent.parent.parent  # nmemo/

VALID_MODES = {"plateau", "reproduce-difficulty", "fix-malformed"}


def load_scenario_state(phase: str, scenario: str) -> dict:
    p = SCENARIO_STATE_DIR / f"{phase}-{scenario}.json"
    if not p.exists():
        sys.exit(f"error: no scenario state at {p}")
    with open(p) as f:
        return json.load(f)


def load_phase_meta(phase: str) -> dict:
    if not PHASES_FILE.exists():
        return {}
    with open(PHASES_FILE) as f:
        data = json.load(f)
    return data.get("phases", {}).get(phase, {})


def read_text_safe(rel_or_abs: str) -> str:
    p = Path(rel_or_abs)
    if not p.is_absolute():
        p = REPO_ROOT / rel_or_abs
    if not p.exists():
        return f"<missing file: {rel_or_abs}>"
    return p.read_text(encoding="utf-8", errors="replace")


def recent_benchmark_reports(phase: str, scenario: str, n: int = 3) -> list[tuple[str, str]]:
    """Return up to n most recent benchmark reports for this scenario as [(filename, content)]."""
    bench_dir = REPO_ROOT / "platform" / "src" / "test" / "data" / f"{phase}-*"
    reports = []
    for d in REPO_ROOT.glob("platform/src/test/data/*/benchmark-reports"):
        if not d.is_dir():
            continue
        for f in sorted(d.glob(f"*-{scenario}.md"), reverse=True):
            if f.name == "TEMPLATE.md":
                continue
            reports.append((str(f.relative_to(REPO_ROOT)), f.read_text(encoding="utf-8")))
            if len(reports) >= n:
                break
        if len(reports) >= n:
            break
    return reports


def collect_redacted_reports(since_iso: str | None) -> str:
    """Pull recent reasoning_reports, redact, return JSON text. Empty string on failure."""
    if since_iso is None:
        since_iso = (datetime.now(timezone.utc) - timedelta(hours=2)).isoformat()
    try:
        # collect-agent-reports.sh outputs raw JSON array
        bash = os.environ.get("BASH_PATH", "bash")
        proc = subprocess.run(
            [bash, str(COLLECT_REPORTS), "--since", since_iso],
            capture_output=True, text=True, timeout=30,
        )
        if proc.returncode != 0:
            return f"<could not collect reports: {proc.stderr.strip()}>"
        raw = proc.stdout.strip()
        if not raw or raw == "[]":
            return "[]"
        # Pipe through redact-report.py
        red = subprocess.run(
            [sys.executable, str(REDACT_REPORT), "-"],
            input=raw, capture_output=True, text=True, timeout=15,
        )
        if red.returncode != 0:
            return f"<redaction failed: {red.stderr.strip()}>"
        return red.stdout
    except Exception as e:
        return f"<error collecting reports: {e}>"


def extract_acceptance_criteria(phase_doc_path: str) -> str:
    """Pull the 'Acceptance Criteria' section (or 'Benchmark Targets') from a phase doc."""
    p = REPO_ROOT / phase_doc_path
    if not p.exists():
        return f"<phase doc not found: {phase_doc_path}>"
    text = p.read_text(encoding="utf-8")
    # Try several common headings
    for heading in (
        r"^##\s+Acceptance Criteria",
        r"^##\s+Benchmark Targets",
        r"^##\s+Acceptance",
    ):
        m = re.search(heading, text, re.MULTILINE | re.IGNORECASE)
        if m:
            start = m.start()
            # Find next ## heading
            nxt = re.search(r"\n##\s+", text[m.end():])
            end = m.end() + nxt.start() if nxt else len(text)
            return text[start:end].strip()
    return f"<no Acceptance Criteria section found in {phase_doc_path}>"


def gap_description(state: dict, mode: str) -> str:
    scenario = state.get("scenario", "?")
    cp = state.get("consecutive_passes", 0)
    cf = state.get("consecutive_fails", 0)
    cs = state.get("complexity_score", 0)
    stressors = state.get("stressors_applied", [])
    stressors_txt = ", ".join(stressors) if stressors else "<none>"

    if mode == "plateau":
        return (
            f"Scenario `{scenario}` has plateaued: {cp} consecutive passes at complexity "
            f"score {cs}. Existing stressors: {stressors_txt}. Push complexity along ONE "
            f"new axis (scale, concurrency, adversarial-structural, adversarial-temporal, "
            f"domain-realistic, or cross-fixture). Pick the axis that is least represented "
            f"in the existing stressor list."
        )
    if mode == "reproduce-difficulty":
        return (
            f"Scenario `{scenario}` exposed a difficulty pattern in the last run "
            f"(see redacted reports). Construct a fixture that *reliably* reproduces the "
            f"pattern so the test harness can assert it. Existing stressors: {stressors_txt}. "
            f"Current complexity: {cs}."
        )
    if mode == "fix-malformed":
        return (
            f"Scenario `{scenario}` has a malformed assertion or fixture inconsistency that "
            f"causes the test to fail at setup time, not at the criterion. Correct the "
            f"fixture/expected so the criterion is what gets asserted. Do NOT add new "
            f"stressors. Current state: {cf} consecutive fails."
        )
    sys.exit(f"error: unknown mode '{mode}'")


def main():
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    ap.add_argument("phase")
    ap.add_argument("scenario")
    ap.add_argument("--mode", required=True, choices=sorted(VALID_MODES))
    ap.add_argument("--reports-since", help="ISO timestamp; default = 2h ago")
    ap.add_argument("--no-reports", action="store_true",
                    help="Skip DB report collection (for offline / unit tests)")
    args = ap.parse_args()

    state = load_scenario_state(args.phase, args.scenario)
    phase_meta = load_phase_meta(args.phase)

    fixture_text = read_text_safe(state["fixture_path"])
    expected_text = read_text_safe(state["expected_path"])

    benches = recent_benchmark_reports(args.phase, args.scenario, n=3)
    bench_block = "\n\n".join(
        f"#### {fname}\n\n```markdown\n{content}\n```"
        for fname, content in benches
    ) or "<no benchmark reports for this scenario yet>"

    if args.no_reports:
        reports_text = "<reports collection skipped>"
    else:
        reports_text = collect_redacted_reports(args.reports_since)

    criteria = extract_acceptance_criteria(phase_meta.get("phase_doc", "")) \
        if phase_meta.get("phase_doc") else "<no phase doc mapping for this phase>"

    if not SUBAGENT_PROMPT.exists():
        sys.exit(f"error: subagent prompt not found at {SUBAGENT_PROMPT}")
    role_prompt = SUBAGENT_PROMPT.read_text(encoding="utf-8")

    gap = gap_description(state, args.mode)

    # Final assembly
    prompt = f"""{role_prompt}

---

## Inputs

### Gap description
{gap}

### Phase doc acceptance criteria ({phase_meta.get("phase_doc", "<unknown>")})
{criteria}

### Scenario state summary
- Phase: `{args.phase}`
- Scenario: `{args.scenario}`
- Fixture path: `{state.get("fixture_path")}`
- Expected path: `{state.get("expected_path")}`
- Current fixture_version: `{state.get("fixture_version", "?")}`
- consecutive_passes: {state.get("consecutive_passes", 0)}
- consecutive_fails: {state.get("consecutive_fails", 0)}
- complexity_score: {state.get("complexity_score", 0)} (soft cap 100, hard cap 200)
- stressors_applied: {json.dumps(state.get("stressors_applied", []))}

### Current fixture
```sql
{fixture_text}
```

### Current expected JSON
```json
{expected_text}
```

### Recent benchmark reports (most recent first, up to 3)
{bench_block}

### Redacted agent reasoning reports (recent runs)
```json
{reports_text}
```

---

## Your task

Produce a mutation proposal in the exact format defined above (## Mutation proposal block with the five required sections). Self-audit before responding.
"""

    sys.stdout.write(prompt)


if __name__ == "__main__":
    main()
