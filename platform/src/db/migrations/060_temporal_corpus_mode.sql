-- 060_temporal_corpus_mode.sql
-- Bead nmemo-asf.12. Design: docs/architecture/single-graph/39-temporal-fact-model.md (S2 + R1).
--
-- Per-corpus TEMPORAL mode: lets a corpus hold RECURRING truth — the same
-- (subject, predicate, object) true across multiple DISJOINT validity windows
-- (A -> B -> A, an athlete rejoining a club, an award won in separate years).
-- The default single-active-truth model (<=1 active fact per (s,p,o) via
-- uniq_facts_active_triple, mig 037) is CORRECT for extraction and is left
-- BYTE-IDENTICAL for every non-temporal corpus. Only rows in a corpus flagged
-- recurring_facts get the relaxed identity (s,p,o,valid_at). Measured 2026-09-07:
-- 0 of 18,084 (s,p,o) groups in the research substrate recur, so this is inert
-- for existing data (doc 39 §7).
--
-- Explicit public. qualifiers — 001 set search_path = ag_catalog, public at
-- session level (AGE gotcha, CLAUDE.md). Idempotent + RE-RUN-SAFE: db/migrate.ts
-- re-applies every migration on every run with no journal.

-- 1. The per-corpus flag. Orthogonal to the assimilating|comparative `mode`
--    (mig 055) — this is a temporal-identity knob, not a fuse-stance, so it gets
--    its own column rather than a new `mode` value.
ALTER TABLE public.corpus_policies
  ADD COLUMN IF NOT EXISTS recurring_facts BOOLEAN NOT NULL DEFAULT false;

-- 2. Denormalised per-row copy of the flag. A partial/functional unique index
--    cannot join corpus_policies, so the branch value must live on the row.
--    Stamped by createFact on insert (services/facts.ts) and by the temporal-KG
--    load path; re-synced from the policy in step 3.
ALTER TABLE public.facts
  ADD COLUMN IF NOT EXISTS temporal_corpus BOOLEAN NOT NULL DEFAULT false;

-- 3. Re-sync the denormalised flag from the policy. No-op until a corpus is
--    flagged recurring_facts; idempotent (IS DISTINCT FROM guards the write).
UPDATE public.facts f
SET temporal_corpus = cp.recurring_facts
FROM public.corpus_policies cp
WHERE cp.corpus_id = f.corpus_id
  AND f.temporal_corpus IS DISTINCT FROM cp.recurring_facts;

-- 4. Replace uniq_facts_active_triple IN PLACE (same NAME, so mig 037's
--    `CREATE ... IF NOT EXISTS` — which runs before this file every migrate — never
--    re-adds the plain version). Functional key: non-temporal rows use a constant
--    5th component so identity collapses to (s,p,o) EXACTLY as before; temporal
--    rows use valid_at so identity is (s,p,o,valid_at) and disjoint windows of the
--    same statement coexist as active. COALESCE keeps a NULL valid_at from making
--    two temporal rows spuriously distinct (the load enforces non-null valid_at).
DROP INDEX IF EXISTS public.uniq_facts_active_triple;
CREATE UNIQUE INDEX IF NOT EXISTS uniq_facts_active_triple
  ON public.facts (
    subject_entity_id,
    predicate,
    COALESCE(object_entity_id, '00000000-0000-0000-0000-000000000000'::uuid),
    COALESCE(object_value, ''),
    (CASE WHEN temporal_corpus
          THEN COALESCE(valid_at, '-infinity'::timestamptz)
          ELSE '-infinity'::timestamptz END)
  )
  WHERE expired_at IS NULL;
