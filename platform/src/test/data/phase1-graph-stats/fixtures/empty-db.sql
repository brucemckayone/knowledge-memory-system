-- empty-db.sql (v1.0)
-- Phase 1 (Graph Stats Foundation) — doc 22 §7.1 baseline fixture
-- Complexity score: 0 (rows=0, edges=0, stressors=0)
-- Seeds NO entities, NO facts, NO entity_meta, NO merge_candidates.
--
-- Expected graph_stats shape after computeGraphStats():
--   total_entities=0, total_facts=0, total_active_facts=0, total_memories=0
--   centroid_sample_size=0, all centroid_sim_* NULL, fact_density NULL,
--   orphan_rate NULL, predicate_diversity=0, merge_candidates_pending=0
--
-- Loader contract:
--   loadFixture('phase1-graph-stats/fixtures/empty-db.sql') runs without error
--   even though the file is a no-op — the BEGIN/COMMIT pair keeps the
--   loader's transaction-stripping logic happy.

BEGIN;
  -- intentionally empty; the test runner is expected to wipe state via the
  -- test's own cleanSlate() before loading this fixture.
  SELECT 1 AS empty_db_baseline;
COMMIT;
