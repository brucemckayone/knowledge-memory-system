#!/usr/bin/env python3
"""
apply-evolver-output.py — parse, validate, and apply Test-Data Evolver subagent output.

Parses the markdown the subagent returns, extracts the fixture SQL block + expected JSON
block + metadata fields, validates each one, and (unless --dry-run) writes the updated
files and bumps `fixture_version` + `complexity_score` in scenario-state.

Output format expected (see subagents/data-evolver.md):

    ## Mutation proposal

    **Fixture version:** vN -> vN+1     (or `vN → vN+1`)
    **Axis:** <one>
    **Criterion targeted:** <quote>
    **Complexity delta:** +K (from M to M+K)

    ### Rationale
    <paragraph>

    ### Fixture diff
    ```sql
    -- full updated fixture SQL
    ```

    ### Expected JSON diff
    ```json
    // full updated expected JSON
    ```

    ### Regression-test promise
    <text>

Usage:
  apply-evolver-output.py <phase> <scenario> [--input <file>|-] [--dry-run] [--no-db-check]

Exit codes:
  0 — applied successfully (or dry-run validated successfully)
  1 — parse or validation failed
  2 — write or DB validation failed
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
REPO_ROOT = SKILL_ROOT.parent.parent.parent

REQUIRED_FIELDS = ("fixture_version", "axis", "criterion", "complexity_delta")
VALID_AXES = {
    "scale", "concurrency", "adversarial-structural", "adversarial-temporal",
    "domain-realistic", "cross-fixture",
}


def parse_evolver_markdown(md: str) -> dict:
    """Parse the subagent output. Raises ValueError on missing required content."""
    out: dict = {"raw": md}

    # Field lines (bold-prefixed, colon-separated)
    field_patterns = {
        "fixture_version": r"\*\*Fixture version:\*\*\s*(.+?)\s*$",
        "axis": r"\*\*Axis:\*\*\s*(.+?)\s*$",
        "criterion": r"\*\*Criterion targeted:\*\*\s*(.+?)\s*$",
        "complexity_delta": r"\*\*Complexity delta:\*\*\s*(.+?)\s*$",
    }
    for key, pat in field_patterns.items():
        m = re.search(pat, md, re.MULTILINE)
        if not m:
            raise ValueError(f"missing required field: {key}")
        out[key] = m.group(1).strip()

    # Fixture SQL block — first ```sql ... ``` after "### Fixture diff"
    fixture_match = re.search(
        r"###\s+Fixture diff\s*\n+```sql\s*\n(.*?)\n```",
        md, re.DOTALL | re.IGNORECASE,
    )
    if not fixture_match:
        raise ValueError("missing ### Fixture diff with ```sql block")
    out["fixture_sql"] = fixture_match.group(1)

    # Expected JSON block — first ```json ... ``` after "### Expected JSON diff"
    json_match = re.search(
        r"###\s+Expected JSON diff\s*\n+```json\s*\n(.*?)\n```",
        md, re.DOTALL | re.IGNORECASE,
    )
    if not json_match:
        raise ValueError("missing ### Expected JSON diff with ```json block")
    out["expected_json_text"] = json_match.group(1)

    # Rationale
    rationale_match = re.search(
        r"###\s+Rationale\s*\n+(.*?)(?=\n###\s|\Z)",
        md, re.DOTALL | re.IGNORECASE,
    )
    out["rationale"] = rationale_match.group(1).strip() if rationale_match else ""

    return out


def normalise_version(v: str) -> tuple[str, str]:
    """Parse 'vN -> vN+1' or 'vN → vN+1' into (old, new). Accepts dotted versions."""
    # Replace unicode arrows + dashes with ASCII '->'
    v = v.replace("→", "->").replace("⟶", "->").replace("—>", "->")
    parts = re.split(r"\s*->\s*", v)
    if len(parts) != 2:
        raise ValueError(f"fixture_version must be 'vN -> vN+1' form, got: {v!r}")
    old, new = parts[0].strip(), parts[1].strip()
    version_re = r"^v?\d+(\.\d+)*(-[\w.]+)?$"
    if not re.match(version_re, old) or not re.match(version_re, new):
        raise ValueError(
            f"version components must match v?N(.M)*[-suffix], got {old!r} -> {new!r}"
        )
    return old, new


def parse_complexity_delta(s: str) -> tuple[int, int, int]:
    """Parse '+K (from M to M+K)' into (delta, current, new). Tolerant of missing parts."""
    delta = 0
    current = -1
    new = -1
    m = re.match(r"^([+-]?\d+)", s.strip())
    if m:
        delta = int(m.group(1))
    m = re.search(r"from\s+(\d+)\s+to\s+(\d+)", s, re.IGNORECASE)
    if m:
        current, new = int(m.group(1)), int(m.group(2))
    return delta, current, new


def validate_expected_json(text: str) -> dict:
    """Strip leading // comments and parse JSON. Raise on failure."""
    cleaned_lines = []
    for line in text.splitlines():
        # Strip leading whitespace + // comment lines (the spec uses // as a hint marker)
        stripped = line.lstrip()
        if stripped.startswith("//"):
            continue
        cleaned_lines.append(line)
    cleaned = "\n".join(cleaned_lines)
    return json.loads(cleaned)


