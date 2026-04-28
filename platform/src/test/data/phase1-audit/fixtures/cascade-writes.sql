-- cascade-writes.sql (v1.0)
-- Phase 1 (Audit Trail Foundation) — L2 cascade scenario
-- Complexity score: 39 (rows=8, edges=3, stressors=2)
-- Stressors:
--   cascade-fanout=3
--   cascade-selectivity=2-of-3
--
-- UUID map:
--   entities 00000000-0000-0000-0000-0000000000XX
--     01 subject_A  (F_upstream)
--     02 object_A   (F_upstream)
--     03 subject_B  (F_independent)
--     04 object_B   (F_independent)
--   facts 10000000-...-XX
--     01 F_upstream, 02 F_independent
--   causal_events 20000000-...-XX
--     01 CE_upstream, 02 CE_independent
--   causal_edges 30000000-...-XX
--     01 E1  cites only F_upstream           → cascade-weaken
--     02 E2  cites F_upstream + F_independent → cascade-weaken (survives)
--     03 E3  cites only F_independent        → NO cascade
--   fact_history 40000000-...-XX
--     01 graph_agent created for F_upstream
--     02 graph_agent created for F_independent
--   reasoning_reports 50000000-...-01  seed report
--   causal_edge_history 60000000-...-XX (one per seed edge)
--
-- Harness action: expireFact(F_upstream) — writes new reasoning_report, new
-- fact_history (reasoning_agent/expired), then cascades to E1 (weakened,
-- actor=cascade) and E2 (weakened, actor=cascade). E3 untouched.

BEGIN;

-- Entities -----------------------------------------------------------------
INSERT INTO public.entities (id, canonical_name, entity_type, embedding, confidence) VALUES
  ('00000000-0000-0000-0000-000000000001', 'Alpha Corp', 'company', ARRAY(SELECT random() FROM generate_series(1, 768))::vector, 1.0),
  ('00000000-0000-0000-0000-000000000002', 'ProductX',   'product', ARRAY(SELECT random() FROM generate_series(1, 768))::vector, 1.0),
  ('00000000-0000-0000-0000-000000000003', 'Beta Corp',  'company', ARRAY(SELECT random() FROM generate_series(1, 768))::vector, 1.0),
  ('00000000-0000-0000-0000-000000000004', 'ProductY',   'product', ARRAY(SELECT random() FROM generate_series(1, 768))::vector, 1.0)
ON CONFLICT (id) DO NOTHING;

-- Facts --------------------------------------------------------------------
INSERT INTO public.facts (id, subject_entity_id, predicate, object_entity_id, confidence, valid_at, invalid_at) VALUES
  ('10000000-0000-0000-0000-000000000001',
   '00000000-0000-0000-0000-000000000001', 'manufactures',
   '00000000-0000-0000-0000-000000000002', 0.9,
   TIMESTAMPTZ '2026-01-01 00:00:00+00', NULL),
  ('10000000-0000-0000-0000-000000000002',
   '00000000-0000-0000-0000-000000000003', 'distributes',
   '00000000-0000-0000-0000-000000000004', 0.9,
   TIMESTAMPTZ '2026-01-01 00:00:00+00', NULL)
ON CONFLICT (id) DO NOTHING;

-- Reasoning report (seed) --------------------------------------------------
-- Live schema (migration 008): mode + report (NOT NULL); no `summary` column.
INSERT INTO public.reasoning_reports (id, mode, report, created_at) VALUES
  ('50000000-0000-0000-0000-000000000001',
   'patrol',
   'Initial ingestion of upstream + independent facts and derived causal edges',
   TIMESTAMPTZ '2026-01-02 00:00:00+00')
ON CONFLICT (id) DO NOTHING;

-- fact_history seed rows ---------------------------------------------------
INSERT INTO public.fact_history
  (id, fact_id, event_type, new_confidence, reasoning, source_references, reasoning_report_id, actor, occurred_at) VALUES
  ('40000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', 'created', 0.9,
   'Extracted from source corpus during initial ingestion', '[]'::jsonb,
   '50000000-0000-0000-0000-000000000001', 'graph_agent', TIMESTAMPTZ '2026-01-02 00:00:01+00'),
  ('40000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000002', 'created', 0.9,
   'Extracted from source corpus during initial ingestion', '[]'::jsonb,
   '50000000-0000-0000-0000-000000000001', 'graph_agent', TIMESTAMPTZ '2026-01-02 00:00:02+00');

-- Causal events ------------------------------------------------------------
-- Live schema (migration 002): column is `transition_type` (CHECK enum
-- 'created'|'strengthened'|'weakened'|'expired'|'invalidated'); description is
-- `source_text`. The previous v1.0 fixture used `event_type='fact_asserted'`
-- — neither the column nor that enum value exists.
-- Three events so we can build three edges with distinct (cause, effect)
-- pairs (idx_causal_edges_unique forbids duplicates).
INSERT INTO public.causal_events (id, fact_id, transition_type, source_text, occurred_at) VALUES
  ('20000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', 'created',
   'Upstream fact observation', TIMESTAMPTZ '2026-01-02 00:00:03+00'),
  ('20000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000002', 'created',
   'Independent fact observation', TIMESTAMPTZ '2026-01-02 00:00:04+00'),
  ('20000000-0000-0000-0000-000000000003', '10000000-0000-0000-0000-000000000002', 'strengthened',
   'Independent fact corroborated from a second source', TIMESTAMPTZ '2026-01-02 00:00:04.5+00')
