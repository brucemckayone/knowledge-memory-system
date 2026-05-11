-- three-identical-chains.sql
-- Level 1 fixture for Phase 6 (Pattern Lifecycle)
--
-- Scenario: Three causal chains with identical template structure
--   [standard_rule → requires → standard_rule → prevents → compliance_practice]
-- Expected: detectCausalPatterns() promotes template to staging with instance_count = 3
--
-- UUID convention:
--   Entities:      00000000-....-0000-00000001xx (100-119 reserved for this fixture)
--   Facts:         10000000-....-0000-00000001xx
--   Causal events: 20000000-....-0000-00000001xx (one per fact creation)
--   Causal edges:  30000000-....-0000-00000001xx

BEGIN;

-- ============================================
-- Chain 1: Rule 5.0 → Rule 5.1 → strict aliasing
-- ============================================

INSERT INTO public.entities (id, canonical_name, entity_type, embedding, confidence) VALUES
  ('00000000-0000-0000-0000-000000000100', 'MISRA Rule 5.0', 'standard_rule', ARRAY(SELECT random() FROM generate_series(1, 768))::vector, 1.0),
  ('00000000-0000-0000-0000-000000000101', 'MISRA Rule 5.1', 'standard_rule', ARRAY(SELECT random() FROM generate_series(1, 768))::vector, 1.0),
  ('00000000-0000-0000-0000-000000000102', 'strict aliasing compliance', 'compliance_practice', ARRAY(SELECT random() FROM generate_series(1, 768))::vector, 1.0)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.facts (id, subject_entity_id, predicate, object_entity_id, confidence, valid_at) VALUES
  ('10000000-0000-0000-0000-000000000100',
   '00000000-0000-0000-0000-000000000100', 'requires',
   '00000000-0000-0000-0000-000000000101', 0.9, NOW() - INTERVAL '10 days'),
  ('10000000-0000-0000-0000-000000000101',
   '00000000-0000-0000-0000-000000000101', 'prevents',
   '00000000-0000-0000-0000-000000000102', 0.9, NOW() - INTERVAL '10 days')
ON CONFLICT (id) DO NOTHING;

-- ============================================
-- Chain 2: Rule 6.4 → Rule 6.5 → type narrowing
-- ============================================

INSERT INTO public.entities (id, canonical_name, entity_type, embedding, confidence) VALUES
  ('00000000-0000-0000-0000-000000000110', 'MISRA Rule 6.4', 'standard_rule', ARRAY(SELECT random() FROM generate_series(1, 768))::vector, 1.0),
  ('00000000-0000-0000-0000-000000000111', 'MISRA Rule 6.5', 'standard_rule', ARRAY(SELECT random() FROM generate_series(1, 768))::vector, 1.0),
  ('00000000-0000-0000-0000-000000000112', 'type narrowing compliance', 'compliance_practice', ARRAY(SELECT random() FROM generate_series(1, 768))::vector, 1.0)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.facts (id, subject_entity_id, predicate, object_entity_id, confidence, valid_at) VALUES
  ('10000000-0000-0000-0000-000000000110',
   '00000000-0000-0000-0000-000000000110', 'requires',
   '00000000-0000-0000-0000-000000000111', 0.9, NOW() - INTERVAL '8 days'),
  ('10000000-0000-0000-0000-000000000111',
   '00000000-0000-0000-0000-000000000111', 'prevents',
   '00000000-0000-0000-0000-000000000112', 0.9, NOW() - INTERVAL '8 days')
ON CONFLICT (id) DO NOTHING;

-- ============================================
-- Chain 3: Rule 21.3 → Rule 21.4 → memory safety
-- ============================================

INSERT INTO public.entities (id, canonical_name, entity_type, embedding, confidence) VALUES
  ('00000000-0000-0000-0000-000000000120', 'MISRA Rule 21.3', 'standard_rule', ARRAY(SELECT random() FROM generate_series(1, 768))::vector, 1.0),
  ('00000000-0000-0000-0000-000000000121', 'MISRA Rule 21.4', 'standard_rule', ARRAY(SELECT random() FROM generate_series(1, 768))::vector, 1.0),
  ('00000000-0000-0000-0000-000000000122', 'memory safety compliance', 'compliance_practice', ARRAY(SELECT random() FROM generate_series(1, 768))::vector, 1.0)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.facts (id, subject_entity_id, predicate, object_entity_id, confidence, valid_at) VALUES
  ('10000000-0000-0000-0000-000000000120',
   '00000000-0000-0000-0000-000000000120', 'requires',
   '00000000-0000-0000-0000-000000000121', 0.9, NOW() - INTERVAL '5 days'),
  ('10000000-0000-0000-0000-000000000121',
   '00000000-0000-0000-0000-000000000121', 'prevents',
   '00000000-0000-0000-0000-000000000122', 0.9, NOW() - INTERVAL '5 days')
