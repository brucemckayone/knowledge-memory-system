-- corroboration-storm-precondition.sql (v1.0)
-- Phase 2 (Edge Lifecycle) — adversarial: corroboration storm precondition
-- Complexity: 3 (rows=4, edges=0, stressors=1)
-- Stressors:
--   1. unique-constraint pressure: storm of 50 createCausalEdge calls on
--      the same (cause_event_id, effect_event_id) pair must produce
--      exactly one edge with corroboration_count=50, not 50 separate edges
--      or unique-violation errors. This fixture only seeds the cause/effect
--      pair — the test driver hits createCausalEdge in a tight loop.
--
-- UUID map:
--   Entity         : 00000000-0000-0000-0000-000000000400
--   Fact           : 10000000-0000-0000-0000-000000000400
--   cause_event    : 20000000-0000-0000-0000-000000000401
--   effect_event   : 20000000-0000-0000-0000-000000000402

BEGIN;

INSERT INTO public.entities (id, canonical_name, entity_type, embedding, confidence)
VALUES
  ('00000000-0000-0000-0000-000000000400', 'StormSubject', 'concept',
   ARRAY(SELECT random() FROM generate_series(1, 768))::vector, 1.0)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.facts (id, subject_entity_id, predicate, object_value, confidence)
VALUES
  ('10000000-0000-0000-0000-000000000400',
   '00000000-0000-0000-0000-000000000400', 'storm_test', 'value', 0.5)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.causal_events (id, fact_id, transition_type, subject_entity_id, predicate, source_text)
VALUES
  ('20000000-0000-0000-0000-000000000401',
   '10000000-0000-0000-0000-000000000400', 'created',
   '00000000-0000-0000-0000-000000000400', 'storm_test', 'storm cause'),
  ('20000000-0000-0000-0000-000000000402',
   '10000000-0000-0000-0000-000000000400', 'expired',
   '00000000-0000-0000-0000-000000000400', 'storm_test', 'storm effect')
ON CONFLICT (id) DO NOTHING;

COMMIT;
