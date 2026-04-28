-- deep-cycle-depth-20.sql
-- Adversarial fixture for Phase 4
--
-- Scenario: A 20-node causal cycle. The path-accumulator cycle protection
-- on findTransitiveChains' recursive CTE must terminate without revisiting
-- any of the 20 edges, regardless of how high maxDepth is set.
--
--   E0 → E1 → E2 → ... → E19 → E0
--
-- Verifies:
--   - terminates without infinite loop
--   - all 20 edges appear at most once in transitiveChains (DISTINCT ON id)
--   - response time stays under 1s even at maxDepth=10
--
-- UUID space:
--   Subject:  00000006-0000-0000-0000-000000000000
--   Fact:     10000006-0000-0000-0000-000000000000
--   Events:   20000006-0000-0000-0000-(00..13)  -- 20 events (hex 00..13)
--   Edges:    30000006-0000-0000-0000-(00..13)  -- 20 cycle edges (hex 00..13)

BEGIN;

INSERT INTO public.entities (id, canonical_name, entity_type, properties)
VALUES ('00000006-0000-0000-0000-000000000000', 'DeepCycleSubject', 'concept', '{}'::jsonb);

INSERT INTO public.facts (id, subject_entity_id, predicate, object_value)
VALUES (
  '10000006-0000-0000-0000-000000000000',
  '00000006-0000-0000-0000-000000000000',
  'cycles',
  'deep'
);

-- 20 events
INSERT INTO public.causal_events (id, fact_id, transition_type, subject_entity_id, predicate, source_text)
SELECT
  ('20000006-0000-0000-0000-' || lpad(to_hex(i), 12, '0'))::uuid,
  '10000006-0000-0000-0000-000000000000'::uuid,
  CASE WHEN i = 0 THEN 'created' ELSE 'strengthened' END,
  '00000006-0000-0000-0000-000000000000'::uuid,
  'cycles',
  'deep cycle node ' || i::text
FROM generate_series(0, 19) AS i;

-- 20 cycle edges: E_i -> E_{(i+1) mod 20}
INSERT INTO public.causal_edges (
  id, cause_event_id, effect_event_id, strength, reasoning,
  source_references, extraction_method, corroboration_count, initial_strength
)
SELECT
  ('30000006-0000-0000-0000-' || lpad(to_hex(i), 12, '0'))::uuid,
  ('20000006-0000-0000-0000-' || lpad(to_hex(i), 12, '0'))::uuid,
  ('20000006-0000-0000-0000-' || lpad(to_hex((i+1) % 20), 12, '0'))::uuid,
  0.7,
  'deep cycle edge ' || i::text,
  '[]'::jsonb,
  'manual',
  1,
  0.7
FROM generate_series(0, 19) AS i;

COMMIT;
