-- MUST FAIL: tests CHECK constraint valid_fact_actor is case-sensitive — every case uses a valid event_type so the ONLY failure surface is the actor enum.
-- invalid-actors-case-sensitivity.sql
-- Phase 1 adversarial variant — case + whitespace axis
-- Complexity score: 44 (cases=4 stressors-weighted; seed provided by invalid-actors.sql)
-- Stressors: Adversarial-structural=case-and-whitespace-variants
--
-- NOTE: Assumes seed from invalid-actors.sql is committed.

-- CASE 1: all-upper 'GRAPH_AGENT' → db_constraint:valid_fact_actor (23514)
BEGIN;
INSERT INTO public.fact_history (id, fact_id, event_type, reasoning, source_references, actor)
VALUES ('cccccccc-0000-0000-0000-000000000001',
        '10000000-0000-0000-0000-000000000099',
        'created', 'upper-case probe', '[]'::jsonb, 'GRAPH_AGENT');
ROLLBACK;

-- CASE 2: title-case 'Graph_Agent' → db_constraint:valid_fact_actor (23514)
BEGIN;
INSERT INTO public.fact_history (id, fact_id, event_type, reasoning, source_references, actor)
VALUES ('cccccccc-0000-0000-0000-000000000002',
        '10000000-0000-0000-0000-000000000099',
        'created', 'title-case probe', '[]'::jsonb, 'Graph_Agent');
ROLLBACK;

-- CASE 3: hyphenated 'graph-agent' → db_constraint:valid_fact_actor (23514)
BEGIN;
INSERT INTO public.fact_history (id, fact_id, event_type, reasoning, source_references, actor)
VALUES ('cccccccc-0000-0000-0000-000000000003',
        '10000000-0000-0000-0000-000000000099',
        'created', 'separator-drift probe', '[]'::jsonb, 'graph-agent');
ROLLBACK;

-- CASE 4: trailing space 'graph_agent ' → db_constraint:valid_fact_actor (23514)
BEGIN;
INSERT INTO public.fact_history (id, fact_id, event_type, reasoning, source_references, actor)
VALUES ('cccccccc-0000-0000-0000-000000000004',
        '10000000-0000-0000-0000-000000000099',
        'created', 'trailing-space probe', '[]'::jsonb, 'graph_agent ');
ROLLBACK;
