-- expired-but-cited.sql
-- Level 1 fixture for Phase 5 (Contradiction Detection)
--
-- Scenario: an active causal_edge whose edge_source_refs row of type 'fact'
-- points at a fact that has been expired. detectExpiredButCited() must flag.
--
-- corroboration_count = 1 → expected severity = 'high' (sole source).
--
-- UUID map:
--   Entity X:  00000000-...-201
--   Entity Y:  00000000-...-202
--   Fact F1:   10000000-...-701  (expired — was: X-relates_to-Y)
--   Event E1:  20000000-...-201  (cause)
--   Event E2:  20000000-...-202  (effect)
--   Edge ED1:  30000000-...-201  (active, cites F1 as evidence)

BEGIN;
SET LOCAL session_replication_role = 'replica';

INSERT INTO public.entities (id, canonical_name, entity_type, embedding, confidence) VALUES
  ('00000000-0000-0000-0000-000000000201', 'Entity-X', 'concept', ARRAY(SELECT random() FROM generate_series(1, 768))::vector, 1.0),
  ('00000000-0000-0000-0000-000000000202', 'Entity-Y', 'concept', ARRAY(SELECT random() FROM generate_series(1, 768))::vector, 1.0)
ON CONFLICT (id) DO NOTHING;

-- Expired fact (the cited evidence)
INSERT INTO public.facts (id, subject_entity_id, predicate, object_entity_id, confidence, valid_at, expired_at, expire_reason) VALUES
  ('10000000-0000-0000-0000-000000000701',
   '00000000-0000-0000-0000-000000000201', 'relates_to',
   '00000000-0000-0000-0000-000000000202', 0.85,
   NOW() - INTERVAL '10 days', NOW() - INTERVAL '1 day',
   'manual: superseded by reanalysis')
ON CONFLICT (id) DO NOTHING;

-- Two events for the edge endpoints (transition_type='created')
INSERT INTO public.causal_events (id, fact_id, transition_type, subject_entity_id, predicate, occurred_at) VALUES
  ('20000000-0000-0000-0000-000000000201', NULL, 'created',
   '00000000-0000-0000-0000-000000000201', 'relates_to',
   NOW() - INTERVAL '8 days'),
  ('20000000-0000-0000-0000-000000000202', NULL, 'created',
   '00000000-0000-0000-0000-000000000202', 'relates_to',
   NOW() - INTERVAL '7 days')
ON CONFLICT (id) DO NOTHING;

-- Active causal edge — sole source is the now-expired fact F1
INSERT INTO public.causal_edges (
  id, cause_event_id, effect_event_id, strength, initial_strength,
  extraction_method, reasoning, source_references, corroboration_count
) VALUES (
  '30000000-0000-0000-0000-000000000201',
  '20000000-0000-0000-0000-000000000201',
  '20000000-0000-0000-0000-000000000202',
  0.75, 0.75,
  'llm',
  'X relates to Y based on fact F1',
  '[{"type":"fact","id":"10000000-0000-0000-0000-000000000701","relevance":"sole evidence"}]'::jsonb,
  1
)
ON CONFLICT (id) DO NOTHING;

-- Reverse-lookup index entry (Phase 3) — must match for detectExpiredButCited
INSERT INTO public.edge_source_refs (edge_id, ref_type, ref_id, relevance) VALUES
  ('30000000-0000-0000-0000-000000000201', 'fact',
   '10000000-0000-0000-0000-000000000701', 'sole evidence')
ON CONFLICT (edge_id, ref_type, ref_id) DO NOTHING;

COMMIT;
