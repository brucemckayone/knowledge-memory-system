-- temporal-impossible.sql
-- Level 1 fixture for Phase 5 (Contradiction Detection)
--
-- Scenario: Active causal edge whose cause event's occurred_at is AFTER
-- the effect event's occurred_at. detectTemporalImpossible() must flag
-- with severity='high' (effect cannot precede cause).
--
-- UUID map:
--   Event Cause:    20000000-...-501  (occurred 2026-04-20 — LATER)
--   Event Effect:   20000000-...-502  (occurred 2026-04-10 — EARLIER)
--   Edge:           30000000-...-501  (cause → effect — temporally impossible)

BEGIN;
SET LOCAL session_replication_role = 'replica';

INSERT INTO public.causal_events (id, fact_id, transition_type, occurred_at) VALUES
  ('20000000-0000-0000-0000-000000000501', NULL, 'created', '2026-04-20 12:00:00+00'),
  ('20000000-0000-0000-0000-000000000502', NULL, 'created', '2026-04-10 12:00:00+00')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.causal_edges (
  id, cause_event_id, effect_event_id, strength, initial_strength,
  extraction_method, reasoning, source_references, corroboration_count
) VALUES (
  '30000000-0000-0000-0000-000000000501',
  '20000000-0000-0000-0000-000000000501',
  '20000000-0000-0000-0000-000000000502',
  0.7, 0.7, 'llm', 'cause asserted to drive effect', '[]'::jsonb, 1
)
ON CONFLICT (id) DO NOTHING;

COMMIT;
