-- two-entities-one-fact.sql (v1.0)
-- Phase 1 (Graph Stats Foundation) — doc 22 §7.1 fixture
-- Complexity score: 3 (rows=3, edges=1, stressors=2)
-- Stressors:
--   1. minimal-connected-graph (2 entities + 1 entity-to-literal fact)
--   2. orphan-rate=0.5 (one entity participates in the fact, the other does not)
--
-- Doc 22 §3.2 orphan definition: an entity is orphan if it has zero facts in
-- either role (subject OR object). The fact below is entity-to-literal
-- (object_value set, object_entity_id NULL) so entity B is orphan.
--
-- Expected graph_stats shape after computeGraphStats():
--   total_entities=2, total_facts=1, total_active_facts=1, total_memories=0
--   fact_density=0.5, orphan_rate=0.5, predicate_diversity=1
--   merge_candidates_pending=0
--
-- UUID map:
--   Entity A    : 50000000-0000-0000-0002-000000000001
--   Entity B    : 50000000-0000-0000-0002-000000000002
--   Fact A→lit  : 50000000-1000-0000-0002-000000000001

BEGIN;

INSERT INTO public.entities (id, canonical_name, entity_type, embedding, confidence)
VALUES
  ('50000000-0000-0000-0002-000000000001', 'a', 'thing',
   ARRAY(SELECT random() FROM generate_series(1, 768))::vector, 1.0),
  ('50000000-0000-0000-0002-000000000002', 'b', 'thing',
   ARRAY(SELECT random() FROM generate_series(1, 768))::vector, 1.0)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.facts (id, subject_entity_id, predicate, object_value, confidence)
VALUES
  ('50000000-1000-0000-0002-000000000001',
   '50000000-0000-0000-0002-000000000001', 'has_label',
   'literal', 1.0)
ON CONFLICT (id) DO NOTHING;

COMMIT;
