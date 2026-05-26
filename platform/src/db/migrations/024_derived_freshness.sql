-- 024_derived_freshness.sql — Post-ingest counter trigger for topology +
-- clustering auto-compute.
--
-- Background: bead nmemo-2yv.84. topology + clustering computes were
-- manual-only (T12 violation). The locked Decision section in .84
-- introduces a shared `derived_freshness` table — one row per derived_kind
-- ('topology', 'clustering') — tracking `facts_since_compute` (counter) and
-- `last_computed_at` (wall-clock recency for ops visibility).
--
-- Two complementary writers update this table:
--   1) On every public.facts INSERT, a DB trigger atomically increments
--      facts_since_compute for both derived_kind rows. Lives here so any
--      fact-insert path (createFact, future ingest variants, fixture loads,
--      manual SQL inserts during reconciliation) flows through it.
--   2) On every successful /api/{topology,clustering}/compute, the platform
--      resets facts_since_compute=0 and stamps last_computed_at=NOW(). The
--      reset is platform-side because it's bound to the HTTP success path,
--      not the DB write path. See src/services/derived-freshness.ts.
--
-- The threshold-firing logic (when facts_since_compute >= threshold, fire
-- topology + clustering compute fire-and-forget) lives in the platform layer
-- (createFact post-insert hook). The DB stays a passive counter — pl/pgsql
-- has no business making HTTP calls into ml-services.
--
-- AGE search_path gotcha (per CLAUDE.md / 016-021 headers): explicit
-- public. qualifiers throughout so DDL lands in public, not ag_catalog.

CREATE TABLE IF NOT EXISTS public.derived_freshness (
  derived_kind          VARCHAR(40) PRIMARY KEY,
  facts_since_compute   INTEGER     NOT NULL DEFAULT 0,
  last_computed_at      TIMESTAMPTZ,
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT derived_freshness_kind_known
    CHECK (derived_kind IN ('topology', 'clustering'))
);

-- Seed the two rows. The bead's Decision section locks the set; future
-- additions (e.g. 'pattern_detection') would land in a new migration alongside
-- their own auto-trigger work.
INSERT INTO public.derived_freshness (derived_kind, facts_since_compute)
VALUES ('topology', 0), ('clustering', 0)
ON CONFLICT (derived_kind) DO NOTHING;

-- ============================================
-- Trigger: increment facts_since_compute on each public.facts INSERT.
-- ============================================
--
-- AFTER INSERT FOR EACH ROW. Both rows bump atomically inside the inserting
-- transaction (the UPDATE is on the same connection) — if the INSERT rolls
-- back, the increment rolls back too. STATEMENT-level would be marginally
-- cheaper for bulk inserts but ROW-level matches the createFact one-at-a-time
-- shape, which is the dominant pattern.

CREATE OR REPLACE FUNCTION public.bump_derived_freshness_on_fact() RETURNS TRIGGER AS $$
BEGIN
  UPDATE public.derived_freshness
    SET facts_since_compute = facts_since_compute + 1,
        updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS bump_derived_freshness_on_fact_trg ON public.facts;
CREATE TRIGGER bump_derived_freshness_on_fact_trg
  AFTER INSERT ON public.facts
  FOR EACH ROW
  EXECUTE FUNCTION public.bump_derived_freshness_on_fact();