def strip_outer_transaction(sql: str) -> str:
    """Remove the outermost BEGIN; ... COMMIT; if present (so we can wrap our own).

    Skips leading SQL comment lines (-- ...) and blank lines when looking for the
    opening BEGIN, so a fixture with a long header banner still has its transaction
    correctly stripped.
    """
    lines = sql.splitlines(keepends=True)
    # Find the first non-comment, non-blank line
    first_idx = None
    for i, line in enumerate(lines):
        stripped = line.strip()
        if not stripped or stripped.startswith("--"):
            continue
        first_idx = i
        break
    if first_idx is not None:
        first = lines[first_idx].strip()
        if re.match(r"^BEGIN\s*;?\s*$", first, re.IGNORECASE):
            lines[first_idx] = ""  # remove only this line, keep header comments + blanks
    # Find last non-comment, non-blank line and check for COMMIT
    last_idx = None
    for i in range(len(lines) - 1, -1, -1):
        stripped = lines[i].strip()
        if not stripped or stripped.startswith("--"):
            continue
        last_idx = i
        break
    if last_idx is not None:
        last = lines[last_idx].strip()
        if re.match(r"^COMMIT\s*;?\s*$", last, re.IGNORECASE):
            lines[last_idx] = ""
    return "".join(lines)


DEFAULT_PGUSER = os.environ.get("PGUSER", "cognitive")
DEFAULT_PGPASSWORD = os.environ.get("PGPASSWORD", "cognitive")
DEFAULT_PGDATABASE = os.environ.get("PGDATABASE", "cognitive_test")
DEFAULT_PGHOST = os.environ.get("PGHOST", "127.0.0.1")
DEFAULT_PGPORT = os.environ.get("PGPORT", "5433")


def _psql_cmd_host() -> list[str]:
    return ["psql", "-h", DEFAULT_PGHOST, "-p", DEFAULT_PGPORT,
            "-U", DEFAULT_PGUSER, "-d", DEFAULT_PGDATABASE,
            "-v", "ON_ERROR_STOP=1", "-q", "-X", "--no-psqlrc"]


def _psql_cmd_docker() -> list[str] | None:
    """If host psql is missing, fall back to docker exec into the running PG container."""
    container = os.environ.get("PG_CONTAINER", "nmemo-postgres-1")
    try:
        check = subprocess.run(
            ["docker", "ps", "--filter", f"name=^{container}$", "--format", "{{.Names}}"],
            capture_output=True, text=True, timeout=10,
        )
    except FileNotFoundError:
        return None
    if check.returncode != 0 or container not in (check.stdout or ""):
        return None
    # docker exec -i so we can pipe stdin
    return ["docker", "exec", "-i", "-e", f"PGPASSWORD={DEFAULT_PGPASSWORD}", container,
            "psql", "-U", DEFAULT_PGUSER, "-d", DEFAULT_PGDATABASE,
            "-v", "ON_ERROR_STOP=1", "-q", "-X", "--no-psqlrc"]


def validate_against_db(sql: str) -> tuple[bool, str]:
    """Run SQL through psql inside a transaction that rolls back. Return (ok, stderr).

    Pipes SQL as UTF-8 bytes to avoid the cp1252 default on Windows tripping over any
    non-ASCII characters that may appear in fixture comments (arrows, em-dashes, etc).
    """
    cleaned = strip_outer_transaction(sql)
    wrapped = f"BEGIN;\n{cleaned}\nROLLBACK;\n"
    payload = wrapped.encode("utf-8")
    env = {**os.environ, "PGPASSWORD": DEFAULT_PGPASSWORD, "PGCLIENTENCODING": "UTF8"}
    cmd = _psql_cmd_host()
    try:
        proc = subprocess.run(
            cmd, input=payload, capture_output=True, env=env, timeout=60,
        )
    except FileNotFoundError:
        cmd = _psql_cmd_docker()
        if cmd is None:
            return False, "psql not on PATH and no running PG container found (set PG_CONTAINER)"
        try:
            proc = subprocess.run(
                cmd, input=payload, capture_output=True, timeout=60,
            )
        except subprocess.TimeoutExpired:
            return False, "psql (docker) timed out (60s)"
    except subprocess.TimeoutExpired:
        return False, "psql timed out (60s)"
    if proc.returncode == 0:
        return True, ""
    err = (proc.stderr or proc.stdout or b"").decode("utf-8", errors="replace").strip()
    return False, err


