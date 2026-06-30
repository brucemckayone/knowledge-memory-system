-- 037_fact_triple_unique.sql
-- P1 (doc 38 — parallel ingestion). A partial UNIQUE index on the active fact
-- triple so concurrent ingestion can't create duplicate active facts: the
-- second racing INSERT fails with SQLSTATE 23505 and createFact() recovers by
-- corroborating the winner (services/facts.ts).
--
-- Explicit public. qualifiers — 001 set search_path = ag_catalog, public at
-- session level (AGE gotcha; see CLAUDE.md / mig 029 header). DO NOT change it.

-- Expire any pre-existing duplicate active facts first (keep the
-- highest-confidence / newest) so the unique index can be created. Same ranking
-- as the entity-merge dedup (entities.ts mergeEntities step 6). No-op on a
-- fresh DB and on every re-run once the index exists.
WITH ranked AS (
  SELECT id, ROW_NUMBER() OVER (
    PARTITION BY subject_entity_id, predicate,
      COALESCE(object_entity_id::text, ''), COALESCE(object_value, '')
    ORDER BY confidence DESC NULLS LAST, created_at DESC
  ) AS rn
  FROM public.facts
  WHERE expired_at IS NULL
)
UPDATE public.facts
SET expired_at = NOW(),
    expire_reason = 'duplicate active triple removed for uniq_facts_active_triple (mig 037)'
WHERE id IN (SELECT id FROM ranked WHERE rn > 1);

-- The active-triple key. COALESCE sentinels give entity-object and value-object
-- facts a single well-defined key (NULL object_entity_id collapses to the zero
-- UUID; NULL object_value to ''), so one index covers both shapes.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_facts_active_triple
  ON public.facts (
    subject_entity_id,
    predicate,
    COALESCE(object_entity_id, '00000000-0000-0000-0000-000000000000'::uuid),
    COALESCE(object_value, '')
  )
  WHERE expired_at IS NULL;
