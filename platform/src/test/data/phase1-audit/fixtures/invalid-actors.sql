-- MUST FAIL (adversarial suite): every CASE below must be rejected at its declared rejection surface.
-- invalid-actors.sql (v1.0)
-- Phase 1 (Audit Trail Foundation) — adversarial L1 suite
-- Complexity score: 105 (rows=2, cases=10 as stressors-weighted)
-- Stressors:
--   Adversarial-structural=unknown-enum-values, length-overflow, injection-string
--   Adversarial-temporal=future-reserved-event-type
--   Domain-realistic=actor-like-but-invalid-strings
--
-- UUID map:
--   Entity        : 00000000-0000-0000-0000-000000000001
--   Object entity : 00000000-0000-0000-0000-000000000099
--   Fact          : 10000000-0000-0000-0000-000000000099
--
-- CASES
--   1  unknown actor literal 'hacker_bot'                 → db_constraint:valid_fact_actor
--   2  SQL-injection style actor                          → db_constraint:valid_fact_actor
--   3  actor length > 32 chars (VARCHAR(32) overflow)     → db_length:actor_varchar32
--   4  unknown event_type 'deleted'                       → db_constraint:valid_fact_event_type
--   5  whitespace-only reasoning '   '                    → service_layer:empty_reasoning
--   6  NULL reasoning                                     → db_notnull:reasoning
--   7  empty-string actor ''                              → db_constraint:valid_fact_actor
--   8  actor with leading TAB control char                → db_constraint:valid_fact_actor
--   9  NULL actor                                         → db_notnull:actor
--  10  case-variant actor 'Graph_Agent'                   → db_constraint:valid_fact_actor

-- ---- SEED (committed — valid FK target so CHECK is the failing surface) --
BEGIN;
INSERT INTO public.entities (id, canonical_name, entity_type, embedding, confidence) VALUES
  ('00000000-0000-0000-0000-000000000001', 'Seed Subject', 'person',  ARRAY(SELECT random() FROM generate_series(1, 768))::vector, 1.0),
  ('00000000-0000-0000-0000-000000000099', 'Seed Object',  'company', ARRAY(SELECT random() FROM generate_series(1, 768))::vector, 1.0)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.facts (id, subject_entity_id, predicate, object_entity_id, confidence, valid_at)
VALUES (
  '10000000-0000-0000-0000-000000000099',
  '00000000-0000-0000-0000-000000000001',
  'works_at',
  '00000000-0000-0000-0000-000000000099',
  0.9,
  NOW()
) ON CONFLICT (id) DO NOTHING;
COMMIT;

-- ============================================================================
-- CASE 1: unknown actor literal 'hacker_bot'
-- EXPECTED: db_constraint:valid_fact_actor (SQLSTATE 23514)
BEGIN;
INSERT INTO public.fact_history (id, fact_id, event_type, reasoning, source_references, actor)
VALUES ('aaaaaaaa-0000-0000-0000-000000000001',
        '10000000-0000-0000-0000-000000000099',
        'created', 'legitimate-looking reason', '[]'::jsonb, 'hacker_bot');
ROLLBACK;

