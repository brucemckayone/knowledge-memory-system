-- 004_entity_summary.sql — Add living summary to entity_meta
--
-- Entity summaries are agent-authored natural language profiles that
-- persist across invocations. They describe who/what an entity is,
-- their current state, narrative role, known aliases, and ambiguities.

DO $$ BEGIN
  ALTER TABLE public.entity_meta ADD COLUMN summary TEXT;
EXCEPTION WHEN duplicate_column THEN NULL;
END $$;
