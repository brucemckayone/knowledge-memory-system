-- multi-entity-cluster.sql (v1.0)
-- Phase entity-summary — bead nmemo-2yv.56 fixture
-- Complexity score: 5 (rows=5+5+8, stressors=3)
-- Stressors:
--   1. 5 entities whose summaries cross-reference each other by name — exercises
--      the read-side rendering when the agent's narrative refers to other entities
--      that DO exist in the graph. Future consumers (the .51 endpoint joining
--      facts + summary, the viz panel rendering cross-references) can use this
--      fixture to verify links survive read.
--   2. Cluster topology: 5 entities, 8 active facts forming a connected component
--      (no orphans, no expired facts). Lets the .51 GET /api/entity/:id/profile
--      endpoint emit a non-trivial { entity, facts, relatedEntities, summary }
--      payload from a single fixture-driven test.
--   3. summary_updated_at staggered across 1-30 days so freshness consumers can
--      test ordering / sort-by-freshness without manual fixturing.
--
-- Schema reference: src/db/schema.ts → entities, facts, entity_meta
--
-- UUID map (cluster name: Orion):
--   Alex   (lead engineer)    : 56000000-0000-0000-0006-000000000001
--   Maya   (project sponsor)  : 56000000-0000-0000-0006-000000000002
--   Sam    (security reviewer): 56000000-0000-0000-0006-000000000003
--   Riya   (UX lead)          : 56000000-0000-0000-0006-000000000004
--   Project Orion             : 56000000-0000-0000-0006-000000000005 (project)
--
-- Fact UUIDs:
--   Alex leads Orion          : 56000000-1000-0000-0006-000000000001
--   Maya sponsors Orion       : 56000000-1000-0000-0006-000000000002
--   Sam reviews Orion         : 56000000-1000-0000-0006-000000000003
--   Riya designs Orion        : 56000000-1000-0000-0006-000000000004
--   Alex works_with Maya      : 56000000-1000-0000-0006-000000000005
--   Maya manages Sam          : 56000000-1000-0000-0006-000000000006
--   Sam reports_to Maya       : 56000000-1000-0000-0006-000000000007
--   Riya works_with Alex      : 56000000-1000-0000-0006-000000000008
--
-- Expected after load:
--   5 entities + 8 active facts + 5 entity_meta rows with non-null summaries.
--   getEntityProfile(Alex) returns ≥3 related entities (Maya, Riya, Orion).
--   computeGraphStats() over this fixture: orphan_rate=0, predicate_diversity≥4.

BEGIN;

INSERT INTO public.entities (id, canonical_name, entity_type, embedding, confidence)
VALUES
  ('56000000-0000-0000-0006-000000000001', '[bead-56-fixture] Alex',           'person',
   ARRAY(SELECT random() FROM generate_series(1, 768))::vector, 1.0),
  ('56000000-0000-0000-0006-000000000002', '[bead-56-fixture] Maya',           'person',
   ARRAY(SELECT random() FROM generate_series(1, 768))::vector, 1.0),
  ('56000000-0000-0000-0006-000000000003', '[bead-56-fixture] Sam',            'person',
   ARRAY(SELECT random() FROM generate_series(1, 768))::vector, 1.0),
  ('56000000-0000-0000-0006-000000000004', '[bead-56-fixture] Riya',           'person',
   ARRAY(SELECT random() FROM generate_series(1, 768))::vector, 1.0),
  ('56000000-0000-0000-0006-000000000005', '[bead-56-fixture] Project Orion',  'project',
   ARRAY(SELECT random() FROM generate_series(1, 768))::vector, 1.0)
ON CONFLICT (id) DO NOTHING;

