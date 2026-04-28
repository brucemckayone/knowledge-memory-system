-- linear-chain-depth-10.sql
-- Level 1 fixture for Phase 4
--
-- Scenario: A 10-node linear causal chain on a single fact.
--   E0 → E1 → E2 → ... → E9
-- Used to verify maxDepth respects the cap and the recursive walk surfaces
-- depth-1..depth-N nodes consistently.
--
-- UUID map:
--   Subject:  00000001-0000-0000-0000-000000000000
--   Fact:     10000001-0000-0000-0000-000000000000
--   Events:   20000001-...-NN  (NN = 00..09)
--   Edges:    30000001-...-NN  (NN = 00..08)

BEGIN;

INSERT INTO public.entities (id, canonical_name, entity_type, properties)
VALUES ('00000001-0000-0000-0000-000000000000', 'ChainSubject', 'person', '{}'::jsonb);

INSERT INTO public.facts (id, subject_entity_id, predicate, object_value)
VALUES (
  '10000001-0000-0000-0000-000000000000',
  '00000001-0000-0000-0000-000000000000',
  'has_status',
  'evolving'
);

-- Generate 10 causal events for this fact
INSERT INTO public.causal_events (id, fact_id, transition_type, subject_entity_id, predicate, source_text)
SELECT
  ('20000001-0000-0000-0000-' || lpad(i::text, 12, '0'))::uuid,
  '10000001-0000-0000-0000-000000000000'::uuid,
  CASE WHEN i = 0 THEN 'created' ELSE 'strengthened' END,
  '00000001-0000-0000-0000-000000000000'::uuid,
  'has_status',
  'linear chain step ' || i::text
FROM generate_series(0, 9) AS i;

-- Chain edges E_i -> E_{i+1}
INSERT INTO public.causal_edges (
  id, cause_event_id, effect_event_id, strength, reasoning,
  source_references, extraction_method, corroboration_count, initial_strength
)
SELECT
  ('30000001-0000-0000-0000-' || lpad(i::text, 12, '0'))::uuid,
  ('20000001-0000-0000-0000-' || lpad(i::text, 12, '0'))::uuid,
  ('20000001-0000-0000-0000-' || lpad((i+1)::text, 12, '0'))::uuid,
  0.7,
  'chain step ' || i::text,
  '[]'::jsonb,
  'manual',
  1,
  0.7
FROM generate_series(0, 8) AS i;

COMMIT;
