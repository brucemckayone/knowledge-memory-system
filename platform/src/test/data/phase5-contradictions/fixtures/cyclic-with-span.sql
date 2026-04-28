-- cyclic-with-span.sql
-- Level 1 fixture (negative case) for Phase 5 (Contradiction Detection)
--
-- Scenario: Two active causal edges form a cycle (A→B and B→A) but BOTH
-- have a temporal_span set. detectCyclicCausal() must NOT flag — temporal
-- separation makes the cycle a legitimate periodic-feedback model.
--
-- UUID map:
--   Event A:   20000000-...-401
--   Event B:   20000000-...-402
--   Edge AB:   30000000-...-401  (A → B, temporal_span=P1D)
--   Edge BA:   30000000-...-402  (B → A, temporal_span=P1D)

BEGIN;
SET LOCAL session_replication_role = 'replica';

INSERT INTO public.causal_events (id, fact_id, transition_type, occurred_at) VALUES
  ('20000000-0000-0000-0000-000000000401', NULL, 'created', NOW() - INTERVAL '5 days'),
  ('20000000-0000-0000-0000-000000000402', NULL, 'created', NOW() - INTERVAL '5 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.causal_edges (
  id, cause_event_id, effect_event_id, strength, initial_strength,
  extraction_method, reasoning, source_references, corroboration_count, temporal_span
) VALUES
  (
    '30000000-0000-0000-0000-000000000401',
    '20000000-0000-0000-0000-000000000401',
    '20000000-0000-0000-0000-000000000402',
    0.7, 0.7, 'llm', 'A causes B over 1 day', '[]'::jsonb, 1, INTERVAL '1 day'
  ),
  (
    '30000000-0000-0000-0000-000000000402',
    '20000000-0000-0000-0000-000000000402',
    '20000000-0000-0000-0000-000000000401',
    0.7, 0.7, 'llm', 'B causes A over 1 day', '[]'::jsonb, 1, INTERVAL '1 day'
  )
ON CONFLICT (id) DO NOTHING;

COMMIT;
