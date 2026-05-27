-- emergence-corpus.sql
-- Level 3 fixture for Phase 6 (Pattern Lifecycle) — nmemo-klv.6 graduation corpus.
--
-- Purpose: a small, curated pattern-emergence corpus that exercises the three
-- corpus shapes called out in klv.6's body — identical chains (staging-promotion
-- path), noisy chains (normalisation edge cases), partial chains (ghost
-- detection) — all in one fixture so a single load reproduces the lifecycle
-- end-to-end.
--
-- Composition:
--   - 3 identical 2-edge chains   → meets the staging threshold; should cluster
--                                   to ONE template
--   - 2 noisy near-miss chains    → same predicate strings but different
--                                   entity_type at one position; should NOT
--                                   collapse into the identical-chain cluster
--                                   (normalisation isolation)
--   - 1 partial chain (N-1 of N)  → covers position 0 of a canonical 3-window
--                                   pattern; participates in ghost detection
--
-- UUID convention:
--   Entities:      00000000-...-eee-<group>-<k>-<pos>
--   Facts:         10000000-...-eee-<group>-<k>-<pos>
--   Causal events: 20000000-...-eee-<group>-<k>-<pos>
--   Causal edges:  30000000-...-eee-<group>-<k>-<idx>
--   Patterns:      40000000-...-eee-canonical-<k>
--
-- Use by `test-harden` and viz panels: load this fixture, run
-- detectCausalPatterns() + promotePatterns() + findCausalGhosts() and the
-- expected emergent state (per the .expected.json sibling) should hold.

BEGIN;

-- ============================================
-- GROUP A — three identical chains (staging promotion)
--   Template: [standard_rule] --requires--> [standard_rule] --prevents--> [compliance_practice]
-- ============================================

