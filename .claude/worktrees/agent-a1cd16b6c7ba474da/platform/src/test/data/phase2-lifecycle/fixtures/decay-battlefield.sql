-- decay-battlefield.sql (v1.0)
-- Phase 2 (Edge Lifecycle) — 100-edge decay benchmark target
-- Complexity: 12 (rows=202, edges=100, stressors=6)
-- Stressors:
--   1. scale=100 (matches AC benchmark target: decay cycle <200ms / 100 edges)
--   2. decay-eligible cohort (60 edges) — stale uncorroborated llm-extracted
--   3. fresh-skip cohort (10 edges) — last_corroborated within ageDays threshold
--   4. multi-corroborated-skip cohort (10 edges) — corroboration_count > 1
--   5. floor-skip cohort (10 edges) — strength already at/below floor
--   6. expired-skip cohort (5 edges) — already expired_at
--   7. non-llm-skip cohort (5 edges) — extraction_method != 'llm'
--
-- UUID map:
--   Entity              : 00000000-0000-0000-0000-000000000300
--   Fact                : 10000000-0000-0000-0000-000000000300
--   cause events 1..100 : 20000000-0000-0000-0000-0000000000NN
--   effect events 1..100: 20000000-0000-0000-0000-0000000001NN
--   edges 1..100        : 30000000-0000-0000-0000-0000000000NN

BEGIN;

INSERT INTO public.entities (id, canonical_name, entity_type, embedding, confidence)
VALUES
  ('00000000-0000-0000-0000-000000000300', 'BattlefieldEntity', 'concept',
   ARRAY(SELECT random() FROM generate_series(1, 768))::vector, 1.0)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.facts (id, subject_entity_id, predicate, object_value, confidence)
VALUES
  ('10000000-0000-0000-0000-000000000300',
   '00000000-0000-0000-0000-000000000300', 'lifecycle_test', 'value', 0.5)
ON CONFLICT (id) DO NOTHING;

-- 100 cause events
INSERT INTO public.causal_events (id, fact_id, transition_type, source_text)
SELECT
  ('20000000-0000-0000-0000-' || lpad(n::text, 12, '0'))::uuid,
  '10000000-0000-0000-0000-000000000300'::uuid,
  'created',
  'cause event ' || n
FROM generate_series(1, 100) AS n
ON CONFLICT (id) DO NOTHING;

-- 100 effect events (offset by 100 to avoid id collision and self-loops)
INSERT INTO public.causal_events (id, fact_id, transition_type, source_text)
SELECT
  ('20000000-0000-0000-0000-' || lpad((n + 100)::text, 12, '0'))::uuid,
  '10000000-0000-0000-0000-000000000300'::uuid,
  'expired',
  'effect event ' || n
FROM generate_series(1, 100) AS n
ON CONFLICT (id) DO NOTHING;

-- Cohort 1: 60 edges that should be decayed (stale uncorroborated llm)
INSERT INTO public.causal_edges (
  id, cause_event_id, effect_event_id, strength, extraction_method,
  reasoning, source_references, corroboration_count, last_corroborated,
  initial_strength, decay_applied
)
SELECT
  ('30000000-0000-0000-0000-' || lpad(n::text, 12, '0'))::uuid,
  ('20000000-0000-0000-0000-' || lpad(n::text, 12, '0'))::uuid,
  ('20000000-0000-0000-0000-' || lpad((n + 100)::text, 12, '0'))::uuid,
  0.6, 'llm', 'decay target ' || n, '[]'::jsonb,
  1, NOW() - INTERVAL '60 days',
  0.7, false
FROM generate_series(1, 60) AS n
ON CONFLICT DO NOTHING;

-- Cohort 2: 10 edges that should be skipped — fresh
INSERT INTO public.causal_edges (
  id, cause_event_id, effect_event_id, strength, extraction_method,
  reasoning, source_references, corroboration_count, last_corroborated,
  initial_strength, decay_applied
)
SELECT
  ('30000000-0000-0000-0000-' || lpad(n::text, 12, '0'))::uuid,
  ('20000000-0000-0000-0000-' || lpad(n::text, 12, '0'))::uuid,
  ('20000000-0000-0000-0000-' || lpad((n + 100)::text, 12, '0'))::uuid,
  0.6, 'llm', 'fresh skip ' || n, '[]'::jsonb,
  1, NOW() - INTERVAL '5 days',
  0.7, false
