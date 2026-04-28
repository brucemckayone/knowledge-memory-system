-- ghost-flood.sql
-- Adversarial fixture for Phase 6 (Pattern Lifecycle)
--
-- Scenario: a high-fan-out entity participates in 50 partial chains across
-- 50 canonical patterns. findCausalGhosts must (a) terminate quickly, (b)
-- return the top-K (default 10) sorted by confidence, (c) not crash on any
-- single malformed pattern.
--
-- UUID convention:
--   Entities: 00000000-...-0000-flood-axxx
--   Patterns: 40000000-...-0000-flood-axxx
--
-- For G7 we ship the scaffold; the test-harden skill (nmemo-klv.6) evolves
-- this to 50 canonical patterns and 50 partial chains during hardening.

BEGIN;

-- Placeholder: a single canonical pattern + a single partial chain
-- demonstrating the structure that test-harden will multiply.
INSERT INTO public.entities (id, canonical_name, entity_type, embedding, confidence) VALUES
  ('00000000-0000-0000-0000-0000000040a1', 'FloodHubEntity', 'standard_rule', ARRAY(SELECT 0::float FROM generate_series(1, 768))::vector, 1.0),
  ('00000000-0000-0000-0000-0000000040a2', 'FloodNeighbour1', 'standard_rule', ARRAY(SELECT 0::float FROM generate_series(1, 768))::vector, 1.0),
  ('00000000-0000-0000-0000-0000000040a3', 'FloodNeighbour2', 'standard_rule', ARRAY(SELECT 0::float FROM generate_series(1, 768))::vector, 1.0)
ON CONFLICT (id) DO NOTHING;

-- Canonical pattern with template length 3 (2 edges)
INSERT INTO public.causal_patterns (id, name, description, template_structure, template_length, status,
                                     instance_count, avg_strength, first_seen_at, last_seen_at, promoted_at)
VALUES
  ('40000000-0000-0000-0000-0000000040a1',
   'FloodPattern1',
   'Adversarial canonical pattern for ghost flood test',
   '[{"entity_type":"standard_rule","predicate_category":"flood_a"},
     {"entity_type":"standard_rule","predicate_category":"flood_b"},
     {"entity_type":"standard_rule","predicate_category":"flood_c"}]'::jsonb,
   3, 'canonical',
   20, 0.85, NOW() - INTERVAL '40 days', NOW() - INTERVAL '1 day', NOW() - INTERVAL '30 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.facts (id, subject_entity_id, predicate, object_entity_id, confidence, valid_at) VALUES
  ('10000000-0000-0000-0000-0000000040a1', '00000000-0000-0000-0000-0000000040a1', 'flood_a', '00000000-0000-0000-0000-0000000040a2', 0.9, NOW() - INTERVAL '5 days'),
  ('10000000-0000-0000-0000-0000000040a2', '00000000-0000-0000-0000-0000000040a2', 'flood_b', '00000000-0000-0000-0000-0000000040a3', 0.9, NOW() - INTERVAL '5 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.causal_events (id, fact_id, transition_type, subject_entity_id, predicate, occurred_at) VALUES
  ('20000000-0000-0000-0000-0000000040a1', '10000000-0000-0000-0000-0000000040a1', 'created', '00000000-0000-0000-0000-0000000040a1', 'flood_a', NOW() - INTERVAL '5 days'),
  ('20000000-0000-0000-0000-0000000040a2', '10000000-0000-0000-0000-0000000040a2', 'created', '00000000-0000-0000-0000-0000000040a2', 'flood_b', NOW() - INTERVAL '5 days')
ON CONFLICT (id) DO NOTHING;

-- Partial chain — covers position 0 only, leaving position 1 as a ghost
INSERT INTO public.causal_edges (id, cause_event_id, effect_event_id, strength, reasoning, source_references,
                                  extraction_method, initial_strength, pattern_id, pattern_position) VALUES
  ('30000000-0000-0000-0000-0000000040a1',
   '20000000-0000-0000-0000-0000000040a1', '20000000-0000-0000-0000-0000000040a2',
   0.85, 'flood pattern step 0',
   '[{"type":"memory","id":"00000000-0000-0000-0000-0000000040a1","relevance":"flood seed"}]'::jsonb,
   'llm', 0.85,
   '40000000-0000-0000-0000-0000000040a1', 0)
ON CONFLICT (id) DO NOTHING;

COMMIT;
