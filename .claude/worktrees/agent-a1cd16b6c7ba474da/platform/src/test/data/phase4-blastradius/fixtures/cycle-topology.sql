-- cycle-topology.sql
-- Level 1 edge fixture for Phase 4
--
-- Scenario: 3-node causal cycle.
--   E0 → E1 → E2 → E0 (without temporal_span — Phase 5 detectCyclicCausal flags this)
--
-- Used to verify the path-accumulator cycle protection terminates the
-- recursive walk cleanly. Each cycle edge appears at most once in the
-- transitive chain (DISTINCT ON id).
--
-- UUID map:
--   Subject:  00000003-0000-0000-0000-000000000000
--   Fact:     10000003-0000-0000-0000-000000000000
--   Events:   20000003-0000-0000-0000-00000000000{0,1,2}
--   Edges:    30000003-0000-0000-0000-00000000000{1,2,3}

BEGIN;

INSERT INTO public.entities (id, canonical_name, entity_type, properties)
VALUES ('00000003-0000-0000-0000-000000000000', 'CycleSubject', 'concept', '{}'::jsonb);

INSERT INTO public.facts (id, subject_entity_id, predicate, object_value)
VALUES (
  '10000003-0000-0000-0000-000000000000',
  '00000003-0000-0000-0000-000000000000',
  'cycles',
  'true'
);

INSERT INTO public.causal_events (id, fact_id, transition_type, subject_entity_id, predicate, source_text)
VALUES
  ('20000003-0000-0000-0000-000000000000', '10000003-0000-0000-0000-000000000000', 'created',      '00000003-0000-0000-0000-000000000000', 'cycles', 'cycle E0'),
  ('20000003-0000-0000-0000-000000000001', '10000003-0000-0000-0000-000000000000', 'strengthened', '00000003-0000-0000-0000-000000000000', 'cycles', 'cycle E1'),
  ('20000003-0000-0000-0000-000000000002', '10000003-0000-0000-0000-000000000000', 'strengthened', '00000003-0000-0000-0000-000000000000', 'cycles', 'cycle E2');

INSERT INTO public.causal_edges (
  id, cause_event_id, effect_event_id, strength, reasoning,
  source_references, extraction_method, corroboration_count, initial_strength
)
VALUES
  ('30000003-0000-0000-0000-000000000001', '20000003-0000-0000-0000-000000000000', '20000003-0000-0000-0000-000000000001', 0.7, 'A->B', '[]'::jsonb, 'manual', 1, 0.7),
  ('30000003-0000-0000-0000-000000000002', '20000003-0000-0000-0000-000000000001', '20000003-0000-0000-0000-000000000002', 0.7, 'B->C', '[]'::jsonb, 'manual', 1, 0.7),
  ('30000003-0000-0000-0000-000000000003', '20000003-0000-0000-0000-000000000002', '20000003-0000-0000-0000-000000000000', 0.7, 'C->A (cycle)', '[]'::jsonb, 'manual', 1, 0.7);

COMMIT;