FROM generate_series(61, 70) AS n
ON CONFLICT DO NOTHING;

-- Cohort 3: 10 edges that should be skipped — corroboration_count > 1
INSERT INTO public.causal_edges (
  id, cause_event_id, effect_event_id, strength, extraction_method,
  reasoning, source_references, corroboration_count, last_corroborated,
  initial_strength, decay_applied
)
SELECT
  ('30000000-0000-0000-0000-' || lpad(n::text, 12, '0'))::uuid,
  ('20000000-0000-0000-0000-' || lpad(n::text, 12, '0'))::uuid,
  ('20000000-0000-0000-0000-' || lpad((n + 100)::text, 12, '0'))::uuid,
  0.7, 'llm', 'multi-corroborated skip ' || n, '[]'::jsonb,
  3, NOW() - INTERVAL '60 days',
  0.7, false
FROM generate_series(71, 80) AS n
ON CONFLICT DO NOTHING;

-- Cohort 4: 10 edges that should be skipped — already at/below floor
INSERT INTO public.causal_edges (
  id, cause_event_id, effect_event_id, strength, extraction_method,
  reasoning, source_references, corroboration_count, last_corroborated,
  initial_strength, decay_applied
)
SELECT
  ('30000000-0000-0000-0000-' || lpad(n::text, 12, '0'))::uuid,
  ('20000000-0000-0000-0000-' || lpad(n::text, 12, '0'))::uuid,
  ('20000000-0000-0000-0000-' || lpad((n + 100)::text, 12, '0'))::uuid,
  0.05, 'llm', 'at-floor skip ' || n, '[]'::jsonb,
  1, NOW() - INTERVAL '60 days',
  0.7, false
FROM generate_series(81, 90) AS n
ON CONFLICT DO NOTHING;

-- Cohort 5: 5 edges that should be skipped — already expired
INSERT INTO public.causal_edges (
  id, cause_event_id, effect_event_id, strength, extraction_method,
  reasoning, source_references, corroboration_count, last_corroborated,
  initial_strength, decay_applied, expired_at, expire_reason
)
SELECT
  ('30000000-0000-0000-0000-' || lpad(n::text, 12, '0'))::uuid,
  ('20000000-0000-0000-0000-' || lpad(n::text, 12, '0'))::uuid,
  ('20000000-0000-0000-0000-' || lpad((n + 100)::text, 12, '0'))::uuid,
  0.4, 'llm', 'pre-expired skip ' || n, '[]'::jsonb,
  1, NOW() - INTERVAL '60 days',
  0.7, false, NOW() - INTERVAL '10 days', 'pre-seeded expired'
FROM generate_series(91, 95) AS n
ON CONFLICT DO NOTHING;

-- Cohort 6: 5 edges that should be skipped — extraction_method != llm
INSERT INTO public.causal_edges (
  id, cause_event_id, effect_event_id, strength, extraction_method,
  reasoning, source_references, corroboration_count, last_corroborated,
  initial_strength, decay_applied
)
SELECT
  ('30000000-0000-0000-0000-' || lpad(n::text, 12, '0'))::uuid,
  ('20000000-0000-0000-0000-' || lpad(n::text, 12, '0'))::uuid,
  ('20000000-0000-0000-0000-' || lpad((n + 100)::text, 12, '0'))::uuid,
  0.6, 'manual', 'non-llm skip ' || n, '[]'::jsonb,
  1, NOW() - INTERVAL '60 days',
  0.7, false
FROM generate_series(96, 100) AS n
ON CONFLICT DO NOTHING;

-- Audit baseline: one created row per edge, batch-inserted
INSERT INTO public.causal_edge_history (edge_id, event_type, new_strength, reasoning, actor, occurred_at)
SELECT id, 'created', initial_strength, 'pre-seeded for decay-battlefield',
       'graph_agent', created_at
FROM public.causal_edges
WHERE id::text LIKE '30000000-0000-0000-0000-0000000000%'
   OR id::text LIKE '30000000-0000-0000-0000-0000000001%';

COMMIT;
