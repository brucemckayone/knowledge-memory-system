-- oversize-summary.sql (v1.0)
-- Phase entity-summary — bead nmemo-2yv.56 fixture
-- Complexity score: 2 (rows=1, stressors=2)
-- Stressors:
--   1. Persisted summary is 3500 chars — ABOVE the .53 hard cap of 3000. The cap
--      is enforced on WRITE (causal-agent.ts:1686), not on read; the fixture exists
--      to verify that a read-side consumer (the future formatter under .51, the
--      external /api/entity/:id/profile JSON shape) gracefully tolerates oversize
--      legacy data rather than asserting on length post-hoc.
--   2. The summary is a coherent narrative of repeating 100-char paragraphs so the
--      test can also exercise the "truncate gracefully" branch of formatEntityProfile
--      (4000-char Telegram budget — the persisted summary alone is 87.5% of the budget).
--
-- Schema reference: src/db/schema.ts → entity_meta.summary (text, no SQL-side length check)
--
-- Why this exists despite the .53 write cap: legacy entity_meta.summary rows that
-- predate the cap may still hold 3000+ chars in production DBs. Future schema
-- migrations may relax or tighten the cap. The read surface must not assume the
-- column conforms to the current write policy — it must defend its consumers
-- (Telegram budget, viz panel character limits).
--
-- UUID map:
--   Entity Oversize       : 56000000-0000-0000-0003-000000000001 (person)
--
-- Expected after load:
--   entity_meta.summary length = 3500
--   formatEntityProfile (when wired in .51) MUST emit ≤ 4020 chars (4000 + truncation marker)

BEGIN;

INSERT INTO public.entities (id, canonical_name, entity_type, embedding, confidence)
VALUES
  ('56000000-0000-0000-0003-000000000001', '[bead-56-fixture] Oversize Person', 'person',
   ARRAY(SELECT random() FROM generate_series(1, 768))::vector, 1.0)
ON CONFLICT (id) DO NOTHING;

-- 3500 chars: '[bead-56-fixture] OVERSIZE-LEGACY-ROW ' (38 chars) +
-- 70 repetitions of an 8-char paragraph ': lorem ' (560 chars) +
-- 2902 chars of repeated 'x' filler. Total 3500 chars.
INSERT INTO public.entity_meta (entity_id, summary, summary_updated_at, updated_at)
VALUES
  ('56000000-0000-0000-0003-000000000001'::uuid,
   '[bead-56-fixture] OVERSIZE-LEGACY-ROW ' ||
     repeat(': lorem ', 70) ||
     repeat('x', 2902),
   NOW() - INTERVAL '90 days',
   NOW() - INTERVAL '90 days')
ON CONFLICT (entity_id) DO UPDATE SET
  summary = EXCLUDED.summary,
  summary_updated_at = EXCLUDED.summary_updated_at,
  updated_at = EXCLUDED.updated_at;

COMMIT;
