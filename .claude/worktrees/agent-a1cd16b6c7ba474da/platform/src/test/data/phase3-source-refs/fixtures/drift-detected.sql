-- drift-detected.sql (v1.0)
-- Phase 3 (Source Reference Indexing) — adversarial: deliberate drift
-- between causal_edges.source_references (JSONB) and edge_source_refs (index).
-- Validates that the drift query DETECTS drift (the existing wired test
-- proves it returns 0 on a clean graph; this fixture proves it returns >0
-- when the index is out of sync).
-- Complexity: 5 (rows=4, edges=2, stressors=2)
-- Stressors:
--   1. JSONB-side ref with no index row (forward drift)
--   2. Two edges, only one drifted, to verify the count is not over-broad
--
-- UUID map:
--   Entity                       : 00000000-0000-0000-0000-000000000600
--   Fact                         : 10000000-0000-0000-0000-000000000600
--   cause/effect events 1, 2     : 20000000-0000-0000-0003-00000000000{1..4}
--   clean edge (no drift)        : 30000000-0000-0000-0002-000000000001
--   drift edge (jsonb has 1, index has 0): 30000000-0000-0000-0002-000000000002
--   drifted memory ref           : aaaaaaaa-cccc-cccc-cccc-000000000001

BEGIN;

INSERT INTO public.entities (id, canonical_name, entity_type, embedding, confidence)
VALUES
  ('00000000-0000-0000-0000-000000000600', 'DriftEntity', 'concept',
   ARRAY(SELECT random() FROM generate_series(1, 768))::vector, 1.0)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.facts (id, subject_entity_id, predicate, object_value, confidence)
VALUES
  ('10000000-0000-0000-0000-000000000600',
   '00000000-0000-0000-0000-000000000600', 'drift_test', 'value', 0.5)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.causal_events (id, fact_id, transition_type, source_text)
VALUES
  ('20000000-0000-0000-0003-000000000001', '10000000-0000-0000-0000-000000000600', 'created',  'clean cause'),
  ('20000000-0000-0000-0003-000000000002', '10000000-0000-0000-0000-000000000600', 'expired',  'clean effect'),
  ('20000000-0000-0000-0003-000000000003', '10000000-0000-0000-0000-000000000600', 'created',  'drift cause'),
  ('20000000-0000-0000-0003-000000000004', '10000000-0000-0000-0000-000000000600', 'expired',  'drift effect')
ON CONFLICT (id) DO NOTHING;

-- Clean edge: JSONB and index agree (one ref each).
INSERT INTO public.causal_edges (
  id, cause_event_id, effect_event_id, strength, extraction_method,
  reasoning, source_references, corroboration_count, last_corroborated,
  initial_strength, decay_applied
) VALUES (
  '30000000-0000-0000-0002-000000000001',
  '20000000-0000-0000-0003-000000000001',
  '20000000-0000-0000-0003-000000000002',
  0.5, 'llm', 'clean edge — no drift',
  '[{"type":"memory","id":"aaaaaaaa-bbbb-bbbb-bbbb-000000000001","relevance":"clean"}]'::jsonb,
  1, NOW() - INTERVAL '1 day',
  0.5, false
) ON CONFLICT DO NOTHING;

INSERT INTO public.edge_source_refs (edge_id, ref_type, ref_id, relevance)
VALUES
  ('30000000-0000-0000-0002-000000000001', 'memory',
   'aaaaaaaa-bbbb-bbbb-bbbb-000000000001', 'clean')
ON CONFLICT DO NOTHING;

-- Drift edge: JSONB has one ref, index intentionally has zero. The drift
-- query must surface this as +1 dangling JSONB ref.
INSERT INTO public.causal_edges (
  id, cause_event_id, effect_event_id, strength, extraction_method,
  reasoning, source_references, corroboration_count, last_corroborated,
  initial_strength, decay_applied
) VALUES (
  '30000000-0000-0000-0002-000000000002',
  '20000000-0000-0000-0003-000000000003',
  '20000000-0000-0000-0003-000000000004',
  0.5, 'llm', 'drift edge — index missing',
  '[{"type":"memory","id":"aaaaaaaa-cccc-cccc-cccc-000000000001","relevance":"drifted"}]'::jsonb,
  1, NOW() - INTERVAL '1 day',
  0.5, false
) ON CONFLICT DO NOTHING;

-- (No edge_source_refs insert for the drift edge — that's the point.)

INSERT INTO public.causal_edge_history (edge_id, event_type, new_strength, reasoning, actor, occurred_at)
VALUES
  ('30000000-0000-0000-0002-000000000001', 'created', 0.5,
   'pre-seeded for drift-detected', 'graph_agent', NOW() - INTERVAL '1 day'),
  ('30000000-0000-0000-0002-000000000002', 'created', 0.5,
   'pre-seeded for drift-detected', 'graph_agent', NOW() - INTERVAL '1 day');

COMMIT;
