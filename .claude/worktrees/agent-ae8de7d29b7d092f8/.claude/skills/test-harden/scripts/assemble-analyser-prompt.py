#!/usr/bin/env python3
"""
assemble-analyser-prompt.py — build the full prompt for the Code Analyser subagent.

Concatenates:
  1. code-analyser.md verbatim
  2. An "Inputs" block:
     - Failure output (vitest stdout from run-scenario.sh's last-run.log)
     - Implicated source files (parsed from stack trace, contents inlined)
     - Reasoning_reports from the run (NOT redacted — Code Analyser gets full detail)
     - Phase doc acceptance criteria for this scenario
     - Recent git log of the implicated files

Usage:
  assemble-analyser-prompt.py <phase> <scenario> [--failure-log <path>] [--reports-since <ts>]
                                                 [--no-reports] [--max-source-lines N]

Defaults:
  --failure-log = scenario-state/<phase>-<scenario>.last-run.log (run-scenario.sh's output)
"""

import argparse
import json
import os
import re
import subprocess
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

SKILL_ROOT = Path(__file__).parent.parent
SUBAGENT_PROMPT = SKILL_ROOT / "subagents" / "code-analyser.md"
SCENARIO_STATE_DIR = SKILL_ROOT / "scenario-state"
PHASES_FILE = SCENARIO_STATE_DIR / "phases.json"
COLLECT_REPORTS = SKILL_ROOT / "scripts" / "collect-agent-reports.sh"
REPO_ROOT = SKILL_ROOT.parent.parent.parent

STACK_FRAME_RE = re.compile(
    r"(?:at\s+\S+\s+\(|\bat\s+|\s+at\s+|FAIL\s+|❯\s+)"
    r"((?:[A-Za-z]:[/\\])?(?:platform|ml-services|src)[/\\][\w\-./\\]+\.(?:ts|js|tsx|py))"
    r"(?::(\d+):(\d+))?",
    re.IGNORECASE,
)
SIMPLE_PATH_RE = re.compile(
    r"((?:platform|ml-services|src)[/\\][\w\-./\\]+\.(?:ts|js|tsx|py))(?::(\d+):(\d+))?",
    re.IGNORECASE,
)


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


def implicated_source_files(failure_log: str, exclude_test_files: bool = True) -> list[tuple[str, int | None]]:
    """Return (path, line_number_or_None) for each unique file referenced in the failure log."""
    seen: set[str] = set()
    out: list[tuple[str, int | None]] = []
    for m in SIMPLE_PATH_RE.finditer(failure_log):
        p = m.group(1).replace("\\", "/")
        line = int(m.group(2)) if m.group(2) else None
        if p in seen:
            continue
        seen.add(p)
        if exclude_test_files and ("/test/" in p or p.endswith(".test.ts") or p.endswith(".test.js")):
            continue
        out.append((p, line))
    return out


def read_source_excerpt(rel_path: str, line: int | None, max_lines: int) -> str:
    """Read up to max_lines around the implicated line. Whole file if no line and small enough."""
    p = REPO_ROOT / rel_path
    if not p.exists():
        return f"<missing file: {rel_path}>"
    text = p.read_text(encoding="utf-8", errors="replace")
    lines = text.splitlines()
    if line is None or len(lines) <= max_lines:
        if len(lines) > max_lines:
            return "\n".join(lines[:max_lines]) + f"\n... (truncated, {len(lines)} lines total)"
        return text
    half = max_lines // 2
    start = max(0, line - 1 - half)
    end = min(len(lines), start + max_lines)
    excerpt = "\n".join(
        f"{i+1:>5}  {lines[i]}" for i in range(start, end)
    )
    return f"<excerpt around line {line} ({start+1}..{end}/{len(lines)})>\n{excerpt}"


def collect_reports(since_iso: str | None) -> str:
    if since_iso is None:
        since_iso = (datetime.now(timezone.utc) - timedelta(hours=2)).isoformat()
    try:
        bash = os.environ.get("BASH_PATH", "bash")
        proc = subprocess.run(
            [bash, str(COLLECT_REPORTS), "--since", since_iso],
            capture_output=True, text=True, timeout=30,
        )
        if proc.returncode != 0:
            return f"<could not collect reports: {proc.stderr.strip()}>"
        return proc.stdout.strip() or "[]"
    except Exception as e:
        return f"<error: {e}>"