def update_scenario_state(phase: str, scenario: str, parsed: dict, version_old: str,
                          version_new: str) -> None:
    """Bump fixture_version and complexity_score. Append axis to stressors if novel."""
    state_path = SCENARIO_STATE_DIR / f"{phase}-{scenario}.json"
    if not state_path.exists():
        raise FileNotFoundError(state_path)
    with open(state_path) as f:
        state = json.load(f)

    state["fixture_version"] = version_new
    delta, _, new_complexity = parse_complexity_delta(parsed["complexity_delta"])
    if new_complexity >= 0:
        state["complexity_score"] = new_complexity
    else:
        state["complexity_score"] = state.get("complexity_score", 0) + delta

    axis_token = f"axis={parsed['axis']}"
    stressors = state.get("stressors_applied", [])
    if axis_token not in stressors:
        stressors.append(axis_token)
    state["stressors_applied"] = stressors

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
    ap.add_argument("--input", default="-",
                    help="Path to evolver markdown (default '-' = stdin)")
    ap.add_argument("--dry-run", action="store_true",
                    help="Validate only, do not write or update state")
    ap.add_argument("--no-db-check", action="store_true",
                    help="Skip psql validation against test DB")
    args = ap.parse_args()

    if args.input == "-":
        md = sys.stdin.read()
    else:
        md = Path(args.input).read_text(encoding="utf-8")

    if not md.strip():
        sys.exit("error: empty input")

    try:
        parsed = parse_evolver_markdown(md)
    except ValueError as e:
        sys.exit(f"parse error: {e}")

    # Validate fields
    try:
        version_old, version_new = normalise_version(parsed["fixture_version"])
    except ValueError as e:
        sys.exit(f"parse error: {e}")

    axis = parsed["axis"].strip().lower().split()[0]
    if axis not in VALID_AXES:
        sys.stderr.write(
            f"warning: axis '{parsed['axis']}' not in known set "
            f"({sorted(VALID_AXES)}); proceeding\n"
        )

    try:
        expected_obj = validate_expected_json(parsed["expected_json_text"])
    except json.JSONDecodeError as e:
        sys.exit(f"expected JSON did not parse: {e}")

    # Load scenario state to find fixture/expected paths
    state_path = SCENARIO_STATE_DIR / f"{args.phase}-{args.scenario}.json"
    if not state_path.exists():
        sys.exit(f"error: no scenario state at {state_path}")
    with open(state_path) as f:
        state = json.load(f)

    fixture_target = REPO_ROOT / state["fixture_path"]
    expected_target = REPO_ROOT / state["expected_path"]

    # Optional DB validation
    if not args.no_db_check:
        ok, err = validate_against_db(parsed["fixture_sql"])
        if not ok:
            sys.stderr.write(f"DB validation failed:\n{err}\n")
            sys.exit(2)

    if args.dry_run:
        report = {
            "phase": args.phase,
            "scenario": args.scenario,
            "version_old": version_old,
            "version_new": version_new,
            "axis": parsed["axis"],
            "criterion": parsed["criterion"],
            "complexity_delta": parsed["complexity_delta"],
            "fixture_lines": len(parsed["fixture_sql"].splitlines()),
            "expected_keys": sorted(list(expected_obj.keys())) if isinstance(expected_obj, dict) else None,
            "db_check": "skipped" if args.no_db_check else "ok",
            "would_write": [str(fixture_target.relative_to(REPO_ROOT)),
                            str(expected_target.relative_to(REPO_ROOT))],
            "rationale": parsed["rationale"][:300],
        }
        print(json.dumps(report, indent=2))
        return

    # Apply
    try:
        fixture_target.parent.mkdir(parents=True, exist_ok=True)
        expected_target.parent.mkdir(parents=True, exist_ok=True)
        fixture_target.write_text(parsed["fixture_sql"] + "\n", encoding="utf-8")
        expected_target.write_text(
            json.dumps(expected_obj, indent=2) + "\n", encoding="utf-8",
        )
        update_scenario_state(args.phase, args.scenario, parsed, version_old, version_new)
    except Exception as e:
        sys.exit(f"write error: {e}")

    print(json.dumps({
        "applied": True,
        "phase": args.phase,
        "scenario": args.scenario,
        "version_old": version_old,
        "version_new": version_new,
        "axis": parsed["axis"],
        "wrote": [str(fixture_target.relative_to(REPO_ROOT)),
                  str(expected_target.relative_to(REPO_ROOT))],
    }, indent=2))


if __name__ == "__main__":
    main()
