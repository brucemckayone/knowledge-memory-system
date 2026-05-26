-- 025_scoring_version.sql — Per-pair scoring audit trail for merge_candidates.
--
-- Bead nmemo-2yv.43. The merge-scorer's per-pair combined_score is now a
-- function of the GRAPH'S aggregate state (via graph_stats), not a static
-- formula — see merge-scorer.ts adaptWeights() and doc 22 §2.2 row 2.
-- Without recording the effective weight vector used at scoring time, two
-- runs that produced different scores for the same pair are mutually
-- inexplicable: the inputs (signals) might be identical, but the modulation
-- rules consumed different graph_stats snapshots.
--
-- scoring_version JSONB carries the audit record. Shape:
--   {
--     "weights": { "centroidSimilarity": 0.075, "memoryOverlap": 0.18, ... },
--     "graph_stats_snapshot": {
--       "centroid_sim_p10":         <float|null>,
--       "centroid_sim_p90":         <float|null>,
--       "embedding_cluster_count":  <int|null>,
--       "computed_at":              <iso8601-string|null>
--     },
--     "adapted": <bool>     -- false when adaptWeights() returned base unchanged
--   }
-- Nullable: pre-adaptive rows (this migration runs against existing data)
-- leave the column NULL. New writes always populate it.
--
-- AGE search_path gotcha (per CLAUDE.md / 016-024 headers): explicit
-- public. qualifiers throughout so DDL lands in public, not ag_catalog.

ALTER TABLE public.merge_candidates
  ADD COLUMN IF NOT EXISTS scoring_version JSONB;

-- No index — this column is for forensic queries (audit / debugging), not
-- selection. Adding a GIN would inflate the table without query support.
