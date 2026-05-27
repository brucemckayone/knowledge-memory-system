-- reasoning-history-rich.sql (v1.0)
-- Phase 8 (Reasoning Agent Surface) — bead nmemo-2yv.79 fixture
-- Complexity score: 4 (rows=6, stressors=3)
-- Stressors:
--   1. Multiple reports per entity (drives the limit-param + DESC-order assertions)
--   2. Mixed modes (patrol + query) so the return-shape contract is exercised on both
--   3. One report references TWO entities (the dispatcher's @> ARRAY[entityId]
--      semantics — a report attached to entity A must surface for both A and B
--      lookups, but NOT for an unrelated entity C)
--
-- Schema reference: src/db/schema.ts → reasoningReports
--   id uuid PK, mode varchar(20), question text, report text,
--   actions_taken jsonb, entity_ids uuid[], fact_ids uuid[],
--   causal_edge_ids uuid[], created_at timestamptz
--
-- Used by: src/test/harness/reasoning-agent-surface.test.ts
--
-- UUID map:
--   Entity A         : 79000000-0000-0000-0001-000000000001
--   Entity B         : 79000000-0000-0000-0001-000000000002
--   Entity C (unused): 79000000-0000-0000-0001-000000000003
--   Report 1 (A)     : 79000000-2000-0000-0001-000000000001 (patrol, oldest)
--   Report 2 (A)     : 79000000-2000-0000-0001-000000000002 (query)
--   Report 3 (A+B)   : 79000000-2000-0000-0001-000000000003 (patrol)
--   Report 4 (B)     : 79000000-2000-0000-0001-000000000004 (patrol, newest)
--   Report 5 (C)     : 79000000-2000-0000-0001-000000000005 (patrol; unrelated to A)

BEGIN;

INSERT INTO public.entities (id, canonical_name, entity_type, embedding, confidence)
VALUES
  ('79000000-0000-0000-0001-000000000001', 'phase8-rich-A', 'person',
   ARRAY(SELECT random() FROM generate_series(1, 768))::vector, 1.0),
  ('79000000-0000-0000-0001-000000000002', 'phase8-rich-B', 'person',
   ARRAY(SELECT random() FROM generate_series(1, 768))::vector, 1.0),
  ('79000000-0000-0000-0001-000000000003', 'phase8-rich-C', 'person',
   ARRAY(SELECT random() FROM generate_series(1, 768))::vector, 1.0)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.reasoning_reports
  (id, mode, question, report, entity_ids, fact_ids, causal_edge_ids, actions_taken, created_at)
VALUES
  ('79000000-2000-0000-0001-000000000001',
   'patrol', NULL,
   '[bead-79-fixture] Patrol pass over A — oldest entry; surfaces last in DESC order.',
   ARRAY['79000000-0000-0000-0001-000000000001']::uuid[],
   ARRAY[]::uuid[], ARRAY[]::uuid[],
   '{"summary": "no-op patrol", "duration_ms": 412}'::jsonb,
   '2026-05-01 10:00:00+00'),
  ('79000000-2000-0000-0001-000000000002',
   'query', 'Why did A move?',
   '[bead-79-fixture] Query pass — second-oldest for A.',
   ARRAY['79000000-0000-0000-0001-000000000001']::uuid[],
   ARRAY[]::uuid[], ARRAY[]::uuid[],
   '{"summary": "answered", "duration_ms": 1844}'::jsonb,
   '2026-05-05 11:30:00+00'),
  ('79000000-2000-0000-0001-000000000003',
   'patrol', NULL,
   '[bead-79-fixture] Patrol pass touching both A and B — middle of timeline.',
   ARRAY['79000000-0000-0000-0001-000000000001', '79000000-0000-0000-0001-000000000002']::uuid[],
   ARRAY[]::uuid[], ARRAY[]::uuid[],
   '{"summary": "linked A and B", "duration_ms": 920}'::jsonb,
   '2026-05-10 14:15:00+00'),
  ('79000000-2000-0000-0001-000000000004',
   'patrol', NULL,
   '[bead-79-fixture] Patrol pass over B — newest in timeline. For A this is invisible.',
   ARRAY['79000000-0000-0000-0001-000000000002']::uuid[],
   ARRAY[]::uuid[], ARRAY[]::uuid[],
   '{"summary": "B-only patrol", "duration_ms": 305}'::jsonb,
   '2026-05-20 09:45:00+00'),
  ('79000000-2000-0000-0001-000000000005',
   'patrol', NULL,
   '[bead-79-fixture] Patrol over C — must NOT appear in A or B queries.',
   ARRAY['79000000-0000-0000-0001-000000000003']::uuid[],
   ARRAY[]::uuid[], ARRAY[]::uuid[],
   '{"summary": "C-only patrol"}'::jsonb,
   '2026-05-15 13:00:00+00')
ON CONFLICT (id) DO NOTHING;

COMMIT;
