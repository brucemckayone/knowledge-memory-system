-- concurrent-races-flood.sql (stressor, not adversarial)
-- Phase 1 — mutation-volume hardening variant
-- Complexity score: 14 (rows=3, edges=0, stressors=2)
-- Stressors: concurrency=1000, single-fact-mutation-flood=1000
--
-- UUID map:
--   00000000-0000-0000-0000-0000000000f1  subject entity
--   00000000-0000-0000-0000-0000000001f1  object entity
--   10000000-0000-0000-0000-0000000000f1  the single fact under flood
--
-- Harness contract:
--   After loading, spawn 1000 parallel workers. Each issues a
--   updateFactConfidence against the SAME fact_id. Deltas alternate +0.01 /
--   -0.01 starting from 0.50. Each worker reasoning = 'flood-iter-<N>'.
--   Expected: exactly 1000 fact_history rows with event_type IN
--   ('confidence_raised','confidence_lowered'); 0 lost; actor attribution
--   preserved. Final fact.confidence is non-deterministic under serial
--   relaxation — the assertion is row-count preservation, not state convergence.

BEGIN;

INSERT INTO public.entities (id, canonical_name, entity_type, embedding, confidence) VALUES
  ('00000000-0000-0000-0000-0000000000f1', 'flood_subject', 'person',  ARRAY(SELECT random() FROM generate_series(1, 768))::vector, 0.90),
  ('00000000-0000-0000-0000-0000000001f1', 'flood_object',  'company', ARRAY(SELECT random() FROM generate_series(1, 768))::vector, 0.90)
ON CONFLICT (id) DO NOTHING;

-- STRESSOR: single-fact-mutation-flood=1000
INSERT INTO public.facts (id, subject_entity_id, predicate, object_entity_id, confidence, valid_at)
VALUES (
  '10000000-0000-0000-0000-0000000000f1',
  '00000000-0000-0000-0000-0000000000f1',
  'works_at',
  '00000000-0000-0000-0000-0000000001f1',
  0.50,
  NOW()
) ON CONFLICT (id) DO NOTHING;

COMMIT;

-- STRESSOR: concurrency=1000
-- Harness executes 1000 parallel confidence mutations against fact
-- 10000000-0000-0000-0000-0000000000f1. Expected: exactly 1000 fact_history
-- rows post-run with previous_confidence / new_confidence both non-null.
