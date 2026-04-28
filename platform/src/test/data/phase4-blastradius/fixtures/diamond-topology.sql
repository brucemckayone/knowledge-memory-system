-- diamond-topology.sql
-- Level 1 fixture for Phase 4
--
-- Scenario: Diamond — multi-path convergence.
--    E0 → E1 → E3
--    E0 → E2 → E3
-- The target edge E1→E3 is reachable from E0 by depth 2 via E1 and depth 2
-- via E2 (transitively through E2→E3 then to E1→E3 via 'alternate effect'
-- hop). DISTINCT ON (id) must keep the shortest reach.
--
-- UUID map:
--   Subject:  00000002-0000-0000-0000-000000000000
--   Fact:     10000002-0000-0000-0000-000000000000
--   Events:   20000002-0000-0000-0000-(00..03)
--   Edges:    30000002-0000-0000-0000-(01..04)

BEGIN;

INSERT INTO public.entities (id, canonical_name, entity_type, properties)
VALUES ('00000002-0000-0000-0000-000000000000', 'DiamondSubject', 'concept', '{}'::jsonb);

INSERT INTO public.facts (id, subject_entity_id, predicate, object_value)
VALUES (
  '10000002-0000-0000-0000-000000000000',
  '00000002-0000-0000-0000-000000000000',
  'in_state',
  'diamond'
);

INSERT INTO public.causal_events (id, fact_id, transition_type, subject_entity_id, predicate, source_text)
VALUES
  ('20000002-0000-0000-0000-000000000000', '10000002-0000-0000-0000-000000000000', 'created',      '00000002-0000-0000-0000-000000000000', 'in_state', 'E0'),
  ('20000002-0000-0000-0000-000000000001', '10000002-0000-0000-0000-000000000000', 'strengthened', '00000002-0000-0000-0000-000000000000', 'in_state', 'E1 (path A)'),
  ('20000002-0000-0000-0000-000000000002', '10000002-0000-0000-0000-000000000000', 'strengthened', '00000002-0000-0000-0000-000000000000', 'in_state', 'E2 (path B)'),
  ('20000002-0000-0000-0000-000000000003', '10000002-0000-0000-0000-000000000000', 'strengthened', '00000002-0000-0000-0000-000000000000', 'in_state', 'E3 (convergent)');

INSERT INTO public.causal_edges (
  id, cause_event_id, effect_event_id, strength, reasoning,
  source_references, extraction_method, corroboration_count, initial_strength
)
VALUES
  ('30000002-0000-0000-0000-000000000001', '20000002-0000-0000-0000-000000000000', '20000002-0000-0000-0000-000000000001', 0.7, 'E0->E1', '[]'::jsonb, 'manual', 1, 0.7),
  ('30000002-0000-0000-0000-000000000002', '20000002-0000-0000-0000-000000000000', '20000002-0000-0000-0000-000000000002', 0.7, 'E0->E2', '[]'::jsonb, 'manual', 1, 0.7),
  ('30000002-0000-0000-0000-000000000003', '20000002-0000-0000-0000-000000000001', '20000002-0000-0000-0000-000000000003', 0.7, 'E1->E3', '[]'::jsonb, 'manual', 1, 0.7),
  ('30000002-0000-0000-0000-000000000004', '20000002-0000-0000-0000-000000000002', '20000002-0000-0000-0000-000000000003', 0.7, 'E2->E3', '[]'::jsonb, 'manual', 1, 0.7);

COMMIT;
