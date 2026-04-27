#!/usr/bin/env python3
"""
file-bead-from-analyser.py — parse Code Analyser output and file a bead via `bd create`.

Parses the markdown the subagent returns, validates required sections, looks up the parent
bead from phases.json, and runs `bd create --parent <parent-bead> --title=... --type=... --priority=... --description=...`.

The filed bead ID is captured from `bd` output and appended to scenario-state's
`filed_beads` array so the orchestrator has provenance.

Output format expected (see subagents/code-analyser.md):

    ## Failure analysis

    **Classification:** <code-bug | test-bug | flaky | environment | regression>
    **Confidence:** <high | medium | low>
    **Affected:** `<file:line>` in function `<name>`

    ### Root cause hypothesis
    <paragraph>

    ### Evidence
    - ...

    ### Suggested fix direction
    <paragraph>

    ### Bead issue text
    ```
    Title: [code-bug] <area>: <symptom>
    Type: bug
    Priority: <0-4>
    Description:
    <multi-paragraph description, may include further markdown headings>
    ```

Usage:
  file-bead-from-analyser.py <phase> <scenario> [--input <file>|-] [--dry-run]
                             [--bd-path <path>] [--skip-non-code-bugs]
"""

import argparse
import json
import os
import re
import subprocess
import sys
from pathlib import Path

SKILL_ROOT = Path(__file__).parent.parent
SCENARIO_STATE_DIR = SKILL_ROOT / "scenario-state"
PHASES_FILE = SCENARIO_STATE_DIR / "phases.json"
REPO_ROOT = SKILL_ROOT.parent.parent.parent

VALID_CLASSIFICATIONS = {
    "code-bug", "test-bug", "flaky", "environment", "regression", "external-service",
}
VALID_TYPES = {"bug", "task", "feature", "epic", "chore"}
VALID_PRIORITIES = {"0", "1", "2", "3", "4"}
DEFAULT_BD = os.environ.get(
    "BD_PATH", "C:/Users/bruce.mckay/AppData/Local/Programs/bd/bd.exe",
)


def parse_analyser_markdown(md: str) -> dict:
    out: dict = {"raw": md}

    classification_match = re.search(
        r"\*\*Classification:\*\*\s*(.+?)\s*$", md, re.MULTILINE,
    )
    if not classification_match:
        raise ValueError("missing **Classification:** field")
    out["classification"] = classification_match.group(1).strip().lower()

    conf_match = re.search(r"\*\*Confidence:\*\*\s*(.+?)\s*$", md, re.MULTILINE)
    out["confidence"] = conf_match.group(1).strip().lower() if conf_match else "unknown"

    affected_match = re.search(r"\*\*Affected:\*\*\s*(.+?)\s*$", md, re.MULTILINE)
    out["affected"] = affected_match.group(1).strip() if affected_match else ""

    rch = re.search(
        r"###\s+Root cause hypothesis\s*\n+(.*?)(?=\n###\s|\Z)",
        md, re.DOTALL | re.IGNORECASE,
    )
    out["root_cause"] = rch.group(1).strip() if rch else ""

    ev = re.search(
        r"###\s+Evidence\s*\n+(.*?)(?=\n###\s|\Z)",
        md, re.DOTALL | re.IGNORECASE,
    )
    out["evidence"] = ev.group(1).strip() if ev else ""

    sf = re.search(
        r"###\s+Suggested fix direction\s*\n+(.*?)(?=\n###\s|\Z)",
        md, re.DOTALL | re.IGNORECASE,
    )
    out["suggested_fix"] = sf.group(1).strip() if sf else ""

    # Bead issue text — fenced block (any fence) following "### Bead issue text"
    bead_match = re.search(
        r"###\s+Bead issue text\s*\n+```[\w-]*\s*\n(.*?)\n```",
        md, re.DOTALL | re.IGNORECASE,
    )
    if not bead_match:
        raise ValueError("missing ### Bead issue text fenced block")
    bead_block = bead_match.group(1)

    title_m = re.search(r"^Title:\s*(.+?)\s*$", bead_block, re.MULTILINE)
    type_m = re.search(r"^Type:\s*(.+?)\s*$", bead_block, re.MULTILINE)
    prio_m = re.search(r"^Priority:\s*(.+?)\s*$", bead_block, re.MULTILINE)
    desc_m = re.search(
        r"^Description:\s*\n(.+)$", bead_block, re.DOTALL | re.MULTILINE,
    )

    if not title_m:
        raise ValueError("bead block missing 'Title:' line")
    if not type_m:
        raise ValueError("bead block missing 'Type:' line")
    if not prio_m:
        raise ValueError("bead block missing 'Priority:' line")
    if not desc_m:
        raise ValueError("bead block missing 'Description:' section")

    out["title"] = title_m.group(1).strip()
    out["type"] = type_m.group(1).strip().lower()
    out["priority"] = prio_m.group(1).strip()
    out["description"] = desc_m.group(1).strip()

    return out


