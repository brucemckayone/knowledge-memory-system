-- MUST FAIL: tests business rule — a cascade edge_history row requires an upstream mutation chain; a NULL reasoning_report_id + no prior parent mutation violates the invariant even if the DB permits NULL.
-- cascade-writes-cascade-without-parent.sql
-- Phase 1 adversarial variant — parentless cascade
-- Complexity score: 22 (rows=6, edges=1, stressors=1, adversarial-weighted)
-- Stressors: adversarial-semantic=orphan-cascade-no-parent
--
-- UUID map: reuses cascade-writes seed.
-- Adversarial delta: 60000000-0000-0000-0000-00000000beef parentless cascade row

BEGIN;

INSERT INTO public.entities (id, canonical_name, entity_type, embedding, confidence) VALUES
  ('00000000-0000-0000-0000-000000000001', 'Alpha Corp', 'company', ARRAY(SELECT random() FROM generate_series(1, 768))::vector, 1.0),
  ('00000000-0000-0000-0000-000000000002', 'ProductX',   'product', ARRAY(SELECT random() FROM generate_series(1, 768))::vector, 1.0)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.facts (id, subject_entity_id, predicate, object_entity_id, confidence, valid_at) VALUES
  ('10000000-0000-0000-0000-000000000001',
   '00000000-0000-0000-0000-000000000001', 'manufactures',
   '00000000-0000-0000-0000-000000000002', 0.9, NOW())
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.causal_events (id, fact_id, event_type, description, occurred_at) VALUES
  ('20000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', 'fact_asserted',
   'Upstream fact observation', NOW())
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.causal_edges
  (id, cause_event_id, effect_event_id, strength, reasoning, source_references, created_at) VALUES
  ('30000000-0000-0000-0000-000000000001',
   '20000000-0000-0000-0000-000000000001',
   '20000000-0000-0000-0000-000000000001',
   0.80, 'Seed edge', '[]'::jsonb, NOW())
ON CONFLICT (id) DO NOTHING;

-- ADVERSARIAL DELTA: cascade row with NO parent mutation and NULL report ---
-- STRESSOR: adversarial-semantic=orphan-cascade-no-parent
-- DB may permit NULL reasoning_report_id; the test layer must flag actor=cascade
-- lacking any upstream mutation chain.
INSERT INTO public.causal_edge_history
  (id, edge_id, event_type, previous_strength, new_strength,
   reasoning, reasoning_report_id, actor, occurred_at) VALUES
  ('60000000-0000-0000-0000-00000000beef',
   '30000000-0000-0000-0000-000000000001',
   'weakened', 0.80, 0.55,
   'Cascade row asserted without any upstream mutation — business rule violation',
   NULL,
   'cascade',
   NOW());

COMMIT;