INSERT INTO public.entities (id, canonical_name, entity_type, embedding, confidence) VALUES
  ('00000000-0000-0000-eeea-000000000a00', 'EmergenceRuleA0-pos0', 'standard_rule',       ARRAY(SELECT 0::float FROM generate_series(1, 768))::vector, 1.0),
  ('00000000-0000-0000-eeea-000000000a01', 'EmergenceRuleA0-pos1', 'standard_rule',       ARRAY(SELECT 0::float FROM generate_series(1, 768))::vector, 1.0),
  ('00000000-0000-0000-eeea-000000000a02', 'EmergenceRuleA0-pos2', 'compliance_practice', ARRAY(SELECT 0::float FROM generate_series(1, 768))::vector, 1.0),
  ('00000000-0000-0000-eeea-000000000a10', 'EmergenceRuleA1-pos0', 'standard_rule',       ARRAY(SELECT 0::float FROM generate_series(1, 768))::vector, 1.0),
  ('00000000-0000-0000-eeea-000000000a11', 'EmergenceRuleA1-pos1', 'standard_rule',       ARRAY(SELECT 0::float FROM generate_series(1, 768))::vector, 1.0),
  ('00000000-0000-0000-eeea-000000000a12', 'EmergenceRuleA1-pos2', 'compliance_practice', ARRAY(SELECT 0::float FROM generate_series(1, 768))::vector, 1.0),
  ('00000000-0000-0000-eeea-000000000a20', 'EmergenceRuleA2-pos0', 'standard_rule',       ARRAY(SELECT 0::float FROM generate_series(1, 768))::vector, 1.0),
  ('00000000-0000-0000-eeea-000000000a21', 'EmergenceRuleA2-pos1', 'standard_rule',       ARRAY(SELECT 0::float FROM generate_series(1, 768))::vector, 1.0),
  ('00000000-0000-0000-eeea-000000000a22', 'EmergenceRuleA2-pos2', 'compliance_practice', ARRAY(SELECT 0::float FROM generate_series(1, 768))::vector, 1.0)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.facts (id, subject_entity_id, predicate, object_entity_id, confidence, valid_at) VALUES
  ('10000000-0000-0000-eeea-000000000a00', '00000000-0000-0000-eeea-000000000a00', 'requires', '00000000-0000-0000-eeea-000000000a01', 0.9, NOW() - INTERVAL '7 days'),
  ('10000000-0000-0000-eeea-000000000a01', '00000000-0000-0000-eeea-000000000a01', 'prevents', '00000000-0000-0000-eeea-000000000a02', 0.9, NOW() - INTERVAL '7 days'),
  ('10000000-0000-0000-eeea-000000000a10', '00000000-0000-0000-eeea-000000000a10', 'requires', '00000000-0000-0000-eeea-000000000a11', 0.9, NOW() - INTERVAL '6 days'),
  ('10000000-0000-0000-eeea-000000000a11', '00000000-0000-0000-eeea-000000000a11', 'prevents', '00000000-0000-0000-eeea-000000000a12', 0.9, NOW() - INTERVAL '6 days'),
  ('10000000-0000-0000-eeea-000000000a20', '00000000-0000-0000-eeea-000000000a20', 'requires', '00000000-0000-0000-eeea-000000000a21', 0.9, NOW() - INTERVAL '5 days'),
  ('10000000-0000-0000-eeea-000000000a21', '00000000-0000-0000-eeea-000000000a21', 'prevents', '00000000-0000-0000-eeea-000000000a22', 0.9, NOW() - INTERVAL '5 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.causal_events (id, fact_id, transition_type, subject_entity_id, predicate, occurred_at) VALUES
  ('20000000-0000-0000-eeea-000000000a00', '10000000-0000-0000-eeea-000000000a00', 'created', '00000000-0000-0000-eeea-000000000a00', 'requires', NOW() - INTERVAL '7 days'),
  ('20000000-0000-0000-eeea-000000000a01', '10000000-0000-0000-eeea-000000000a01', 'created', '00000000-0000-0000-eeea-000000000a01', 'prevents', NOW() - INTERVAL '7 days'),
  ('20000000-0000-0000-eeea-000000000a10', '10000000-0000-0000-eeea-000000000a10', 'created', '00000000-0000-0000-eeea-000000000a10', 'requires', NOW() - INTERVAL '6 days'),
  ('20000000-0000-0000-eeea-000000000a11', '10000000-0000-0000-eeea-000000000a11', 'created', '00000000-0000-0000-eeea-000000000a11', 'prevents', NOW() - INTERVAL '6 days'),
  ('20000000-0000-0000-eeea-000000000a20', '10000000-0000-0000-eeea-000000000a20', 'created', '00000000-0000-0000-eeea-000000000a20', 'requires', NOW() - INTERVAL '5 days'),
  ('20000000-0000-0000-eeea-000000000a21', '10000000-0000-0000-eeea-000000000a21', 'created', '00000000-0000-0000-eeea-000000000a21', 'prevents', NOW() - INTERVAL '5 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.causal_edges (id, cause_event_id, effect_event_id, strength, reasoning, source_references, extraction_method, initial_strength, last_corroborated, created_at) VALUES
  ('30000000-0000-0000-eeea-000000000a01', '20000000-0000-0000-eeea-000000000a00', '20000000-0000-0000-eeea-000000000a01', 0.8, 'A0: rule->rule', '[]'::jsonb, 'llm', 0.8, NOW() - INTERVAL '7 days', NOW() - INTERVAL '7 days'),
  ('30000000-0000-0000-eeea-000000000a11', '20000000-0000-0000-eeea-000000000a10', '20000000-0000-0000-eeea-000000000a11', 0.8, 'A1: rule->rule', '[]'::jsonb, 'llm', 0.8, NOW() - INTERVAL '6 days', NOW() - INTERVAL '6 days'),
  ('30000000-0000-0000-eeea-000000000a21', '20000000-0000-0000-eeea-000000000a20', '20000000-0000-0000-eeea-000000000a21', 0.8, 'A2: rule->rule', '[]'::jsonb, 'llm', 0.8, NOW() - INTERVAL '5 days', NOW() - INTERVAL '5 days')
ON CONFLICT (id) DO NOTHING;

-- ============================================
-- GROUP B — two noisy chains (entity_type differs at pos 0)
--   Template: [api_function] --requires--> [standard_rule] --prevents--> [compliance_practice]
--   The differing entity_type at pos 0 should keep this OUT of the group A cluster.
-- ============================================

INSERT INTO public.entities (id, canonical_name, entity_type, embedding, confidence) VALUES
  ('00000000-0000-0000-eeeb-000000000b00', 'EmergenceApiB0-pos0', 'api_function',         ARRAY(SELECT 0::float FROM generate_series(1, 768))::vector, 1.0),
  ('00000000-0000-0000-eeeb-000000000b01', 'EmergenceRuleB0-pos1', 'standard_rule',       ARRAY(SELECT 0::float FROM generate_series(1, 768))::vector, 1.0),
  ('00000000-0000-0000-eeeb-000000000b02', 'EmergenceRuleB0-pos2', 'compliance_practice', ARRAY(SELECT 0::float FROM generate_series(1, 768))::vector, 1.0),
  ('00000000-0000-0000-eeeb-000000000b10', 'EmergenceApiB1-pos0', 'api_function',         ARRAY(SELECT 0::float FROM generate_series(1, 768))::vector, 1.0),
  ('00000000-0000-0000-eeeb-000000000b11', 'EmergenceRuleB1-pos1', 'standard_rule',       ARRAY(SELECT 0::float FROM generate_series(1, 768))::vector, 1.0),
  ('00000000-0000-0000-eeeb-000000000b12', 'EmergenceRuleB1-pos2', 'compliance_practice', ARRAY(SELECT 0::float FROM generate_series(1, 768))::vector, 1.0)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.facts (id, subject_entity_id, predicate, object_entity_id, confidence, valid_at) VALUES
  ('10000000-0000-0000-eeeb-000000000b00', '00000000-0000-0000-eeeb-000000000b00', 'requires', '00000000-0000-0000-eeeb-000000000b01', 0.85, NOW() - INTERVAL '4 days'),
  ('10000000-0000-0000-eeeb-000000000b01', '00000000-0000-0000-eeeb-000000000b01', 'prevents', '00000000-0000-0000-eeeb-000000000b02', 0.85, NOW() - INTERVAL '4 days'),
  ('10000000-0000-0000-eeeb-000000000b10', '00000000-0000-0000-eeeb-000000000b10', 'requires', '00000000-0000-0000-eeeb-000000000b11', 0.85, NOW() - INTERVAL '3 days'),
  ('10000000-0000-0000-eeeb-000000000b11', '00000000-0000-0000-eeeb-000000000b11', 'prevents', '00000000-0000-0000-eeeb-000000000b12', 0.85, NOW() - INTERVAL '3 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.causal_events (id, fact_id, transition_type, subject_entity_id, predicate, occurred_at) VALUES
  ('20000000-0000-0000-eeeb-000000000b00', '10000000-0000-0000-eeeb-000000000b00', 'created', '00000000-0000-0000-eeeb-000000000b00', 'requires', NOW() - INTERVAL '4 days'),
  ('20000000-0000-0000-eeeb-000000000b01', '10000000-0000-0000-eeeb-000000000b01', 'created', '00000000-0000-0000-eeeb-000000000b01', 'prevents', NOW() - INTERVAL '4 days'),
  ('20000000-0000-0000-eeeb-000000000b10', '10000000-0000-0000-eeeb-000000000b10', 'created', '00000000-0000-0000-eeeb-000000000b10', 'requires', NOW() - INTERVAL '3 days'),
  ('20000000-0000-0000-eeeb-000000000b11', '10000000-0000-0000-eeeb-000000000b11', 'created', '00000000-0000-0000-eeeb-000000000b11', 'prevents', NOW() - INTERVAL '3 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.causal_edges (id, cause_event_id, effect_event_id, strength, reasoning, source_references, extraction_method, initial_strength, last_corroborated, created_at) VALUES
  ('30000000-0000-0000-eeeb-000000000b01', '20000000-0000-0000-eeeb-000000000b00', '20000000-0000-0000-eeeb-000000000b01', 0.75, 'B0: api->rule (noisy)',  '[]'::jsonb, 'llm', 0.75, NOW() - INTERVAL '4 days', NOW() - INTERVAL '4 days'),
  ('30000000-0000-0000-eeeb-000000000b11', '20000000-0000-0000-eeeb-000000000b10', '20000000-0000-0000-eeeb-000000000b11', 0.75, 'B1: api->rule (noisy)',  '[]'::jsonb, 'llm', 0.75, NOW() - INTERVAL '3 days', NOW() - INTERVAL '3 days')
ON CONFLICT (id) DO NOTHING;

-- ============================================
-- GROUP C — canonical 3-window pattern + one partial chain (ghost source)
--   Pattern template length 3 (2-edge window) is pre-seeded as 'canonical'.
--   We seed only the first edge of an instance; findCausalGhosts(entityId) on
--   the pos-0 entity should surface the missing position.
-- ============================================

INSERT INTO public.entities (id, canonical_name, entity_type, embedding, confidence) VALUES
  ('00000000-0000-0000-eeec-000000000c00', 'EmergenceGhostC0-pos0', 'standard_rule',       ARRAY(SELECT 0::float FROM generate_series(1, 768))::vector, 1.0),
  ('00000000-0000-0000-eeec-000000000c01', 'EmergenceGhostC0-pos1', 'standard_rule',       ARRAY(SELECT 0::float FROM generate_series(1, 768))::vector, 1.0)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.causal_patterns (id, name, description, template_structure, template_length,
                                     status, instance_count, avg_strength, activation_count_30d,
                                     first_seen_at, last_seen_at, promoted_at)
VALUES
  ('40000000-0000-0000-eeec-canonical000',
   'Emergence canonical pattern (C)',
   'Three-position canonical pattern with one partial instance (ghost)',
   '[{"entity_type":"standard_rule","predicate_category":"requires"},
     {"entity_type":"standard_rule","predicate_category":"prevents"},
     {"entity_type":"compliance_practice","predicate_category":"effects"}]'::jsonb,
   3,
   'canonical',
   25, 0.82, 10,
   NOW() - INTERVAL '60 days',
   NOW() - INTERVAL '2 days',
   NOW() - INTERVAL '45 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.facts (id, subject_entity_id, predicate, object_entity_id, confidence, valid_at) VALUES
  ('10000000-0000-0000-eeec-000000000c00', '00000000-0000-0000-eeec-000000000c00', 'requires', '00000000-0000-0000-eeec-000000000c01', 0.85, NOW() - INTERVAL '2 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.causal_events (id, fact_id, transition_type, subject_entity_id, predicate, occurred_at) VALUES
  ('20000000-0000-0000-eeec-000000000c00', '10000000-0000-0000-eeec-000000000c00', 'created', '00000000-0000-0000-eeec-000000000c00', 'requires', NOW() - INTERVAL '2 days'),
  ('20000000-0000-0000-eeec-000000000c01', NULL,                                   'created', '00000000-0000-0000-eeec-000000000c01', 'prevents', NOW() - INTERVAL '2 days')
ON CONFLICT (id) DO NOTHING;

-- Partial chain: covers pos 0 only (the requires edge). The prevents+effects
-- positions are missing → findCausalGhosts surfaces them.
INSERT INTO public.causal_edges (id, cause_event_id, effect_event_id, strength, reasoning, source_references,
                                  extraction_method, initial_strength, pattern_id, pattern_position,
                                  last_corroborated, created_at) VALUES
  ('30000000-0000-0000-eeec-000000000c01',
   '20000000-0000-0000-eeec-000000000c00', '20000000-0000-0000-eeec-000000000c01',
   0.8, 'C: partial chain (ghost source)', '[]'::jsonb,
   'llm', 0.8,
   '40000000-0000-0000-eeec-canonical000', 0,
   NOW() - INTERVAL '2 days', NOW() - INTERVAL '2 days')
ON CONFLICT (id) DO NOTHING;

COMMIT;

-- Expected emergence state after running detectCausalPatterns + promotePatterns + findCausalGhosts:
--   - At least 1 new staging pattern from group A (identical chains cluster
--     to one template)
--   - Group B chains do NOT collide with group A's cluster — separate
--     template hash because entity_type at pos 0 differs
--   - findCausalGhosts(entityId='00000000-0000-0000-eeec-000000000c00') returns
--     at least one ghost row referencing pattern '40000000-0000-0000-eeec-canonical000'
--     with a missing pattern_position > 0
