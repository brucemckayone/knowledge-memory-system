-- reasoning-empty.sql (v1.0)
-- Phase 8 (Reasoning Agent Surface) — bead nmemo-2yv.79 cold-start fixture
-- Complexity score: 2 (rows=2, stressors=1)
-- Stressors:
--   1. Cold-start case — entities with NULL last_reasoned_at and zero
--      reasoning_reports rows referencing them. This is the get_reasoning_history
--      empty-result path AND the get_reasoning_targets prioritisation path
--      (entities with no prior reasoning bubble up in the score).
--
-- Schema reference:
--   src/db/schema.ts → entityMeta (last_reasoned_at timestamptz NULL)
--   src/db/schema.ts → reasoningReports (no rows for these entity_ids)
--
-- Used by: src/test/harness/reasoning-agent-surface.test.ts
--
-- UUID map:
--   Cold entity 1 : 79000000-0000-0000-0003-000000000001
--   Cold entity 2 : 79000000-0000-0000-0003-000000000002

BEGIN;

INSERT INTO public.entities (id, canonical_name, entity_type, embedding, confidence)
VALUES
  ('79000000-0000-0000-0003-000000000001', 'phase8-empty-1', 'concept',
   ARRAY(SELECT random() FROM generate_series(1, 768))::vector, 1.0),
  ('79000000-0000-0000-0003-000000000002', 'phase8-empty-2', 'concept',
   ARRAY(SELECT random() FROM generate_series(1, 768))::vector, 1.0)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.entity_meta (entity_id, last_reasoned_at)
VALUES
  ('79000000-0000-0000-0003-000000000001', NULL),
  ('79000000-0000-0000-0003-000000000002', NULL)
ON CONFLICT (entity_id) DO UPDATE SET last_reasoned_at = NULL;

COMMIT;
