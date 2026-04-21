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

SKILL_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REPO_ROOT="$(cd "$SKILL_ROOT/../../.." && pwd)"
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

# Run vitest, capture output
cd "$REPO_ROOT/platform" || exit 2

START_TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)
LOG_FILE="$SKILL_ROOT/scenario-state/${PHASE}-${SCENARIO}.last-run.log"

echo "[run-scenario] starting ${PHASE}/${SCENARIO} at $START_TS" >&2
echo "[run-scenario] test file: $TEST_FILE" >&2

# Run only tests matching the scenario name — scope via test name filter
pnpm vitest run --reporter=json --testNamePattern="$SCENARIO" "$TEST_FILE" > "$LOG_FILE" 2>&1
RC=$?

END_TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)

echo "[run-scenario] exit=$RC" >&2

# Try to extract structured result from vitest JSON output
# (falls back to rc-based result if JSON parse fails)
python - <<PYEOF
import json, sys, re
from pathlib import Path

log = Path("$LOG_FILE").read_text(encoding='utf-8', errors='replace')

# vitest --reporter=json writes a JSON blob. Find it.
m = re.search(r'(\{.*"testResults".*\})', log, re.DOTALL)
result = {
    "scenario": "$SCENARIO",
    "phase": "$PHASE",
    "started_at": "$START_TS",
    "ended_at": "$END_TS",
    "exit_code": $RC,
    "passed": $RC == 0,
}

if m:
    try:
        data = json.loads(m.group(1))
        result["num_tests"] = data.get("numTotalTests")
        result["num_passed"] = data.get("numPassedTests")
        result["num_failed"] = data.get("numFailedTests")
        result["duration_ms"] = data.get("testResults", [{}])[0].get("endTime", 0) - data.get("testResults", [{}])[0].get("startTime", 0)
    except Exception as e:
        result["parse_error"] = str(e)

print(json.dumps(result, indent=2))
PYEOF

exit $RC
