#!/usr/bin/env bash
# collect-agent-reports.sh — pull recent reasoning_reports from the DB.
#
# Usage:
#   collect-agent-reports.sh --since <ISO-timestamp>
#   collect-agent-reports.sh --last <N>
#
# Output: JSON array to stdout, one object per row.

set -uo pipefail

PGHOST="${PGHOST:-127.0.0.1}"
PGPORT="${PGPORT:-5433}"
PGUSER="${PGUSER:-cognitive}"
PGDATABASE="${PGDATABASE:-cognitive_test}"
PG_CONTAINER="${PG_CONTAINER:-nmemo-postgres-1}"
export PGPASSWORD="${PGPASSWORD:-cognitive}"

MODE="${1:-}"
ARG="${2:-}"

if [[ "$MODE" == "--since" && -n "$ARG" ]]; then
  WHERE="created_at >= '$ARG'::timestamptz"
elif [[ "$MODE" == "--last" && -n "$ARG" ]]; then
  WHERE="TRUE ORDER BY created_at DESC LIMIT $ARG"
else
  echo "usage: $0 --since <ts> | --last <N>" >&2
  exit 2
fi

QUERY="
SET search_path = ag_catalog, public;
SELECT COALESCE(json_agg(r), '[]'::json) FROM (
  SELECT id, mode, question, report, actions_taken, entity_ids,
         fact_ids, causal_edge_ids, created_at
  FROM reasoning_reports
  WHERE $WHERE
) r;
"

# Try host psql first; fall back to docker exec if missing.
if command -v psql >/dev/null 2>&1; then
  psql -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d "$PGDATABASE" -t -A -q -c "$QUERY" 2>/dev/null | grep -v '^SET$' || true
elif command -v docker >/dev/null 2>&1 \
     && docker ps --format "{{.Names}}" 2>/dev/null | grep -q "^${PG_CONTAINER}$"; then
  docker exec -i -e PGPASSWORD="$PGPASSWORD" "$PG_CONTAINER" \
    psql -U "$PGUSER" -d "$PGDATABASE" -t -A -q -c "$QUERY" 2>/dev/null | grep -v '^SET$' || true
else
  echo "[]"
  echo "<warning: psql not on PATH and PG container '$PG_CONTAINER' not running>" >&2
fi
