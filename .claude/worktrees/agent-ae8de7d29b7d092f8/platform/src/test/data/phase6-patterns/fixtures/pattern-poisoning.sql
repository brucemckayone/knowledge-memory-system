-- pattern-poisoning.sql
-- Adversarial fixture for Phase 6 (Pattern Lifecycle)
--
-- Scenario: 100 chains with identical structure but semantically meaningless
-- predicates (predicate=foo for every event). detection should still cluster
-- and stage the pattern (the structure is real), but a downstream Haiku
-- naming attempt should produce a name reflecting the meaninglessness.
-- This fixture is the input to a naming-quality benchmark in nmemo-klv.6.
--
-- UUID convention:
--   Entities: 00000000-...-0000-poison-1xxx
--   Facts:    10000000-...-0000-poison-1xxx
--   Events:   20000000-...-0000-poison-1xxx
--   Edges:    30000000-...-0000-poison-1xxx
--
-- For G7 we ship the scaffold; the test-harden skill (nmemo-klv.6) evolves
-- the populated content during corpus-driven hardening cycles.

BEGIN;

-- Placeholder: a single 2-edge chain with predicate='foo' demonstrating the
-- shape. test-harden skill will evolve this to 100 chains.
INSERT INTO public.entities (id, canonical_name, entity_type, embedding, confidence) VALUES
  ('00000000-0000-0000-0000-000000003001', 'PoisonEntity1', 'noise', ARRAY(SELECT 0::float FROM generate_series(1, 768))::vector, 1.0),
  ('00000000-0000-0000-0000-000000003002', 'PoisonEntity2', 'noise', ARRAY(SELECT 0::float FROM generate_series(1, 768))::vector, 1.0),
  ('00000000-0000-0000-0000-000000003003', 'PoisonEntity3', 'noise', ARRAY(SELECT 0::float FROM generate_series(1, 768))::vector, 1.0)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.facts (id, subject_entity_id, predicate, object_entity_id, confidence, valid_at) VALUES
  ('10000000-0000-0000-0000-000000003001',
   '00000000-0000-0000-0000-000000003001', 'foo',
   '00000000-0000-0000-0000-000000003002', 0.5, NOW() - INTERVAL '1 day'),
  ('10000000-0000-0000-0000-000000003002',
   '00000000-0000-0000-0000-000000003002', 'foo',
   '00000000-0000-0000-0000-000000003003', 0.5, NOW() - INTERVAL '1 day'),
  ('10000000-0000-0000-0000-000000003003',
   '00000000-0000-0000-0000-000000003003', 'foo',
   '00000000-0000-0000-0000-000000003001', 0.5, NOW() - INTERVAL '1 day')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.causal_events (id, fact_id, transition_type, subject_entity_id, predicate, occurred_at) VALUES
  ('20000000-0000-0000-0000-000000003001', '10000000-0000-0000-0000-000000003001', 'created', '00000000-0000-0000-0000-000000003001', 'foo', NOW() - INTERVAL '1 day'),
  ('20000000-0000-0000-0000-000000003002', '10000000-0000-0000-0000-000000003002', 'created', '00000000-0000-0000-0000-000000003002', 'foo', NOW() - INTERVAL '1 day'),
  ('20000000-0000-0000-0000-000000003003', '10000000-0000-0000-0000-000000003003', 'created', '00000000-0000-0000-0000-000000003003', 'foo', NOW() - INTERVAL '1 day')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.causal_edges (id, cause_event_id, effect_event_id, strength, reasoning, source_references, extraction_method, initial_strength) VALUES
  ('30000000-0000-0000-0000-000000003001',
   '20000000-0000-0000-0000-000000003001', '20000000-0000-0000-0000-000000003002',
   0.5, 'noise edge 1', '[{"type":"memory","id":"00000000-0000-0000-0000-000000003001","relevance":"placeholder"}]'::jsonb,
   'llm', 0.5),
  ('30000000-0000-0000-0000-000000003002',
   '20000000-0000-0000-0000-000000003002', '20000000-0000-0000-0000-000000003003',
   0.5, 'noise edge 2', '[{"type":"memory","id":"00000000-0000-0000-0000-000000003002","relevance":"placeholder"}]'::jsonb,
   'llm', 0.5)
ON CONFLICT (id) DO NOTHING;

COMMIT;
