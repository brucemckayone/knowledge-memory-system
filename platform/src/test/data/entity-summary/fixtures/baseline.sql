-- baseline.sql (v1.0)
-- Phase entity-summary — bead nmemo-2yv.56 fixture
-- Complexity score: 2 (rows=1, stressors=2)
-- Stressors:
--   1. Healthy ~500-char summary that fits comfortably under the .53 soft (2000) and
--      hard (3000) caps — the read-back path's happy case.
--   2. summary_updated_at set to NOW() - 1 day so freshness consumers see a recent,
--      non-stale signal (cf. doc 37 §8 staleness — "recent" = <30 days).
--
-- Schema reference: src/db/schema.ts → entities + entity_meta (summary, summary_updated_at)
-- Migration: 004_entity_summary.sql (summary), 036_entity_summary_updated_at.sql (timestamp)
--
-- UUID map:
--   Entity Baseline       : 56000000-0000-0000-0001-000000000001 (person)
--
-- Expected after load:
--   1 row in entity_meta with summary length ~500 chars and summary_updated_at = NOW() - '1 day'
--   getEntityById(<entity>) → row
--   future getEntityProfile(<entity>).summary (.51) → the seeded summary
--   future getEntityProfile(<entity>).summaryUpdatedAt (.51) → roughly NOW() - '1 day'

BEGIN;

INSERT INTO public.entities (id, canonical_name, entity_type, embedding, confidence)
VALUES
  ('56000000-0000-0000-0001-000000000001', '[bead-56-fixture] Baseline Person', 'person',
   ARRAY(SELECT random() FROM generate_series(1, 768))::vector, 1.0)
ON CONFLICT (id) DO NOTHING;

-- Healthy 500-ish-char summary — narrative voice, multi-aspect (current state,
-- references, ambiguities), well under the .53 caps. The leading [bead-56-fixture]
-- marker lets the test sweep mop up after itself without colliding with concurrent suites.
INSERT INTO public.entity_meta (entity_id, summary, summary_updated_at, updated_at)
VALUES
  ('56000000-0000-0000-0001-000000000001'::uuid,
   '[bead-56-fixture] Baseline Person is a recurring narrator across the corpus, referred to variously as "Alex", "the engineer", and (in earlier transcripts) "A.". Current role: lead engineer on Project Orion as of 2026-04. Known associates include the project sponsor (entity ent-sponsor) and the security reviewer (ent-sec-rev). Recurring narrative themes: late-stage deployment risk, friction with the procurement track, a long-standing professional rivalry with the entity "Sam". One unresolved ambiguity remains: a stray mention of "Alex from Acme" in 2025-09 may or may not be the same person.',
   NOW() - INTERVAL '1 day',
   NOW() - INTERVAL '1 day')
ON CONFLICT (entity_id) DO UPDATE SET
  summary = EXCLUDED.summary,
  summary_updated_at = EXCLUDED.summary_updated_at,
  updated_at = EXCLUDED.updated_at;

COMMIT;
