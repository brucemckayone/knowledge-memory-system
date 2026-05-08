-- 017_candidate_source.sql — Phase 4 cross-cluster candidate generator schema.
-- Implements docs/architecture/truth-graph/25-cross-cluster-generator.md §2.3.
--
-- Adds candidate_source to merge_candidates so the reconciliation_agent can
-- distinguish 3-signal-scoring rows (the existing generator) from
-- cross-cluster-generator rows (Phase 4). The two sources have different
-- prompting needs (§2.4) and different invariants on the 3-signal columns
-- (cross-cluster rows leave centroid_similarity / memory_overlap /
-- structural_similarity NULL by design — see §2.5 R3 B3 lock).
--
-- ON CONFLICT policy is enforced in the cross-cluster generator service, not
-- the schema: the existing UNIQUE (entity_a_id, entity_b_id) is the upsert
-- target, and the service preserves an existing 'cross_cluster_generator'
-- value rather than letting a later three-signal upsert downgrade the tag
-- (§2.5 R3 B4 lock).
--
-- AGE search_path gotcha (per CLAUDE.md / 016 header): explicit public.
-- qualifiers throughout so DDL lands in public, not ag_catalog.

ALTER TABLE public.merge_candidates
  ADD COLUMN IF NOT EXISTS candidate_source VARCHAR(40) NOT NULL DEFAULT 'three_signal_scoring';

CREATE INDEX IF NOT EXISTS idx_merge_candidates_source
  ON public.merge_candidates (candidate_source);
