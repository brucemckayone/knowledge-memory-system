-- canonical-multi-source.sql (v1.0)
-- Phase 1 (Graph Stats Foundation) — doc 22 §7.1 fixture
-- Complexity score: 28 (entities=6, facts=5+1-expired, predicates=4, merges=3,
--                         entity_meta=6, stressors=6)
-- Stressors:
--   1. entity-type diversity (person, company, place, project)
--   2. predicate diversity (works_at, located_in, leads, collaborates_with)
--   3. mixed fact shapes (entity-to-entity + entity-to-literal)
--   4. one expired fact alongside active facts
--   5. orphan + connected entities mixed (5 connected, 1 orphan)
--   6. merge_candidates rows in mixed status (staging + resolved)
--
-- Representative production-shape graph — small but exercises every column
-- computed by computeGraphStats() with non-trivial values.
--
-- Expected graph_stats shape after computeGraphStats():
--   total_entities=6
--   total_facts=6 (5 active + 1 expired)
--   total_active_facts=5
--   total_memories=0
--   fact_density ≈ 0.833 (5/6 active facts per entity)
--   orphan_rate ≈ 0.167 (1 of 6 entities has zero active facts)
--   predicate_diversity=4 (distinct active predicates)
--   merge_candidates_pending=2 (2 staging; 1 resolved excluded)
--   centroid_sample_size > 0 and ≤ 36 (6 × 6 cross-join minus self-joins = 30)
--   centroid_sim_* populated (every entity has a centroid)
--   embedding_cluster_count NULL (Phase 3 not shipped)
--   cluster_columns_version NULL
--
-- UUID map:
--   Entity Alice          : 50000000-0000-0000-0005-000000000001 (person)
--   Entity Acme Corp      : 50000000-0000-0000-0005-000000000002 (company)
--   Entity Bob            : 50000000-0000-0000-0005-000000000003 (person)
--   Entity London         : 50000000-0000-0000-0005-000000000004 (place)
--   Entity Project Atlas  : 50000000-0000-0000-0005-000000000005 (project)
--   Entity Orphan Carol   : 50000000-0000-0000-0005-000000000006 (person, no facts)
--
--   Fact Alice→Acme       : 50000000-1000-0000-0005-000000000001 (works_at, active)
--   Fact Bob→Acme         : 50000000-1000-0000-0005-000000000002 (works_at, active)
--   Fact Acme→London      : 50000000-1000-0000-0005-000000000003 (located_in, active)
--   Fact Alice→Atlas      : 50000000-1000-0000-0005-000000000004 (leads, active)
--   Fact Alice→Bob        : 50000000-1000-0000-0005-000000000005 (collaborates_with, active)
--   Fact Bob→old role     : 50000000-1000-0000-0005-000000000006 (works_at, EXPIRED)

BEGIN;

-- Entities --------------------------------------------------------------------
INSERT INTO public.entities (id, canonical_name, entity_type, embedding, confidence)
VALUES
  ('50000000-0000-0000-0005-000000000001', 'Alice',          'person',
   ARRAY(SELECT random() FROM generate_series(1, 768))::vector, 1.0),
  ('50000000-0000-0000-0005-000000000002', 'Acme Corp',      'company',
   ARRAY(SELECT random() FROM generate_series(1, 768))::vector, 1.0),
  ('50000000-0000-0000-0005-000000000003', 'Bob',            'person',
   ARRAY(SELECT random() FROM generate_series(1, 768))::vector, 1.0),
  ('50000000-0000-0000-0005-000000000004', 'London',         'place',
   ARRAY(SELECT random() FROM generate_series(1, 768))::vector, 1.0),
  ('50000000-0000-0000-0005-000000000005', 'Project Atlas',  'project',
   ARRAY(SELECT random() FROM generate_series(1, 768))::vector, 1.0),
  ('50000000-0000-0000-0005-000000000006', 'Carol',          'person',
   ARRAY(SELECT random() FROM generate_series(1, 768))::vector, 1.0)
ON CONFLICT (id) DO NOTHING;

