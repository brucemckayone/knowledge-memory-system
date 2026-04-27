#!/usr/bin/env bash
# run-scenario.sh — execute a test scenario and capture structured output.
#
# Usage: run-scenario.sh <phase> <scenario>
# Exit codes:
#   0 — all assertions pass
#   1 — test failure (normal)
#   2 — harness error (test file missing, etc.)

set -uo pipefail

PHASE="${1:-}"
SCENARIO="${2:-}"

if [[ -z "$PHASE" || -z "$SCENARIO" ]]; then
  echo "usage: $0 <phase> <scenario>" >&2
  exit 2
fi

# Resolve absolute paths. On Git-Bash (Windows), use Windows-form paths so that
# anything we hand off to a native Python or Node process can resolve them.
if command -v cygpath >/dev/null 2>&1; then
  SKILL_ROOT="$(cygpath -m "$(cd "$(dirname "$0")/.." && pwd)")"
  REPO_ROOT="$(cygpath -m "$(cd "$(dirname "$0")/../../../.." && pwd)")"
else
  SKILL_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
  REPO_ROOT="$(cd "$(dirname "$0")/../../../.." && pwd)"
fi
STATE_FILE="$SKILL_ROOT/scenario-state/${PHASE}-${SCENARIO}.json"

if [[ ! -f "$STATE_FILE" ]]; then
  echo "error: no scenario-state for ${PHASE}/${SCENARIO} — run scenario-state.py init first" >&2
  exit 2
fi

# Extract test_file path from state JSON (using python for safety)
TEST_FILE=$(python -c "
import json, sys
with open('$STATE_FILE') as f:
    s = json.load(f)
print(s.get('test_file', ''))
")

if [[ -z "$TEST_FILE" || ! -f "$REPO_ROOT/$TEST_FILE" ]]; then
  echo "error: test file '$TEST_FILE' not found (from state)" >&2
  exit 2
fi

# Run vitest from inside platform/ (where pnpm + vitest config live).
# Scenario state stores TEST_FILE relative to repo root (e.g. "platform/src/test/...");
# strip the leading "platform/" so the path resolves after cd.
cd "$REPO_ROOT/platform" || exit 2

VITEST_TEST_FILE="${TEST_FILE#platform/}"

START_TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)
LOG_FILE="$SKILL_ROOT/scenario-state/${PHASE}-${SCENARIO}.last-run.log"

echo "[run-scenario] starting ${PHASE}/${SCENARIO} at $START_TS" >&2
echo "[run-scenario] test file: $VITEST_TEST_FILE (from $TEST_FILE)" >&2

# Try the scenario-name filter first. If it matches zero tests (the codebase may
# not yet name tests after their scenario), fall back to running the whole file
# so we always get a real signal — and record which mode actually fired.
# The codebase doesn't currently name tests by scenario; testNamePattern would
# leave every test "pending" in vitest 4. Run the whole test file. Filtering
# down to a sub-suite per scenario is a separate piece of work — see SKILL.md.
SCENARIO_FILTER_MODE="full-file"
pnpm vitest run --reporter=json "$VITEST_TEST_FILE" > "$LOG_FILE" 2>&1
RC=$?

END_TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)

echo "[run-scenario] exit=$RC" >&2

# Try to extract structured result from vitest JSON output
# (falls back to rc-based result if JSON parse fails)
python - <<PYEOF
import json, re
from pathlib import Path

log = Path("$LOG_FILE").read_text(encoding='utf-8', errors='replace')

result = {
    "scenario": "$SCENARIO",
    "phase": "$PHASE",
    "started_at": "$START_TS",
    "ended_at": "$END_TS",
    "exit_code": $RC,
    "passed": $RC == 0,
    "filter_mode": "$SCENARIO_FILTER_MODE",
}

# vitest --reporter=json writes a single-line JSON document with the run summary.
# Find lines that look like a JSON object containing numTotalTests; parse each
# until one parses cleanly. ANSI colour escapes stripped first.
ansi_re = re.compile(r'\x1b\[[0-9;]*m')
data = None
for line in log.splitlines():
    candidate = ansi_re.sub('', line).strip()
    if not candidate.startswith('{') or '"numTotalTests"' not in candidate:
        continue
    try:
        data = json.loads(candidate)
        break
    except json.JSONDecodeError:
        continue

if data is None:
    result["parse_error"] = "no JSON line containing numTotalTests found"
else:
    result["num_tests"] = data.get("numTotalTests")
    result["num_passed"] = data.get("numPassedTests")
    result["num_failed"] = data.get("numFailedTests")
    test_results = data.get("testResults") or []
    if test_results:
        first = test_results[0]
        try:
            result["duration_ms"] = int(first.get("endTime", 0) - first.get("startTime", 0))
        except Exception:
            result["duration_ms"] = None

print(json.dumps(result, indent=2))
PYEOF

exit $RC