-- ============================================================================
-- CASE 2: SQL-injection style actor value
-- EXPECTED: db_constraint:valid_fact_actor (SQLSTATE 23514)
BEGIN;
INSERT INTO public.fact_history (id, fact_id, event_type, reasoning, source_references, actor)
VALUES ('aaaaaaaa-0000-0000-0000-000000000002',
        '10000000-0000-0000-0000-000000000099',
        'created', 'injection probe', '[]'::jsonb, ''' OR 1=1 --');
ROLLBACK;

-- ============================================================================
-- CASE 3: actor > 32 chars — VARCHAR(32) length overflow
-- EXPECTED: db_length:actor_varchar32 (SQLSTATE 22001)
BEGIN;
INSERT INTO public.fact_history (id, fact_id, event_type, reasoning, source_references, actor)
VALUES ('aaaaaaaa-0000-0000-0000-000000000003',
        '10000000-0000-0000-0000-000000000099',
        'created', 'length overflow probe', '[]'::jsonb, 'graph_agent_with_a_very_long_suffix_beyond_32');
ROLLBACK;

-- ============================================================================
-- CASE 4: unknown event_type 'deleted'
-- EXPECTED: db_constraint:valid_fact_event_type (SQLSTATE 23514)
BEGIN;
INSERT INTO public.fact_history (id, fact_id, event_type, reasoning, source_references, actor)
VALUES ('aaaaaaaa-0000-0000-0000-000000000004',
        '10000000-0000-0000-0000-000000000099',
        'deleted', 'should be rejected', '[]'::jsonb, 'graph_agent');
ROLLBACK;

-- ============================================================================
-- CASE 5: whitespace-only reasoning '   '
-- EXPECTED: service_layer:empty_reasoning (DB NOT NULL is satisfied by '   ';
--           service layer MUST catch before INSERT)
BEGIN;
INSERT INTO public.fact_history (id, fact_id, event_type, reasoning, source_references, actor)
VALUES ('aaaaaaaa-0000-0000-0000-000000000005',
        '10000000-0000-0000-0000-000000000099',
        'created', '   ', '[]'::jsonb, 'graph_agent');
ROLLBACK;

-- ============================================================================
-- CASE 6: NULL reasoning
-- EXPECTED: db_notnull:reasoning (SQLSTATE 23502)
BEGIN;
INSERT INTO public.fact_history (id, fact_id, event_type, reasoning, source_references, actor)
VALUES ('aaaaaaaa-0000-0000-0000-000000000006',
        '10000000-0000-0000-0000-000000000099',
        'created', NULL, '[]'::jsonb, 'graph_agent');
ROLLBACK;

-- ============================================================================
-- CASE 7: empty-string actor ''
-- EXPECTED: db_constraint:valid_fact_actor (SQLSTATE 23514)
BEGIN;
INSERT INTO public.fact_history (id, fact_id, event_type, reasoning, source_references, actor)
VALUES ('aaaaaaaa-0000-0000-0000-000000000007',
        '10000000-0000-0000-0000-000000000099',
        'created', 'empty actor probe', '[]'::jsonb, '');
ROLLBACK;

-- ============================================================================
-- CASE 8: actor with leading TAB control char
-- EXPECTED: db_constraint:valid_fact_actor (SQLSTATE 23514)
BEGIN;
INSERT INTO public.fact_history (id, fact_id, event_type, reasoning, source_references, actor)
VALUES ('aaaaaaaa-0000-0000-0000-000000000008',
        '10000000-0000-0000-0000-000000000099',
        'created', 'control-char smuggling probe', '[]'::jsonb, E'\tgraph_agent');
ROLLBACK;

-- ============================================================================
-- CASE 9: NULL actor
-- EXPECTED: db_notnull:actor (SQLSTATE 23502)
BEGIN;
INSERT INTO public.fact_history (id, fact_id, event_type, reasoning, source_references, actor)
VALUES ('aaaaaaaa-0000-0000-0000-000000000009',
        '10000000-0000-0000-0000-000000000099',
        'created', 'null actor probe', '[]'::jsonb, NULL);
ROLLBACK;

-- ============================================================================
-- CASE 10: case-variant actor 'Graph_Agent'
-- EXPECTED: db_constraint:valid_fact_actor (SQLSTATE 23514)
BEGIN;
INSERT INTO public.fact_history (id, fact_id, event_type, reasoning, source_references, actor)
VALUES ('aaaaaaaa-0000-0000-0000-000000000010',
        '10000000-0000-0000-0000-000000000099',
        'created', 'case-sensitivity probe', '[]'::jsonb, 'Graph_Agent');
ROLLBACK;
