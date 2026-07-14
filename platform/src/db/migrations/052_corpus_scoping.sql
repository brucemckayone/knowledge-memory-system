-- 052_corpus_scoping.sql — Cross-corpus Phase A: corpus_id partition + guards backstop
-- Bead nmemo-uhp.7. Spec: docs/architecture/cross-corpus-audit/04-hardened-spec.md §3 (D9).
--
-- Adds a corpus_id partition key to the instance tables (entities/facts/causal_events),
-- plus the DB-level backstops that make the four application fusion guards non-bypassable:
--   * composite UNIQUE(id, corpus_id) on entities so facts/merge_candidates can carry a
--     composite FK that forbids a cross-corpus endpoint pair (MATCH SIMPLE ⇒ nullable
--     object_entity_id is skipped, per §3);
--   * a BEFORE-UPDATE immutability trigger rejecting any change to corpus_id (D9) — closes
--     the silent bypass where a bulk UPDATE ... SET subject_entity_id=X, corpus_id=<X's>
--     would migrate a row across corpora without going through entity_merges.
--
-- fact_predicates / entity_types stay GLOBAL (ontology, not instance data) — not scoped.
--
-- AGE note (per project CLAUDE.md): 001 sets session search_path = ag_catalog, public, "$user".
-- We MUST NOT change it and MUST qualify every object with public.
-- Idempotent (re-runnable): ADD COLUMN IF NOT EXISTS; constraints/triggers guarded.

-- ============================================
-- 1. corpus_id on the instance tables
-- ============================================
ALTER TABLE public.entities      ADD COLUMN IF NOT EXISTS corpus_id TEXT NOT NULL DEFAULT 'default';
ALTER TABLE public.facts         ADD COLUMN IF NOT EXISTS corpus_id TEXT NOT NULL DEFAULT 'default';
ALTER TABLE public.causal_events ADD COLUMN IF NOT EXISTS corpus_id TEXT NOT NULL DEFAULT 'default';
-- merge_candidates carries the corpus of the pair it proposes to merge (backstop target).
ALTER TABLE public.merge_candidates ADD COLUMN IF NOT EXISTS corpus_id TEXT NOT NULL DEFAULT 'default';

CREATE INDEX IF NOT EXISTS idx_entities_corpus       ON public.entities(corpus_id);
CREATE INDEX IF NOT EXISTS idx_facts_corpus          ON public.facts(corpus_id);
CREATE INDEX IF NOT EXISTS idx_causal_events_corpus  ON public.causal_events(corpus_id);

-- ============================================
-- 2. Composite key on entities + composite-FK backstops
-- ============================================
-- entities(id, corpus_id) must be UNIQUE so it can be an FK target.
DO $$ BEGIN
  ALTER TABLE public.entities ADD CONSTRAINT entities_id_corpus_uq UNIQUE (id, corpus_id);
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL; END $$;

-- facts endpoints must live in the fact's own corpus. subject is NOT NULL ⇒ always checked;
-- object is nullable ⇒ MATCH SIMPLE skips the check when object_entity_id IS NULL.
DO $$ BEGIN
  ALTER TABLE public.facts ADD CONSTRAINT facts_subject_corpus_fk
    FOREIGN KEY (subject_entity_id, corpus_id) REFERENCES public.entities(id, corpus_id);
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE public.facts ADD CONSTRAINT facts_object_corpus_fk
    FOREIGN KEY (object_entity_id, corpus_id) REFERENCES public.entities(id, corpus_id);
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL; END $$;

-- a merge candidate may only pair two entities of the same corpus (its corpus_id).
DO $$ BEGIN
  ALTER TABLE public.merge_candidates ADD CONSTRAINT merge_candidates_a_corpus_fk
    FOREIGN KEY (entity_a_id, corpus_id) REFERENCES public.entities(id, corpus_id);
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE public.merge_candidates ADD CONSTRAINT merge_candidates_b_corpus_fk
    FOREIGN KEY (entity_b_id, corpus_id) REFERENCES public.entities(id, corpus_id);
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL; END $$;

-- ============================================
-- 3. D9 — corpus_id is immutable (BEFORE UPDATE)
-- ============================================
CREATE OR REPLACE FUNCTION public.reject_corpus_id_change() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.corpus_id IS DISTINCT FROM OLD.corpus_id THEN
    RAISE EXCEPTION 'corpus_id is immutable (% -> %) on %.%',
      OLD.corpus_id, NEW.corpus_id, TG_TABLE_SCHEMA, TG_TABLE_NAME
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_corpus_immutable ON public.entities;
CREATE TRIGGER trg_corpus_immutable BEFORE UPDATE ON public.entities
  FOR EACH ROW EXECUTE FUNCTION public.reject_corpus_id_change();

DROP TRIGGER IF EXISTS trg_corpus_immutable ON public.facts;
CREATE TRIGGER trg_corpus_immutable BEFORE UPDATE ON public.facts
  FOR EACH ROW EXECUTE FUNCTION public.reject_corpus_id_change();

DROP TRIGGER IF EXISTS trg_corpus_immutable ON public.causal_events;
CREATE TRIGGER trg_corpus_immutable BEFORE UPDATE ON public.causal_events
  FOR EACH ROW EXECUTE FUNCTION public.reject_corpus_id_change();
