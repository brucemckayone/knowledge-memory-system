-- 017_candidate_source.sql — Phase 4 cross-cluster candidate generator schema.
-- Implements docs/architecture/truth-graph/25-cross-cluster-generator.md §2.3.
--
-- Adds candidate_source to merge_candidates as an ENUMERATOR-ORIGIN TAG so
-- the reconciliation_agent (and viz / debug surfaces) can see which path
-- produced the row: 'three_signal_scoring' from detectMergeCandidates'
-- within-component sweep, 'cross_cluster_generator' from cross-cluster-
-- generator.ts's component-pair / drift-driven sweep.
--
-- Post-bead .42 (scoreMergeCandidates extraction) and .44 (Reconciliation
-- Agent prompt collapse): both enumerators feed ONE scoring module
-- (merge-scorer.ts), so the 3-signal columns now follow UNIFORM NULL
-- SEMANTICS — a signal is NULL when its inputs are absent (e.g. cross-
-- component pairs have no shared memories so memory_overlap is NULL),
-- populated when inputs exist. This replaces the pre-.42 per-source
-- "NULL by design" lock (originally §2.5 R3 B3): the same invariant
-- ("don't render NULL as 0.00") still holds, but it's now derived from
-- the absence of inputs rather than a per-source policy. The single
-- prompt block in _build_reconciliation_prompt renders NULL as the
-- literal "NULL" for every candidate, regardless of source.
--
-- ON CONFLICT policy: the existing UNIQUE (entity_a_id, entity_b_id) is the
-- upsert target. The pre-.42 service-side "preserve existing
-- cross_cluster_generator tag" rule (originally §2.5 R3 B4) is moot under
-- the unified scorer: each enumerator's upsert call sets its own source
-- tag, both paths write the same signal columns, so there's no source-
-- demotion risk to guard against. Last-writer-wins on the source tag is
-- acceptable because the tag is now informational (enumerator origin),
-- not policy-bearing.
--
-- AGE search_path gotcha (per CLAUDE.md / 016 header): explicit public.
-- qualifiers throughout so DDL lands in public, not ag_catalog.

ALTER TABLE public.merge_candidates
  ADD COLUMN IF NOT EXISTS candidate_source VARCHAR(40) NOT NULL DEFAULT 'three_signal_scoring';

CREATE INDEX IF NOT EXISTS idx_merge_candidates_source
  ON public.merge_candidates (candidate_source);
