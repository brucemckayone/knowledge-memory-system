-- 030_candidate_source_check.sql — Add CHECK constraint enumerating the
-- two valid candidate_source values on merge_candidates. Bead nmemo-2yv.93.
--
-- Background: migration 017_candidate_source.sql added candidate_source
-- VARCHAR(40) NOT NULL DEFAULT 'three_signal_scoring' to merge_candidates
-- (doc 25 §2.3 / §3.3) but did NOT add a CHECK constraint. The set of
-- valid values is fixed at exactly two: 'three_signal_scoring' (from
-- detectMergeCandidates' within-component sweep via graph-meta.ts) and
-- 'cross_cluster_generator' (from cross-cluster-generator.ts's
-- component-pair / drift-driven sweep).
--
-- The reconciliation_agent's prompt-builder branches on exact string
-- equality (ml-services/app/reconciliation_agent.py
-- _build_reconciliation_prompt) — an unknown source falls back to the
-- generic three-signal block, silently delivering wrong context to the
-- LLM. A typo in either writer would slip through with no signal at the
-- schema layer.
--
-- This migration adds CONSTRAINT valid_candidate_source matching the
-- pattern of the sibling constraints on the same table:
--   - valid_candidate_status (003_graph_meta.sql:67)
--   - valid_resolution (018_resolution_enum_align.sql:33)
--
-- Future new-source onboarding (doc 26 structural-embeddings is the
-- next likely candidate per doc 25 §2.3) ships a follow-up migration
-- that drops + recreates the CHECK with the new value included, in
-- the same landing as the writer + prompt-builder + viz changes. See
-- doc 26 §3.4 "Onboarding a new candidate_source value" for the
-- checklist.
--
-- Idempotent re-run: DROP CONSTRAINT IF EXISTS clears any prior
-- definition before re-adding. The ALTER ADD itself fails if existing
-- rows violate the predicate — by design (data corruption signal).
--
-- AGE search_path gotcha (per CLAUDE.md / 020+ headers): 001 set
-- search_path = ag_catalog, public, "$user" at session level. DO NOT
-- change it — AGE and Graph S triggers depend on ag_catalog being in
-- the path. Explicit public. qualifier on every DDL statement.

ALTER TABLE public.merge_candidates
  DROP CONSTRAINT IF EXISTS valid_candidate_source;

-- keep in sync with src/services/enums.ts:CANDIDATE_SOURCE_VALUES (bead nmemo-2yv.93)
ALTER TABLE public.merge_candidates
  ADD CONSTRAINT valid_candidate_source CHECK (
    candidate_source IN ('three_signal_scoring', 'cross_cluster_generator')
  );
