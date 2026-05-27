-- 032_reasoning_reports_query_question_check.sql — Add CHECK constraint
-- enforcing (mode='query' implies question IS NOT NULL AND non-blank) on
-- public.reasoning_reports. Bead nmemo-2yv.74.
--
-- Background: migration 008_reasoning_reports.sql declares the schema-
-- header contract "Each reasoning pass (patrol or query) produces a
-- report linked to the entities, facts, and causal edges it touched"
-- and gives the column shape `mode VARCHAR(20) NOT NULL CHECK (mode IN
-- ('patrol', 'query'))` plus `question TEXT` (nullable, no CHECK
-- relating it to mode). The contract is enforced only at the HTTP
-- boundary (POST /api/reason/query in src/index.ts:929 rejects empty
-- body.question) — not at the DB. Any consumer reaching the
-- save_reasoning_report tool via causal-agent.ts (the tool's input
-- schema marks question optional, src/services/causal-agent.ts:777-ish)
-- or via the pi-agent bridge whitelist (src/services/pi-agent-bridge.ts)
-- bypasses the HTTP guard. A query-mode pass where the python
-- reasoning agent forgets to forward the user's question into the
-- final save_reasoning_report call would persist with mode='query' and
-- NULL question — silently losing the audit trail.
--
-- The DB CHECK is the load-bearing fix: defends the column regardless
-- of which writer reaches it (HTTP handler, MCP tool dispatcher, pi
-- bridge, future agents). Defence-in-depth at the tool-input schema
-- layer (JSON Schema oneOf to require `question` when mode='query') is
-- not pursued in this migration — MCP consumers don't reliably honour
-- conditional schemas, so the DB CHECK is the necessary anchor.
--
-- Predicate: trim-then-length>0 also rejects whitespace-only strings
-- (the empty-string variant from the acceptance criteria — matches
-- the HTTP boundary's `if (!body.question)` falsy guard, which rejects
-- ''). length(trim(...)) > 0 collapses '   ', '\t', '\n' to length 0.
--
-- Sibling CHECK constraints on adjacent review surfaces this migration
-- mirrors:
--   - valid_candidate_status (003_graph_meta.sql:67)
--   - valid_resolution (018_resolution_enum_align.sql:33)
--   - valid_candidate_source (030_candidate_source_check.sql:45)
--   - valid_trigger_type (031_trigger_type_check.sql:46)
--
-- Pre-existing data: rows that satisfy the predicate today are not
-- migrated. If any row with mode='query' AND (question IS NULL OR
-- length(trim(question)) = 0) exists the ALTER ADD will fail loudly
-- by design — the migration is the data-corruption signal. The
-- choice (fail loudly vs sentinel-backfill) is recorded here per
-- the acceptance criteria: fail loudly. No production rows match the
-- broken shape today (no fixture/regression test creates a mode='query'
-- row at all — the only inserts in src/ are mode='patrol' from
-- index.ts:1108 and graph-stats.ts:407 and the contradictions test).
--
-- Idempotent re-run: DROP CONSTRAINT IF EXISTS clears any prior
-- definition before re-adding. The ALTER ADD itself fails if existing
-- rows violate the predicate — by design (data-corruption signal).
--
-- AGE search_path gotcha (per CLAUDE.md / 020+ headers): 001 set
-- search_path = ag_catalog, public, "$user" at session level. DO NOT
-- change it — AGE and Graph S triggers depend on ag_catalog being in
-- the path. Explicit public. qualifier on every DDL statement.

ALTER TABLE public.reasoning_reports
  DROP CONSTRAINT IF EXISTS reasoning_reports_query_question_required;

ALTER TABLE public.reasoning_reports
  ADD CONSTRAINT reasoning_reports_query_question_required CHECK (
    mode <> 'query'
    OR (question IS NOT NULL AND length(trim(question)) > 0)
  );
