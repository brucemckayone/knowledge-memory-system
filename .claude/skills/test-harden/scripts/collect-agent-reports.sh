#!/usr/bin/env bash
# collect-agent-reports.sh — pull recent reasoning_reports from the DB.
#
# Usage:
#   collect-agent-reports.sh --since <ISO-timestamp>
#   collect-agent-reports.sh --last <N>
#
# Output: JSON array to stdout, one object per row.

set -uo pipefail

PGHOST="${PGHOST:-localhost}"
PGPORT="${PGPORT:-5433}"
PGUSER="${PGUSER:-postgres}"
PGDATABASE="${PGDATABASE:-mnemo}"
export PGPASSWORD="${PGPASSWORD:-postgres}"

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

# psql with JSON aggregation
psql -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d "$PGDATABASE" \
  -t -A -c "
SET search_path = ag_catalog, public;
SELECT COALESCE(json_agg(r), '[]'::json) FROM (
  SELECT id, mode, question, report, actions_taken, entity_ids,
         fact_ids, causal_edge_ids, created_at
  FROM reasoning_reports
  WHERE $WHERE
) r;
" 2>/dev/null
