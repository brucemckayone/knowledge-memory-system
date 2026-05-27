-- orphan-cluster.sql (v1.0)
-- Phase 1 (Graph Stats Foundation) — doc 22 §7.1 fixture
-- Complexity score: 4 (rows=4, edges=0, stressors=3)
-- Stressors:
--   1. no-entity-meta-rows (centroid_sample_size=0)
--   2. orphan-rate=1.0 (no facts → every entity is orphan)
--   3. centroid_sim_* NULL (no centroids to sample)
--
-- Mirrors doc 22 §6 edge case:
--   "entity_meta.centroid is NULL for all entities → Centroid sample size 0,
--   all centroid_sim_* columns NULL. No crash."
--
-- Expected graph_stats shape after computeGraphStats():
--   total_entities=4, total_facts=0, total_active_facts=0, total_memories=0
--   fact_density=0, orphan_rate=1.0, predicate_diversity=0
--   merge_candidates_pending=0
--   centroid_sample_size=0, centroid_sim_mean/median/p10/p90 all NULL
--
-- UUID map:
--   Entity p : 50000000-0000-0000-0004-000000000001
--   Entity q : 50000000-0000-0000-0004-000000000002
--   Entity r : 50000000-0000-0000-0004-000000000003
--   Entity s : 50000000-0000-0000-0004-000000000004

BEGIN;

INSERT INTO public.entities (id, canonical_name, entity_type, embedding, confidence)
VALUES
  ('50000000-0000-0000-0004-000000000001', 'p', 'thing',
   ARRAY(SELECT random() FROM generate_series(1, 768))::vector, 1.0),
  ('50000000-0000-0000-0004-000000000002', 'q', 'thing',
   ARRAY(SELECT random() FROM generate_series(1, 768))::vector, 1.0),
  ('50000000-0000-0000-0004-000000000003', 'r', 'thing',
   ARRAY(SELECT random() FROM generate_series(1, 768))::vector, 1.0),
  ('50000000-0000-0000-0004-000000000004', 's', 'thing',
   ARRAY(SELECT random() FROM generate_series(1, 768))::vector, 1.0)
ON CONFLICT (id) DO NOTHING;

-- No entity_meta rows; no facts. Every entity is an orphan with no centroid.

COMMIT;
