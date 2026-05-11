-- cyclic-no-span.sql
-- Level 1 fixture for Phase 5 (Contradiction Detection)
--
-- Scenario: Two active causal edges form a cycle (A→B and B→A) where
-- neither edge has a temporal_span. detectCyclicCausal() must flag.
--
-- Severity = 'medium' (modelling concern, not a hard violation).
--
-- UUID map:
--   Event A:   20000000-...-301
--   Event B:   20000000-...-302
--   Edge AB:   30000000-...-301  (A → B, no temporal_span)
--   Edge BA:   30000000-...-302  (B → A, no temporal_span)
--
-- Note: events do not require an entity (subject_entity_id is nullable);
-- this fixture deliberately omits entities for minimality.

BEGIN;
SET LOCAL session_replication_role = 'replica';

INSERT INTO public.causal_events (id, fact_id, transition_type, occurred_at) VALUES
  ('20000000-0000-0000-0000-000000000301', NULL, 'created', NOW() - INTERVAL '5 days'),
  ('20000000-0000-0000-0000-000000000302', NULL, 'created', NOW() - INTERVAL '5 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.causal_edges (
  id, cause_event_id, effect_event_id, strength, initial_strength,
  extraction_method, reasoning, source_references, corroboration_count, temporal_span
) VALUES
  (
    '30000000-0000-0000-0000-000000000301',
    '20000000-0000-0000-0000-000000000301',
    '20000000-0000-0000-0000-000000000302',
    0.7, 0.7, 'llm', 'A causes B', '[]'::jsonb, 1, NULL
  ),
  (
    '30000000-0000-0000-0000-000000000302',
    '20000000-0000-0000-0000-000000000302',
    '20000000-0000-0000-0000-000000000301',
    0.7, 0.7, 'llm', 'B causes A', '[]'::jsonb, 1, NULL
  )
ON CONFLICT (id) DO NOTHING;

COMMIT;
