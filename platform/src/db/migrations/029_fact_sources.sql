-- 029_fact_sources.sql — Replace facts.source_memory_id singleton with a
-- one-to-many fact_sources table. Bead nmemo-2yv.32.
--
-- Background: facts.source_memory_id (mig 001 §234) is a singleton — one
-- memory id per fact. createFact()'s dedup-and-corroborate branch
-- (facts.ts:110-141 prior to this bead) UNCONDITIONALLY overwrote the
-- column on every corroborating observation but only wrote a fact_history
-- row when confidence changed. A same-confidence corroboration with a new
-- source memory silently flipped the evidence pointer and dropped the
-- prior memory from the audit trail. Downstream consumers (reasoning
-- agent's get_fact_source, the viz unified endpoint) asked "what memory
-- mentioned this fact?" and got the most-recent winner, not the full
-- supporting set.
--
-- The bead's locked Scoped fix mandates the schema-level redesign rather
-- than a point-patch on the singleton:
--
--   fact_sources (fact_id, memory_id, source_text, observed_confidence,
--                 observed_at, observation_count)
--   PRIMARY KEY (fact_id, memory_id)
--
-- observation_count increments on a repeat-observation of the same
-- (fact, memory) pair via INSERT ... ON CONFLICT DO UPDATE; observed_at
-- refreshes to the latest sighting.
--
-- Step 5(a) of the bead: the legacy facts.source_memory_id and
-- facts.source_text columns stay readable during the migration window so
-- callers can adopt the new fact_sources array shape gradually. A
-- follow-up bead drops the singleton columns after readers migrate.
--
-- Forward-only. The backfill is idempotent (ON CONFLICT DO NOTHING) so
-- re-running this migration is safe; running twice produces the same
-- final state.
--
-- AGE search_path gotcha (per CLAUDE.md / 020+ headers): 001 set
-- search_path = ag_catalog, public, "$user" at session level. DO NOT
-- change it — AGE and Graph S triggers depend on ag_catalog being in the
-- path. Explicit public. qualifier on every DDL/DML statement.

-- ============================================
-- 1. fact_sources — one-to-many supporting memories per fact
-- ============================================
CREATE TABLE IF NOT EXISTS public.fact_sources (
  fact_id              UUID NOT NULL
                         REFERENCES public.facts(id) ON DELETE CASCADE,
  memory_id            UUID NOT NULL,
  source_text          TEXT,
  observed_confidence  FLOAT,
  observed_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  observation_count    INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (fact_id, memory_id)
);

CREATE INDEX IF NOT EXISTS idx_fact_sources_fact
  ON public.fact_sources (fact_id);
CREATE INDEX IF NOT EXISTS idx_fact_sources_memory
  ON public.fact_sources (memory_id);

-- ============================================
-- 2. Backfill from facts.source_memory_id singletons.
-- ============================================
-- Every fact with a non-null source_memory_id contributes one row.
-- ON CONFLICT DO NOTHING covers a re-run of this migration (a future
-- mutation may already have written to fact_sources via the new code
-- path before this DDL re-runs). The (fact_id, memory_id) PK guarantees
-- no duplicates.
INSERT INTO public.fact_sources (
  fact_id, memory_id, source_text, observed_confidence, observed_at, observation_count
)
SELECT id, source_memory_id, source_text, confidence, created_at, 1
FROM public.facts
WHERE source_memory_id IS NOT NULL
ON CONFLICT (fact_id, memory_id) DO NOTHING;
