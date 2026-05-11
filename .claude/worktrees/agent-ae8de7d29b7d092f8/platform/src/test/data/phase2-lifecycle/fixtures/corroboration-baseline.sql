-- corroboration-baseline.sql (v1.0)
-- Phase 2 (Edge Lifecycle) — corroboration starting state
-- Complexity: 4 (rows=5, edges=1, stressors=2)
-- Stressors:
--   1. exact-match corroboration target — same (cause_event_id, effect_event_id)
--      reseen by createCausalEdge increments corroboration_count + strength
--   2. base edge has corroboration_count=1, strength=0.5 — incoming
--      corroboration must produce count=2 and a strength delta
--
-- UUID map:
--   Entity                : 00000000-0000-0000-0000-000000000200
--   Fact                  : 10000000-0000-0000-0000-000000000200
--   cause_event           : 20000000-0000-0000-0000-000000000201
--   effect_event          : 20000000-0000-0000-0000-000000000202
--   base causal_edge      : 30000000-0000-0000-0000-000000000200

BEGIN;

INSERT INTO public.entities (id, canonical_name, entity_type, embedding, confidence)
VALUES
  ('00000000-0000-0000-0000-000000000200', 'CorroborationSubject', 'concept',
   ARRAY(SELECT random() FROM generate_series(1, 768))::vector, 1.0)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.facts (id, subject_entity_id, predicate, object_value, confidence, valid_at)
VALUES
  ('10000000-0000-0000-0000-000000000200',
   '00000000-0000-0000-0000-000000000200', 'is_cause_of', 'effect',
   0.7, NOW() - INTERVAL '7 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.causal_events (id, fact_id, transition_type, subject_entity_id, predicate, source_text, occurred_at)
VALUES
  ('20000000-0000-0000-0000-000000000201',
   '10000000-0000-0000-0000-000000000200', 'created',
   '00000000-0000-0000-0000-000000000200', 'is_cause_of',
   'baseline cause', NOW() - INTERVAL '5 days'),
  ('20000000-0000-0000-0000-000000000202',
   '10000000-0000-0000-0000-000000000200', 'expired',
   '00000000-0000-0000-0000-000000000200', 'is_cause_of',
   'baseline effect', NOW() - INTERVAL '4 days')
ON CONFLICT (id) DO NOTHING;

-- Base edge ready to be corroborated by an incoming createCausalEdge call
-- on the same (cause_event_id, effect_event_id) pair.
INSERT INTO public.causal_edges (
  id, cause_event_id, effect_event_id, strength, extraction_method,
  reasoning, source_references, corroboration_count, last_corroborated,
  initial_strength, decay_applied
)
VALUES
  ('30000000-0000-0000-0000-000000000200',
   '20000000-0000-0000-0000-000000000201',
   '20000000-0000-0000-0000-000000000202',
   0.5, 'llm',
   'baseline edge — initial assertion',
   '[{"type":"memory","id":"bbbbbbbb-0000-0000-0000-000000000200","relevance":"first source"}]'::jsonb,
   1, NOW() - INTERVAL '3 days',
   0.5, false)
ON CONFLICT DO NOTHING;

-- Created-row backfill so the audit trail is correct from t0.
INSERT INTO public.causal_edge_history (edge_id, event_type, new_strength, reasoning, actor, occurred_at)
VALUES
  ('30000000-0000-0000-0000-000000000200', 'created', 0.5,
   'baseline edge — initial assertion',
   'graph_agent', NOW() - INTERVAL '3 days');

COMMIT;