-- entity_meta rows (centroid per entity — used by centroid_sim_* computation) -
-- Each centroid is independent random; not unit-normalised. Tests assert
-- centroid_sample_size > 0 and ≤ 36, not specific cosine values.
INSERT INTO public.entity_meta (entity_id, centroid)
VALUES
  ('50000000-0000-0000-0005-000000000001'::uuid,
   ARRAY(SELECT random() FROM generate_series(1, 768))::vector),
  ('50000000-0000-0000-0005-000000000002'::uuid,
   ARRAY(SELECT random() FROM generate_series(1, 768))::vector),
  ('50000000-0000-0000-0005-000000000003'::uuid,
   ARRAY(SELECT random() FROM generate_series(1, 768))::vector),
  ('50000000-0000-0000-0005-000000000004'::uuid,
   ARRAY(SELECT random() FROM generate_series(1, 768))::vector),
  ('50000000-0000-0000-0005-000000000005'::uuid,
   ARRAY(SELECT random() FROM generate_series(1, 768))::vector),
  ('50000000-0000-0000-0005-000000000006'::uuid,
   ARRAY(SELECT random() FROM generate_series(1, 768))::vector)
ON CONFLICT (entity_id) DO UPDATE SET centroid = EXCLUDED.centroid;

-- Facts (5 active + 1 expired) ------------------------------------------------
INSERT INTO public.facts (id, subject_entity_id, predicate, object_entity_id,
                          object_value, confidence, valid_at, expired_at)
VALUES
  -- Alice works_at Acme (active)
  ('50000000-1000-0000-0005-000000000001',
   '50000000-0000-0000-0005-000000000001', 'works_at',
   '50000000-0000-0000-0005-000000000002', NULL, 0.9,
   NOW() - INTERVAL '30 days', NULL),
  -- Bob works_at Acme (active)
  ('50000000-1000-0000-0005-000000000002',
   '50000000-0000-0000-0005-000000000003', 'works_at',
   '50000000-0000-0000-0005-000000000002', NULL, 0.85,
   NOW() - INTERVAL '20 days', NULL),
  -- Acme located_in London (active)
  ('50000000-1000-0000-0005-000000000003',
   '50000000-0000-0000-0005-000000000002', 'located_in',
   '50000000-0000-0000-0005-000000000004', NULL, 0.95,
   NOW() - INTERVAL '90 days', NULL),
  -- Alice leads Project Atlas (active)
  ('50000000-1000-0000-0005-000000000004',
   '50000000-0000-0000-0005-000000000001', 'leads',
   '50000000-0000-0000-0005-000000000005', NULL, 0.8,
   NOW() - INTERVAL '10 days', NULL),
  -- Alice collaborates_with Bob (active)
  ('50000000-1000-0000-0005-000000000005',
   '50000000-0000-0000-0005-000000000001', 'collaborates_with',
   '50000000-0000-0000-0005-000000000003', NULL, 0.75,
   NOW() - INTERVAL '5 days', NULL),
  -- Bob old works_at (expired — does NOT contribute to active/predicate_diversity)
  ('50000000-1000-0000-0005-000000000006',
   '50000000-0000-0000-0005-000000000003', 'previously_worked_at',
   NULL, 'OldCo', 0.6,
   NOW() - INTERVAL '365 days', NOW() - INTERVAL '60 days')
ON CONFLICT (id) DO NOTHING;

-- merge_candidates (mixed status — 2 staging, 1 resolved) --------------------
-- Canonical ordering (a_id < b_id) enforced by hand.
INSERT INTO public.merge_candidates (entity_a_id, entity_b_id, combined_score, status)
VALUES
  -- Two staging candidates → contribute to merge_candidates_pending
  ('50000000-0000-0000-0005-000000000001'::uuid,
   '50000000-0000-0000-0005-000000000003'::uuid, 0.62, 'staging'),
  ('50000000-0000-0000-0005-000000000002'::uuid,
   '50000000-0000-0000-0005-000000000004'::uuid, 0.55, 'staging'),
  -- One resolved candidate → excluded from pending count
  ('50000000-0000-0000-0005-000000000005'::uuid,
   '50000000-0000-0000-0005-000000000006'::uuid, 0.71, 'resolved');

COMMIT;