def validate(parsed: dict) -> list[str]:
    errors: list[str] = []
    if parsed["classification"] not in VALID_CLASSIFICATIONS:
        errors.append(
            f"classification '{parsed['classification']}' not in "
            f"{sorted(VALID_CLASSIFICATIONS)}"
        )
    if parsed["type"] not in VALID_TYPES:
        errors.append(f"type '{parsed['type']}' not in {sorted(VALID_TYPES)}")
    if parsed["priority"] not in VALID_PRIORITIES:
        errors.append(
            f"priority '{parsed['priority']}' not in {sorted(VALID_PRIORITIES)}"
        )
    if not parsed["title"]:
        errors.append("title is empty")
    if not parsed["description"] or len(parsed["description"]) < 30:
        errors.append("description is empty or too short (<30 chars)")
    if not parsed["root_cause"]:
        errors.append("root cause hypothesis is empty")
    return errors


def load_phase_meta(phase: str) -> dict:
    if not PHASES_FILE.exists():
        return {}
    with open(PHASES_FILE) as f:
        data = json.load(f)
    return data.get("phases", {}).get(phase, {})


def file_bead(parsed: dict, parent_bead: str, bd_path: str) -> str:
    """Run bd create. Return the new bead's ID (parsed from output)."""
    cmd = [
        bd_path, "create",
        "--title", parsed["title"],
        "--type", parsed["type"],
        "--priority", parsed["priority"],
        "--parent", parent_bead,
        "--description", parsed["description"],
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
    if proc.returncode != 0:
        raise RuntimeError(
            f"bd create failed (exit {proc.returncode}):\nSTDERR: {proc.stderr}\n"
            f"STDOUT: {proc.stdout}"
        )
    # bd typically prints "Created issue <id>: <title>" or similar — parse the ID
    bd_id_match = re.search(r"\b([a-z0-9]+-[a-z0-9]+(?:\.\d+)*)\b", proc.stdout)
    if not bd_id_match:
        raise RuntimeError(f"could not parse bead ID from bd output:\n{proc.stdout}")
    return bd_id_match.group(1)


def append_filed_bead_to_state(phase: str, scenario: str, bead_id: str,
                               classification: str) -> None:
    state_path = SCENARIO_STATE_DIR / f"{phase}-{scenario}.json"
    if not state_path.exists():
        return
    with open(state_path) as f:
        state = json.load(f)
    filed = state.get("filed_beads", [])
    filed.append({"id": bead_id, "classification": classification})
    state["filed_beads"] = filed
    tmp = state_path.with_suffix(".json.tmp")
    with open(tmp, "w") as f:
        json.dump(state, f, indent=2)
    tmp.replace(state_path)


def main():
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    ap.add_argument("phase")
    ap.add_argument("scenario")
    ap.add_argument("--input", default="-")
    ap.add_argument("--dry-run", action="store_true",
                    help="Validate + show planned bd create cmd without running it")
    ap.add_argument("--bd-path", default=DEFAULT_BD)
    ap.add_argument("--skip-non-code-bugs", action="store_true",
                    help="Only file beads when classification == code-bug or regression")
    args = ap.parse_args()

    if args.input == "-":
        md = sys.stdin.read()
    else:
        md = Path(args.input).read_text(encoding="utf-8")

    if not md.strip():
        sys.exit("error: empty input")

    try:
        parsed = parse_analyser_markdown(md)
    except ValueError as e:
        sys.exit(f"parse error: {e}")

    errors = validate(parsed)
    if errors:
        for err in errors:
            sys.stderr.write(f"validation error: {err}\n")
        sys.exit(1)

    if args.skip_non_code_bugs and parsed["classification"] not in {"code-bug", "regression"}:
        report = {
            "skipped": True,
            "reason": f"classification '{parsed['classification']}' is not code-bug/regression",
            "phase": args.phase,
            "scenario": args.scenario,
        }
        print(json.dumps(report, indent=2))
        return

    phase_meta = load_phase_meta(args.phase)
    parent_bead = phase_meta.get("parent_bead")
    if not parent_bead:
        sys.exit(f"error: no parent_bead mapping for phase '{args.phase}' in phases.json")

    if args.dry_run:
        report = {
            "phase": args.phase,
            "scenario": args.scenario,
            "parent_bead": parent_bead,
            "title": parsed["title"],
            "type": parsed["type"],
            "priority": parsed["priority"],
            "classification": parsed["classification"],
            "confidence": parsed["confidence"],
            "affected": parsed["affected"],
            "description_chars": len(parsed["description"]),
            "would_run": [
                args.bd_path, "create",
                "--title", parsed["title"],
                "--type", parsed["type"],
                "--priority", parsed["priority"],
                "--parent", parent_bead,
                "--description", "<...>",
            ],
        }
        print(json.dumps(report, indent=2))
        return

    try:
        bead_id = file_bead(parsed, parent_bead, args.bd_path)
    except RuntimeError as e:
        sys.exit(f"file error: {e}")

    append_filed_bead_to_state(args.phase, args.scenario, bead_id, parsed["classification"])

    print(json.dumps({
        "filed": True,
        "bead_id": bead_id,
        "parent_bead": parent_bead,
        "phase": args.phase,
        "scenario": args.scenario,
        "title": parsed["title"],
        "classification": parsed["classification"],
    }, indent=2))


if __name__ == "__main__":
    main()
