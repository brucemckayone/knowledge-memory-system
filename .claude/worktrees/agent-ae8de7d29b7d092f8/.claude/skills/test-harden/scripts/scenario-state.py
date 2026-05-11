#!/usr/bin/env python3
"""
scenario-state.py — read/write test-harden scenario state JSON.

Usage:
  scenario-state.py get <phase> <scenario>                  # print state JSON, exit 0 (or 1 if missing)
  scenario-state.py init <phase> <scenario> <fixture_path> <expected_path> <test_file>
  scenario-state.py update <phase> <scenario> <field> <value>
  scenario-state.py record-result <phase> <scenario> <pass|fail|flaky>
  scenario-state.py list-ready                              # list scenarios with status=active + not parked
  scenario-state.py summary                                 # per-status counts
"""

import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

SKILL_ROOT = Path(__file__).parent.parent
STATE_DIR = SKILL_ROOT / "scenario-state"
TEMPLATE_PATH = STATE_DIR / "TEMPLATE.json"


def state_path(phase: str, scenario: str) -> Path:
    return STATE_DIR / f"{phase}-{scenario}.json"


def load_template() -> dict:
    with open(TEMPLATE_PATH) as f:
        return json.load(f)


def load_state(phase: str, scenario: str) -> dict | None:
    p = state_path(phase, scenario)
    if not p.exists():
        return None
    with open(p) as f:
        return json.load(f)


def save_state(phase: str, scenario: str, state: dict) -> None:
    p = state_path(phase, scenario)
    tmp = p.with_suffix(".json.tmp")
    with open(tmp, "w") as f:
        json.dump(state, f, indent=2)
    tmp.replace(p)


def init_scenario(phase: str, scenario: str, fixture: str, expected: str, test_file: str) -> dict:
    tpl = load_template()
    tpl["phase"] = phase
    tpl["scenario"] = scenario
    tpl["fixture_path"] = fixture
    tpl["expected_path"] = expected
    tpl["test_file"] = test_file
    tpl["last_run"] = None
    tpl["notes"] = f"Initialised {datetime.now(timezone.utc).isoformat()}"
    save_state(phase, scenario, tpl)
    return tpl


def record_result(phase: str, scenario: str, result: str) -> dict:
    state = load_state(phase, scenario)
    if state is None:
        raise FileNotFoundError(f"No state for {phase}/{scenario} — call init first")

    now = datetime.now(timezone.utc).isoformat()
    state["last_run"] = now
    state["last_result"] = result
    state["total_runs"] = state.get("total_runs", 0) + 1

    if result == "pass":
        state["consecutive_passes"] = state.get("consecutive_passes", 0) + 1
        state["consecutive_fails"] = 0
    elif result == "fail":
        state["consecutive_fails"] = state.get("consecutive_fails", 0) + 1
        state["consecutive_passes"] = 0
        if state["consecutive_fails"] >= 3:
            state["status"] = "parked"
    elif result == "flaky":
        # Don't reset counters on flaky — re-run decision handled by orchestrator
        pass

    save_state(phase, scenario, state)
    return state


def update_field(phase: str, scenario: str, field: str, value: str) -> dict:
    state = load_state(phase, scenario)
    if state is None:
        raise FileNotFoundError(f"No state for {phase}/{scenario}")
    # Support dotted path for nested fields
    parts = field.split(".")
    cursor = state
    for p in parts[:-1]:
        if p not in cursor or not isinstance(cursor[p], dict):
            cursor[p] = {}
        cursor = cursor[p]
    # Try to parse JSON for non-string values
    try:
        parsed = json.loads(value)
        cursor[parts[-1]] = parsed
    except json.JSONDecodeError:
        cursor[parts[-1]] = value
    save_state(phase, scenario, state)
    return state


def list_ready() -> list[dict]:
    """Return active scenarios sorted by (consecutive_passes asc, last_run asc) — prioritise those that haven't run recently or are closest to plateau."""
    ready = []
    if not STATE_DIR.exists():
        return ready
    for f in STATE_DIR.glob("*.json"):
        if f.name == "TEMPLATE.json":
            continue
        with open(f) as fh:
            s = json.load(fh)
        if s.get("status") == "active":
            ready.append(s)
    ready.sort(key=lambda s: (s.get("consecutive_passes", 0), s.get("last_run") or ""))
    return ready


def summary() -> dict:
    counts = {"active": 0, "plateau": 0, "parked": 0, "retired": 0, "total": 0}
    if not STATE_DIR.exists():
        return counts
    for f in STATE_DIR.glob("*.json"):
        if f.name == "TEMPLATE.json":
            continue
        with open(f) as fh:
            s = json.load(fh)
        counts["total"] += 1
        status = s.get("status", "unknown")
        counts[status] = counts.get(status, 0) + 1
    return counts


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(2)

    cmd = sys.argv[1]

    try:
        if cmd == "get":
            phase, scenario = sys.argv[2], sys.argv[3]
            s = load_state(phase, scenario)
            if s is None:
                sys.exit(1)
            print(json.dumps(s, indent=2))
        elif cmd == "init":
            phase, scenario, fixture, expected, test_file = sys.argv[2:7]
            s = init_scenario(phase, scenario, fixture, expected, test_file)
            print(json.dumps(s, indent=2))
        elif cmd == "update":
            phase, scenario, field, value = sys.argv[2:6]
            s = update_field(phase, scenario, field, value)
            print(json.dumps(s, indent=2))
        elif cmd == "record-result":
            phase, scenario, result = sys.argv[2:5]
            if result not in ("pass", "fail", "flaky"):
                print(f"result must be pass|fail|flaky, got '{result}'", file=sys.stderr)
                sys.exit(2)
            s = record_result(phase, scenario, result)
            print(json.dumps(s, indent=2))
        elif cmd == "list-ready":
            for s in list_ready():
                print(f"{s['phase']}/{s['scenario']} passes={s.get('consecutive_passes', 0)} last={s.get('last_run')}")
        elif cmd == "summary":
            print(json.dumps(summary(), indent=2))
        else:
            print(f"unknown command: {cmd}", file=sys.stderr)
            print(__doc__, file=sys.stderr)
            sys.exit(2)
    except (IndexError, ValueError) as e:
        print(f"arg error: {e}", file=sys.stderr)
        print(__doc__, file=sys.stderr)
        sys.exit(2)


if __name__ == "__main__":
    main()
