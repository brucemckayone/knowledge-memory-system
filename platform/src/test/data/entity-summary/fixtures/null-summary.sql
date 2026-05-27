-- null-summary.sql (v1.0)
-- Phase entity-summary — bead nmemo-2yv.56 fixture
-- Complexity score: 1 (rows=1, stressors=1)
-- Stressors:
--   1. entity_meta row exists but summary IS NULL — the "agent never wrote a summary"
--      branch that the formatter and the future GET /api/entity/:id/profile assembler
--      (.51) must omit cleanly without null-deref.
--
-- Schema reference: src/db/schema.ts → entity_meta.summary (text, nullable)
--
-- UUID map:
--   Entity NullSummary    : 56000000-0000-0000-0002-000000000001 (person)
--
-- Expected after load:
--   entity_meta row exists with summary = NULL AND summary_updated_at = NULL
--   formatEntityProfile output (when wired in .51) MUST NOT contain the agent-authored
--   summary block — neither header nor body. The null branch is silent.

BEGIN;

INSERT INTO public.entities (id, canonical_name, entity_type, embedding, confidence)
VALUES
  ('56000000-0000-0000-0002-000000000001', '[bead-56-fixture] Null Summary Person', 'person',
   ARRAY(SELECT random() FROM generate_series(1, 768))::vector, 1.0)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.entity_meta (entity_id, summary, summary_updated_at, updated_at)
VALUES
  ('56000000-0000-0000-0002-000000000001'::uuid, NULL, NULL, NOW() - INTERVAL '7 days')
ON CONFLICT (entity_id) DO UPDATE SET
  summary = EXCLUDED.summary,
  summary_updated_at = EXCLUDED.summary_updated_at,
  updated_at = EXCLUDED.updated_at;

COMMIT;
