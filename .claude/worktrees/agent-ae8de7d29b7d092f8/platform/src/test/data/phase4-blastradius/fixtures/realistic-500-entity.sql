-- realistic-500-entity.sql
-- Level 2 fixture for Phase 4
--
-- Scenario: 100 entities, 500 facts, 500 causal events, 1000 active causal
-- edges with mixed topology (a partial chain + scatter connections). Mimics
-- a moderate-scale dev DB so we can measure analyzeImpact wall-clock at
-- depth 3 against the spec's <500ms target.
--
-- Topology characteristics:
--   - 100 entities (E000..E099)
--   - 500 facts: 5 facts per entity (subject = entity, object_value = string)
--   - 500 causal events: 1 per fact
--   - 1000 edges:
--       - 500 chain edges: E_i -> E_{i+1} for i in 0..498 (linear backbone)
--       - 500 scatter edges: random cause -> random effect (modulo arithmetic
--         to keep deterministic at fixture-load time)
--
-- UUID space:
--   Entities: 00000007-0000-0000-0000-(00..63 hex)  -- 100 entities (decimal 0..99)
--   Facts:    10000007-0000-0000-0000-(0001..01f4)  -- 500 facts
--   Events:   20000007-0000-0000-0000-(0001..01f4)  -- 500 events (1:1 to facts)
--   Chain edges:   30000007-0000-0000-0000-(0001..01f3)  -- 499 chain edges
--   Scatter edges: 31000007-0000-0000-0000-(0001..01f4)  -- 500 scatter edges
--
-- Total active edges = 499 + 500 = 999 ≈ 1000 (within margin of the spec target)

BEGIN;

-- 100 entities
INSERT INTO public.entities (id, canonical_name, entity_type, properties)
SELECT
  ('00000007-0000-0000-0000-' || lpad(to_hex(i), 12, '0'))::uuid,
  'Entity_' || i::text,
  CASE WHEN i % 4 = 0 THEN 'person'
       WHEN i % 4 = 1 THEN 'concept'
       WHEN i % 4 = 2 THEN 'place'
       ELSE 'company' END,
  '{}'::jsonb
FROM generate_series(0, 99) AS i;

-- 500 facts (5 per entity); object is the subsequent entity for variety
INSERT INTO public.facts (id, subject_entity_id, predicate, object_value)
SELECT
  ('10000007-0000-0000-0000-' || lpad(to_hex(i+1), 12, '0'))::uuid,
  ('00000007-0000-0000-0000-' || lpad(to_hex(i % 100), 12, '0'))::uuid,
  'predicate_' || (i % 7)::text,
  'object_value_' || ((i * 13) % 100)::text
FROM generate_series(0, 499) AS i;

-- 500 events, 1:1 to facts
INSERT INTO public.causal_events (id, fact_id, transition_type, subject_entity_id, predicate, source_text)
SELECT
  ('20000007-0000-0000-0000-' || lpad(to_hex(i+1), 12, '0'))::uuid,
  ('10000007-0000-0000-0000-' || lpad(to_hex(i+1), 12, '0'))::uuid,
  'created',
  ('00000007-0000-0000-0000-' || lpad(to_hex(i % 100), 12, '0'))::uuid,
  'predicate_' || (i % 7)::text,
  'realistic event ' || i::text
FROM generate_series(0, 499) AS i;

-- 499 chain edges: E_i -> E_{i+1}
INSERT INTO public.causal_edges (
  id, cause_event_id, effect_event_id, strength, reasoning,
  source_references, extraction_method, corroboration_count, initial_strength
)
SELECT
  ('30000007-0000-0000-0000-' || lpad(to_hex(i+1), 12, '0'))::uuid,
  ('20000007-0000-0000-0000-' || lpad(to_hex(i+1), 12, '0'))::uuid,
  ('20000007-0000-0000-0000-' || lpad(to_hex(i+2), 12, '0'))::uuid,
  0.7,
  'chain edge ' || i::text,
  '[]'::jsonb,
  'manual',
  1,
  0.7
FROM generate_series(0, 498) AS i;

-- 500 scatter edges using deterministic modular arithmetic for cause/effect.
-- Skip the (cause = effect) and the chain-clone (cause+1 = effect) cases by
-- offsetting effect by an additive prime that is coprime to 500.
INSERT INTO public.causal_edges (
  id, cause_event_id, effect_event_id, strength, reasoning,
  source_references, extraction_method, corroboration_count, initial_strength
)
SELECT
  ('31000007-0000-0000-0000-' || lpad(to_hex(i+1), 12, '0'))::uuid,
  ('20000007-0000-0000-0000-' || lpad(to_hex((i % 500) + 1), 12, '0'))::uuid,
  ('20000007-0000-0000-0000-' || lpad(to_hex(((i * 17 + 31) % 500) + 1), 12, '0'))::uuid,
  0.5 + (i % 5) * 0.1,
  'scatter edge ' || i::text,
  '[]'::jsonb,
  'manual',
  1,
  0.5 + (i % 5) * 0.1
FROM generate_series(0, 499) AS i;

COMMIT;
