-- single-entity.sql (v1.0)
-- Phase 1 (Graph Stats Foundation) — doc 22 §7.1 fixture
-- Complexity score: 1 (rows=1, edges=0, stressors=1)
-- Stressors:
--   1. orphan-rate=1.0 (single entity, zero facts → 100% orphan rate)
--
-- Expected graph_stats shape after computeGraphStats():
--   total_entities=1, total_facts=0, total_active_facts=0, total_memories=0
--   fact_density=0, orphan_rate=1.0, predicate_diversity=0
--   merge_candidates_pending=0
--   centroid_sample_size=0, centroid_sim_* NULL (no entity_meta row)
--
-- UUID map:
--   Entity solo : 50000000-0000-0000-0001-000000000001

BEGIN;

INSERT INTO public.entities (id, canonical_name, entity_type, embedding, confidence)
VALUES
  ('50000000-0000-0000-0001-000000000001', 'solo', 'person',
   ARRAY(SELECT random() FROM generate_series(1, 768))::vector, 1.0)
ON CONFLICT (id) DO NOTHING;

COMMIT;
