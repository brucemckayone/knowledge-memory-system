-- backfill-causal-event-corpus.sql — nmemo-asf.10 (ONE-SHOT data fix, NOT a migration)
--
-- Do NOT place this under db/migrations/ — the migration runner re-runs every file in
-- that dir on each invocation. This is a one-time data backfill, kept here for
-- reproducibility and applied by hand via psql:
--
--   docker exec -i nmemo-postgres-1 psql -U cognitive -d cognitive_test \
--     < platform/src/db/backfills/backfill-causal-event-corpus.sql
--
-- Why: the fact->causal-event mirror `createCausalEvent` (services/facts.ts) historically
-- never stamped corpus_id, so serial-arm events took the column default 'default' while
-- the fact lived in a named corpus (nmemo-asf.3 fixed this forward). This corrects the
-- ~7299 existing mis-stamped rows so corpus-scoped causal reads (getEntityCausalHistory,
-- traceCauses) are correct on the full 294-doc substrate.
--
-- Safety:
--   * causal_events carries a BEFORE-UPDATE immutability trigger `trg_corpus_immutable`
--     (migration 052) that REJECTS any corpus_id change — DISABLE it for the run, restore
--     after. Also disable the retired AGE sync trigger `trigger_sync_causal_event` (it
--     only warns "graph causal_graph does not exist" — a no-op — but keep the run quiet).
--   * Wrapped in one transaction: if the UPDATE fails, ROLLBACK restores both triggers.
--   * Idempotent: the `IS DISTINCT FROM` predicate means a re-run touches 0 rows.
--   * Every causal_events row has a non-NULL fact_id on this DB (verified), so the join
--     reaches every event; there are no fact-less orphans to leave behind.

BEGIN;

ALTER TABLE public.causal_events DISABLE TRIGGER trg_corpus_immutable;
ALTER TABLE public.causal_events DISABLE TRIGGER trigger_sync_causal_event;

UPDATE public.causal_events ce
   SET corpus_id = f.corpus_id
  FROM public.facts f
 WHERE f.id = ce.fact_id
   AND ce.corpus_id IS DISTINCT FROM f.corpus_id;

ALTER TABLE public.causal_events ENABLE TRIGGER trg_corpus_immutable;
ALTER TABLE public.causal_events ENABLE TRIGGER trigger_sync_causal_event;

COMMIT;