-- Cross-referencing summaries (each names ≥1 other entity in the cluster).
INSERT INTO public.entity_meta (entity_id, summary, summary_updated_at, updated_at)
VALUES
  ('56000000-0000-0000-0006-000000000001'::uuid,
   '[bead-56-fixture] Alex is the lead engineer on Project Orion. Works closely with Riya on design and reports up to Maya. Known references: "Alex", "the engineer". No unresolved aliases.',
   NOW() - INTERVAL '1 day', NOW() - INTERVAL '1 day'),
  ('56000000-0000-0000-0006-000000000002'::uuid,
   '[bead-56-fixture] Maya sponsors Project Orion and manages Sam directly. Has standing collaboration with Alex. Senior role; appears in nearly every project meeting transcript.',
   NOW() - INTERVAL '5 days', NOW() - INTERVAL '2 days'),
  ('56000000-0000-0000-0006-000000000003'::uuid,
   '[bead-56-fixture] Sam is the security reviewer assigned to Project Orion. Reports to Maya. Has flagged two outstanding risks on Orion (see facts).',
   NOW() - INTERVAL '10 days', NOW() - INTERVAL '10 days'),
  ('56000000-0000-0000-0006-000000000004'::uuid,
   '[bead-56-fixture] Riya is the UX lead on Project Orion. Pairs with Alex on architecture decisions where UX intersects engineering. Newest team member; first mentioned in late 2026-04.',
   NOW() - INTERVAL '20 days', NOW() - INTERVAL '8 days'),
  ('56000000-0000-0000-0006-000000000005'::uuid,
   '[bead-56-fixture] Project Orion is the active engineering initiative led by Alex with sponsorship from Maya. Security reviewer: Sam. UX lead: Riya. Status: in flight. Cross-cluster references: connects engineering and product orgs.',
   NOW() - INTERVAL '30 days', NOW() - INTERVAL '1 day')
ON CONFLICT (entity_id) DO UPDATE SET
  summary = EXCLUDED.summary,
  summary_updated_at = EXCLUDED.summary_updated_at,
  updated_at = EXCLUDED.updated_at;

-- 8 active facts forming the cluster — no expired, no orphans.
INSERT INTO public.facts (id, subject_entity_id, predicate, object_entity_id,
                          object_value, confidence, valid_at, expired_at)
VALUES
  ('56000000-1000-0000-0006-000000000001',
   '56000000-0000-0000-0006-000000000001', 'leads',
   '56000000-0000-0000-0006-000000000005', NULL, 0.95,
   NOW() - INTERVAL '60 days', NULL),
  ('56000000-1000-0000-0006-000000000002',
   '56000000-0000-0000-0006-000000000002', 'sponsors',
   '56000000-0000-0000-0006-000000000005', NULL, 0.92,
   NOW() - INTERVAL '90 days', NULL),
  ('56000000-1000-0000-0006-000000000003',
   '56000000-0000-0000-0006-000000000003', 'reviews',
   '56000000-0000-0000-0006-000000000005', NULL, 0.88,
   NOW() - INTERVAL '30 days', NULL),
  ('56000000-1000-0000-0006-000000000004',
   '56000000-0000-0000-0006-000000000004', 'designs',
   '56000000-0000-0000-0006-000000000005', NULL, 0.85,
   NOW() - INTERVAL '20 days', NULL),
  ('56000000-1000-0000-0006-000000000005',
   '56000000-0000-0000-0006-000000000001', 'works_with',
   '56000000-0000-0000-0006-000000000002', NULL, 0.9,
   NOW() - INTERVAL '50 days', NULL),
  ('56000000-1000-0000-0006-000000000006',
   '56000000-0000-0000-0006-000000000002', 'manages',
   '56000000-0000-0000-0006-000000000003', NULL, 0.95,
   NOW() - INTERVAL '120 days', NULL),
  ('56000000-1000-0000-0006-000000000007',
   '56000000-0000-0000-0006-000000000003', 'reports_to',
   '56000000-0000-0000-0006-000000000002', NULL, 0.95,
   NOW() - INTERVAL '120 days', NULL),
  ('56000000-1000-0000-0006-000000000008',
   '56000000-0000-0000-0006-000000000004', 'works_with',
   '56000000-0000-0000-0006-000000000001', NULL, 0.87,
   NOW() - INTERVAL '15 days', NULL)
ON CONFLICT (id) DO NOTHING;

COMMIT;