ON CONFLICT (id) DO NOTHING;

-- Causal edges -------------------------------------------------------------
-- Live schema (migration 002): extraction_method + initial_strength NOT NULL.
-- corroboration_count drives cascadeFactExpiry behaviour: > 1 weakens, = 1
-- expires. E1 and E2 set to 2 so cascade weakens (matches expected.json).
--
-- E1 cites only F_upstream → cascade-weaken
INSERT INTO public.causal_edges
  (id, cause_event_id, effect_event_id, strength, reasoning, source_references,
   extraction_method, initial_strength, corroboration_count, created_at) VALUES
  ('30000000-0000-0000-0000-000000000001',
   '20000000-0000-0000-0000-000000000001',
   '20000000-0000-0000-0000-000000000002',
   0.80, 'Upstream manufacturing implies downstream distribution pattern',
   '[{"type":"fact","id":"10000000-0000-0000-0000-000000000001","relevance":"primary"}]'::jsonb,
   'fixture', 0.80, 2,
   TIMESTAMPTZ '2026-01-02 00:00:05+00');

-- E2 cites both → cascade-weaken (survives)
-- Uses CE3 (alternate effect) to avoid (cause,effect) collision with E1.
INSERT INTO public.causal_edges
  (id, cause_event_id, effect_event_id, strength, reasoning, source_references,
   extraction_method, initial_strength, corroboration_count, created_at) VALUES
  ('30000000-0000-0000-0000-000000000002',
   '20000000-0000-0000-0000-000000000001',
   '20000000-0000-0000-0000-000000000003',
   0.90, 'Combined manufacturing + distribution evidence',
   '[{"type":"fact","id":"10000000-0000-0000-0000-000000000001","relevance":"primary"},{"type":"fact","id":"10000000-0000-0000-0000-000000000002","relevance":"supporting"}]'::jsonb,
   'fixture', 0.90, 2,
   TIMESTAMPTZ '2026-01-02 00:00:06+00');

-- E3 cites only F_independent → NO cascade
INSERT INTO public.causal_edges
  (id, cause_event_id, effect_event_id, strength, reasoning, source_references,
   extraction_method, initial_strength, corroboration_count, created_at) VALUES
  ('30000000-0000-0000-0000-000000000003',
   '20000000-0000-0000-0000-000000000002',
   '20000000-0000-0000-0000-000000000001',
   0.70, 'Distribution network independent of upstream manufacturer',
   '[{"type":"fact","id":"10000000-0000-0000-0000-000000000002","relevance":"primary"}]'::jsonb,
   'fixture', 0.70, 1,
   TIMESTAMPTZ '2026-01-02 00:00:07+00');

-- Reverse-lookup index — populated by syncEdgeSourceRefs in the service path.
-- Fixture seeds it directly so cascadeFactExpiry's findEdgesCitingReference
-- query returns E1 and E2 when F_upstream is expired.
INSERT INTO public.edge_source_refs (edge_id, ref_type, ref_id, relevance) VALUES
  ('30000000-0000-0000-0000-000000000001', 'fact', '10000000-0000-0000-0000-000000000001', 'primary'),
  ('30000000-0000-0000-0000-000000000002', 'fact', '10000000-0000-0000-0000-000000000001', 'primary'),
  ('30000000-0000-0000-0000-000000000002', 'fact', '10000000-0000-0000-0000-000000000002', 'supporting'),
  ('30000000-0000-0000-0000-000000000003', 'fact', '10000000-0000-0000-0000-000000000002', 'primary')
ON CONFLICT (edge_id, ref_type, ref_id) DO NOTHING;

-- causal_edge_history seed rows -------------------------------------------
INSERT INTO public.causal_edge_history
  (id, edge_id, event_type, new_strength, new_reasoning, added_source_refs,
   reasoning, reasoning_report_id, actor, occurred_at) VALUES
  ('60000000-0000-0000-0000-000000000001',
   '30000000-0000-0000-0000-000000000001', 'created', 0.80,
   'Upstream manufacturing implies downstream distribution pattern',
   '[{"type":"fact","id":"10000000-0000-0000-0000-000000000001","relevance":"primary"}]'::jsonb,
   'Edge asserted during initial graph build',
   '50000000-0000-0000-0000-000000000001', 'graph_agent', TIMESTAMPTZ '2026-01-02 00:00:05+00'),
  ('60000000-0000-0000-0000-000000000002',
   '30000000-0000-0000-0000-000000000002', 'created', 0.90,
   'Combined manufacturing + distribution evidence',
   '[{"type":"fact","id":"10000000-0000-0000-0000-000000000001","relevance":"primary"},{"type":"fact","id":"10000000-0000-0000-0000-000000000002","relevance":"supporting"}]'::jsonb,
   'Edge asserted during initial graph build',
   '50000000-0000-0000-0000-000000000001', 'graph_agent', TIMESTAMPTZ '2026-01-02 00:00:06+00'),
  ('60000000-0000-0000-0000-000000000003',
   '30000000-0000-0000-0000-000000000003', 'created', 0.70,
   'Distribution network independent of upstream manufacturer',
   '[{"type":"fact","id":"10000000-0000-0000-0000-000000000002","relevance":"primary"}]'::jsonb,
   'Edge asserted during initial graph build',
   '50000000-0000-0000-0000-000000000001', 'graph_agent', TIMESTAMPTZ '2026-01-02 00:00:07+00');

COMMIT;