ON CONFLICT (id) DO NOTHING;

-- ============================================
-- Causal events — one per fact INSERT (normally trigger-emitted)
-- ============================================

INSERT INTO public.causal_events (id, fact_id, transition_type, subject_entity_id, predicate, occurred_at) VALUES
  ('20000000-0000-0000-0000-000000000100', '10000000-0000-0000-0000-000000000100', 'created', '00000000-0000-0000-0000-000000000100', 'requires', NOW() - INTERVAL '10 days'),
  ('20000000-0000-0000-0000-000000000101', '10000000-0000-0000-0000-000000000101', 'created', '00000000-0000-0000-0000-000000000101', 'prevents', NOW() - INTERVAL '10 days'),
  ('20000000-0000-0000-0000-000000000110', '10000000-0000-0000-0000-000000000110', 'created', '00000000-0000-0000-0000-000000000110', 'requires', NOW() - INTERVAL '8 days'),
  ('20000000-0000-0000-0000-000000000111', '10000000-0000-0000-0000-000000000111', 'created', '00000000-0000-0000-0000-000000000111', 'prevents', NOW() - INTERVAL '8 days'),
  ('20000000-0000-0000-0000-000000000120', '10000000-0000-0000-0000-000000000120', 'created', '00000000-0000-0000-0000-000000000120', 'requires', NOW() - INTERVAL '5 days'),
  ('20000000-0000-0000-0000-000000000121', '10000000-0000-0000-0000-000000000121', 'created', '00000000-0000-0000-0000-000000000121', 'prevents', NOW() - INTERVAL '5 days')
ON CONFLICT (id) DO NOTHING;

-- ============================================
-- Causal edges connecting the chains
-- ============================================

INSERT INTO public.causal_edges (id, cause_event_id, effect_event_id, strength, reasoning, source_references, extraction_method, initial_strength, last_corroborated, created_at) VALUES
  ('30000000-0000-0000-0000-000000000100',
   '20000000-0000-0000-0000-000000000100', '20000000-0000-0000-0000-000000000101',
   0.8, 'Rule 5.0 requires Rule 5.1 compliance, which prevents strict aliasing violations',
   '[{"type":"memory","id":"00000000-0000-0000-0000-000000000100","relevance":"explicit rule dependency"}]'::jsonb,
   'llm', 0.8, NOW() - INTERVAL '10 days', NOW() - INTERVAL '10 days'),

  ('30000000-0000-0000-0000-000000000110',
   '20000000-0000-0000-0000-000000000110', '20000000-0000-0000-0000-000000000111',
   0.8, 'Rule 6.4 requires Rule 6.5 compliance, which prevents type narrowing defects',
   '[{"type":"memory","id":"00000000-0000-0000-0000-000000000110","relevance":"explicit rule dependency"}]'::jsonb,
   'llm', 0.8, NOW() - INTERVAL '8 days', NOW() - INTERVAL '8 days'),

  ('30000000-0000-0000-0000-000000000120',
   '20000000-0000-0000-0000-000000000120', '20000000-0000-0000-0000-000000000121',
   0.8, 'Rule 21.3 requires Rule 21.4 compliance, which prevents memory safety defects',
   '[{"type":"memory","id":"00000000-0000-0000-0000-000000000120","relevance":"explicit rule dependency"}]'::jsonb,
   'llm', 0.8, NOW() - INTERVAL '5 days', NOW() - INTERVAL '5 days')
ON CONFLICT (id) DO NOTHING;

COMMIT;

-- After running detectCausalPatterns():
--   causal_patterns table should have 1 new row with:
--     status = 'staging'
--     template_structure = [
--       { "entity_type": "standard_rule", "transition": "created", "predicate_category": "compliance" },
--       { "entity_type": "standard_rule", "transition": "created", "predicate_category": "compliance" },
--       { "entity_type": "compliance_practice", "transition": "created", "predicate_category": "effects" }
--     ]
--     instance_count = 3
--     avg_strength ≈ 0.8
--
--   All 3 causal_edges should have pattern_id set to the new pattern
