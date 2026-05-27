-- expired-only.sql (v1.0)
-- Phase 1 (Graph Stats Foundation) — doc 22 §7.1 fixture
-- Complexity score: 3 (rows=3, edges=1-expired, stressors=2)
-- Stressors:
--   1. expired-fact-excluded-from-active-count
--   2. predicate-diversity=0 (only active facts contribute to diversity)
--
-- Mirrors doc 22 §6 "Expired facts only" edge case:
--   total_facts > 0, total_active_facts = 0, predicate_diversity = 0,
--   fact_density = 0.
--
-- Expected graph_stats shape after computeGraphStats():
--   total_entities=2, total_facts=1, total_active_facts=0, total_memories=0
--   fact_density=0, predicate_diversity=0, orphan_rate=1.0 (both entities
--   orphan since the only fact is expired)
--   merge_candidates_pending=0
--
-- UUID map:
--   Entity X    : 50000000-0000-0000-0003-000000000001
--   Entity Y    : 50000000-0000-0000-0003-000000000002
--   Fact (expired): 50000000-1000-0000-0003-000000000001

BEGIN;

INSERT INTO public.entities (id, canonical_name, entity_type, embedding, confidence)
VALUES
  ('50000000-0000-0000-0003-000000000001', 'x', 'thing',
   ARRAY(SELECT random() FROM generate_series(1, 768))::vector, 1.0),
  ('50000000-0000-0000-0003-000000000002', 'y', 'thing',
   ARRAY(SELECT random() FROM generate_series(1, 768))::vector, 1.0)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.facts (id, subject_entity_id, predicate, object_value,
                          confidence, expired_at)
VALUES
  ('50000000-1000-0000-0003-000000000001',
   '50000000-0000-0000-0003-000000000001', 'was_active',
   'past', 1.0, NOW() - INTERVAL '1 day')
ON CONFLICT (id) DO NOTHING;

COMMIT;
