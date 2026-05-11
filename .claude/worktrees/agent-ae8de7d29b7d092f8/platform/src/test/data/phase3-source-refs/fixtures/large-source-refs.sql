-- large-source-refs.sql (v1.0)
-- Phase 3 (Source Reference Indexing) — 1000-edge stress fixture for
-- findEdgesCitingReference. AC target: <50ms p95 at 1000 edges.
-- Complexity: 18 (rows=2002, edges=1000, stressors=4)
-- Stressors:
--   1. scale=1000 — matches AC stress target
--   2. hot lookup: a single memory id cited by ALL 1000 edges (worst-case
--      result-set size for findEdgesCitingReference)
--   3. unique-per-edge memory ids — exercise the 1-row fast path
--   4. mid-cardinality fact ref cited by 50 edges
--
-- UUID conventions:
--   Entity                       : 00000000-0000-0000-0000-000000000500
--   Fact (cause/effect parent)   : 10000000-0000-0000-0000-000000000500
--   cause events n=1..1000       : 20000000-0000-0000-0001-{12hex(n)}
--   effect events n=1..1000      : 20000000-0000-0000-0002-{12hex(n)}
--   edges n=1..1000              : 30000000-0000-0000-0001-{12hex(n)}
--   HOT memory ref (1000 cites)  : aaaaaaaa-0000-0000-0000-000000000001
--   UNIQUE memory ref n=1..1000  : aaaaaaaa-0001-0000-0000-{12hex(n)}
--   FACT ref n=1..50 (50 cites)  : bbbbbbbb-0000-0000-0000-000000000001

BEGIN;

INSERT INTO public.entities (id, canonical_name, entity_type, embedding, confidence)
VALUES
  ('00000000-0000-0000-0000-000000000500', 'StressEntity', 'concept',
   ARRAY(SELECT random() FROM generate_series(1, 768))::vector, 1.0)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.facts (id, subject_entity_id, predicate, object_value, confidence)
VALUES
  ('10000000-0000-0000-0000-000000000500',
   '00000000-0000-0000-0000-000000000500', 'stress_test', 'value', 0.5)
ON CONFLICT (id) DO NOTHING;

-- 1000 cause events
INSERT INTO public.causal_events (id, fact_id, transition_type, source_text)
SELECT
  ('20000000-0000-0000-0001-' || lpad(to_hex(n), 12, '0'))::uuid,
  '10000000-0000-0000-0000-000000000500'::uuid,
  'created',
  'cause ' || n
FROM generate_series(1, 1000) AS n
ON CONFLICT (id) DO NOTHING;

-- 1000 effect events
INSERT INTO public.causal_events (id, fact_id, transition_type, source_text)
SELECT
  ('20000000-0000-0000-0002-' || lpad(to_hex(n), 12, '0'))::uuid,
  '10000000-0000-0000-0000-000000000500'::uuid,
  'expired',
  'effect ' || n
FROM generate_series(1, 1000) AS n
ON CONFLICT (id) DO NOTHING;

-- 1000 edges with source_references built per-edge.
-- Edges 1..50 cite hot memory + unique memory + the shared fact ref.
-- Edges 51..1000 cite hot memory + unique memory only.
INSERT INTO public.causal_edges (
  id, cause_event_id, effect_event_id, strength, extraction_method,
  reasoning, source_references, corroboration_count, last_corroborated,
  initial_strength, decay_applied
)
SELECT
  ('30000000-0000-0000-0001-' || lpad(to_hex(n), 12, '0'))::uuid,
  ('20000000-0000-0000-0001-' || lpad(to_hex(n), 12, '0'))::uuid,
  ('20000000-0000-0000-0002-' || lpad(to_hex(n), 12, '0'))::uuid,
  0.5, 'llm', 'stress edge ' || n,
  CASE
    WHEN n <= 50 THEN
      jsonb_build_array(
        jsonb_build_object('type', 'memory',
          'id', 'aaaaaaaa-0000-0000-0000-000000000001',
          'relevance', 'hot'),
        jsonb_build_object('type', 'memory',
          'id', ('aaaaaaaa-0001-0000-0000-' || lpad(to_hex(n), 12, '0')),
          'relevance', 'unique-' || n),
        jsonb_build_object('type', 'fact',
          'id', 'bbbbbbbb-0000-0000-0000-000000000001',
          'relevance', 'shared-fact')
      )
    ELSE
      jsonb_build_array(
        jsonb_build_object('type', 'memory',
          'id', 'aaaaaaaa-0000-0000-0000-000000000001',
          'relevance', 'hot'),
        jsonb_build_object('type', 'memory',
          'id', ('aaaaaaaa-0001-0000-0000-' || lpad(to_hex(n), 12, '0')),
          'relevance', 'unique-' || n)
      )
  END,
  1, NOW() - INTERVAL '1 day',
  0.5, false
FROM generate_series(1, 1000) AS n
ON CONFLICT DO NOTHING;

-- Created-row backfill in causal_edge_history so the audit trail invariant
-- holds (every edge has at least one created row).
INSERT INTO public.causal_edge_history (edge_id, event_type, new_strength, reasoning, actor, occurred_at)
SELECT id, 'created', initial_strength, 'pre-seeded for large-source-refs',
       'graph_agent', created_at
FROM public.causal_edges
WHERE id::text LIKE '30000000-0000-0000-0001-%';

-- Backfill edge_source_refs from JSONB using the same pattern as migration 010.
-- The fixture inserts edges directly (bypassing the syncEdgeSourceRefs helper
-- in audit.ts), so we have to populate the index manually.
INSERT INTO public.edge_source_refs (edge_id, ref_type, ref_id, relevance)
SELECT
  e.id,
  (ref->>'type')::varchar,
  (ref->>'id')::uuid,
  ref->>'relevance'
FROM public.causal_edges e
CROSS JOIN LATERAL jsonb_array_elements(e.source_references) ref
WHERE e.id::text LIKE '30000000-0000-0000-0001-%'
  AND ref->>'type' IN ('memory', 'fact', 'entity')
  AND ref->>'id' IS NOT NULL
ON CONFLICT (edge_id, ref_type, ref_id) DO NOTHING;

COMMIT;
