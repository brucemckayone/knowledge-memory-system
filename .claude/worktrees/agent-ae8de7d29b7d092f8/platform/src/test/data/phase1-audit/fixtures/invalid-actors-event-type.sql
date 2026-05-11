-- MUST FAIL: tests CHECK constraint valid_fact_event_type — every case uses a valid actor so the ONLY failure surface is the event_type enum.
-- invalid-actors-event-type.sql
-- Phase 1 adversarial variant — event_type axis
-- Complexity score: 44 (rows=0, cases=4 as stressors-weighted; seed provided by invalid-actors.sql)
-- Stressors: Adversarial-structural=unknown-enum-values, Adversarial-temporal=future-reserved-event-type
--
-- NOTE: Assumes seed entity + fact from invalid-actors.sql are already committed.
-- All cases use actor='graph_agent'.

-- CASE 1: misspelled event_type 'creted' → db_constraint:valid_fact_event_type (23514)
BEGIN;
INSERT INTO public.fact_history (id, fact_id, event_type, reasoning, source_references, actor)
VALUES ('bbbbbbbb-0000-0000-0000-000000000001',
        '10000000-0000-0000-0000-000000000099',
        'creted', 'typo probe', '[]'::jsonb, 'graph_agent');
ROLLBACK;

-- CASE 2: capitalized event_type 'CREATED' → db_constraint:valid_fact_event_type (23514)
BEGIN;
INSERT INTO public.fact_history (id, fact_id, event_type, reasoning, source_references, actor)
VALUES ('bbbbbbbb-0000-0000-0000-000000000002',
        '10000000-0000-0000-0000-000000000099',
        'CREATED', 'case probe', '[]'::jsonb, 'graph_agent');
ROLLBACK;

-- CASE 3: future-reserved event_type 'archived' → db_constraint:valid_fact_event_type (23514)
BEGIN;
INSERT INTO public.fact_history (id, fact_id, event_type, reasoning, source_references, actor)
VALUES ('bbbbbbbb-0000-0000-0000-000000000003',
        '10000000-0000-0000-0000-000000000099',
        'archived', 'future-reserved probe', '[]'::jsonb, 'graph_agent');
ROLLBACK;

-- CASE 4: empty-string event_type → db_constraint:valid_fact_event_type (23514)
BEGIN;
INSERT INTO public.fact_history (id, fact_id, event_type, reasoning, source_references, actor)
VALUES ('bbbbbbbb-0000-0000-0000-000000000004',
        '10000000-0000-0000-0000-000000000099',
        '', 'empty event_type probe', '[]'::jsonb, 'graph_agent');
ROLLBACK;