def extract_acceptance_criteria(phase_doc_path: str) -> str:
    p = REPO_ROOT / phase_doc_path
    if not p.exists():
        return f"<phase doc not found: {phase_doc_path}>"
    text = p.read_text(encoding="utf-8")
    for heading in (
        r"^##\s+Acceptance Criteria",
        r"^##\s+Benchmark Targets",
        r"^##\s+Acceptance",
    ):
        m = re.search(heading, text, re.MULTILINE | re.IGNORECASE)
        if m:
            start = m.start()
            nxt = re.search(r"\n##\s+", text[m.end():])
            end = m.end() + nxt.start() if nxt else len(text)
            return text[start:end].strip()
    return f"<no Acceptance Criteria section found in {phase_doc_path}>"


def git_log_for(rel_path: str, n: int = 5) -> str:
    try:
        proc = subprocess.run(
            ["git", "log", f"--max-count={n}", "--pretty=format:%h %ad %s", "--date=short",
             "--", rel_path],
            capture_output=True, text=True, cwd=REPO_ROOT, timeout=15,
        )
        if proc.returncode != 0:
            return ""
        return proc.stdout.strip() or "<no git history found>"
    except Exception:
        return ""


def main():
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    ap.add_argument("phase")
    ap.add_argument("scenario")
    ap.add_argument("--failure-log", help="Path to vitest output log")
    ap.add_argument("--reports-since", help="ISO timestamp for report window")
    ap.add_argument("--no-reports", action="store_true")
    ap.add_argument("--max-source-lines", type=int, default=200,
                    help="Cap on lines included per source file (default 200)")
    args = ap.parse_args()

    state = load_scenario_state(args.phase, args.scenario)
    phase_meta = load_phase_meta(args.phase)

    if args.failure_log:
        log_path = Path(args.failure_log)
    else:
        log_path = SCENARIO_STATE_DIR / f"{args.phase}-{args.scenario}.last-run.log"

    if not log_path.exists():
        sys.exit(f"error: failure log not found at {log_path} — run run-scenario.sh first")

    failure_log = log_path.read_text(encoding="utf-8", errors="replace")

    sources = implicated_source_files(failure_log)
    sources_block = []
    for (p, line) in sources[:5]:
        excerpt = read_source_excerpt(p, line, args.max_source_lines)
        glog = git_log_for(p)
        sources_block.append(
            f"#### `{p}`{' (around line ' + str(line) + ')' if line else ''}\n\n"
            f"Recent git log:\n```\n{glog}\n```\n\n"
            f"```{Path(p).suffix.lstrip('.') or 'text'}\n{excerpt}\n```"
        )
    sources_text = "\n\n".join(sources_block) or "<no production source files identified in stack trace>"

    if args.no_reports:
        reports_text = "<reports collection skipped>"
    else:
        reports_text = collect_reports(args.reports_since)

    criteria = extract_acceptance_criteria(phase_meta.get("phase_doc", "")) \
        if phase_meta.get("phase_doc") else "<no phase doc mapping>"

    if not SUBAGENT_PROMPT.exists():
        sys.exit(f"error: subagent prompt not found at {SUBAGENT_PROMPT}")
    role_prompt = SUBAGENT_PROMPT.read_text(encoding="utf-8")

    prompt = f"""{role_prompt}

---

## Inputs

### Phase doc acceptance criteria ({phase_meta.get("phase_doc", "<unknown>")})
{criteria}

### Scenario
- Phase: `{args.phase}`
- Scenario: `{args.scenario}`
- Test file: `{state.get("test_file")}`
- consecutive_fails: {state.get("consecutive_fails", 0)}

### Failure output (from vitest)
```
{failure_log}
```

### Implicated source files
{sources_text}

### Agent reasoning reports (NOT redacted)
```json
{reports_text}
```

---

## Your task

Produce a Failure analysis in the exact format defined above (Classification / Confidence / Affected / Root cause hypothesis / Evidence / Suggested fix direction / Bead issue text). Self-audit before responding.
"""

    sys.stdout.write(prompt)


if __name__ == "__main__":
    main()
