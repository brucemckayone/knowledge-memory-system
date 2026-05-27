-- stale-summary.sql (v1.0)
-- Phase entity-summary — bead nmemo-2yv.56 fixture
-- Complexity score: 2 (rows=1, stressors=2)
-- Stressors:
--   1. summary_updated_at older than 30 days — the "stale" threshold the viz
--      detail panel (.52) and the assembler (.51) use to flag freshness.
--   2. entity_meta.updated_at is intentionally RECENT (yesterday). The two timestamps
--      diverge here to encode doc 37 §8 "two timestamps, two meanings": updated_at
--      churn from other writers (centroid recompute, mention count) MUST NOT mask
--      summary staleness. A stale-summary check that reads updated_at would
--      false-negative this row; the correct read is summary_updated_at.
--
-- Schema reference: src/db/schema.ts → entity_meta.summary, summary_updated_at, updated_at
-- Migration 036 introduces summary_updated_at specifically for this distinction.
--
-- UUID map:
--   Entity Stale          : 56000000-0000-0000-0005-000000000001 (person)
--
-- Expected after load:
--   entity_meta row has summary (non-null), summary_updated_at = NOW() - 45 days,
--   updated_at = NOW() - 1 day. A staleness check on summary_updated_at returns
--   TRUE (stale); a (wrong) staleness check on updated_at returns FALSE.

BEGIN;

INSERT INTO public.entities (id, canonical_name, entity_type, embedding, confidence)
VALUES
  ('56000000-0000-0000-0005-000000000001', '[bead-56-fixture] Stale Summary Person', 'person',
   ARRAY(SELECT random() FROM generate_series(1, 768))::vector, 1.0)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.entity_meta (entity_id, summary, summary_updated_at, updated_at)
VALUES
  ('56000000-0000-0000-0005-000000000001'::uuid,
   '[bead-56-fixture] Stale Summary Person was last summarised 45 days ago. Since then mentions have continued (driving updated_at churn) but the agent has not rewritten the narrative. Test consumers should flag this row as stale-summary even though updated_at is fresh.',
   NOW() - INTERVAL '45 days',
   NOW() - INTERVAL '1 day')
ON CONFLICT (entity_id) DO UPDATE SET
  summary = EXCLUDED.summary,
  summary_updated_at = EXCLUDED.summary_updated_at,
  updated_at = EXCLUDED.updated_at;

COMMIT;
