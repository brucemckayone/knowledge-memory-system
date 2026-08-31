-- 058_hnsw_iterative_scan.sql — make FILTERED vector search return its results
-- (bead nmemo-vga, found while fixing the fact-vector read end).
--
-- Background: every filtered vector search in this codebase has the shape
--
--   SELECT ... FROM public.facts f
--   WHERE f.corpus_id = $1 AND ...          -- b-tree-able predicates
--   ORDER BY f.fact_embedding <=> $2 LIMIT k
--
-- pgvector's HNSW index cannot apply that WHERE clause during the graph walk. It
-- returns the `hnsw.ef_search` nearest candidates GLOBALLY (default 40), and
-- Postgres filters afterwards. Anything the filter removes is simply lost — the
-- scan does not go back for more. `searchFacts`, `findSimilarEntities`,
-- `recallAcrossCorpus`, `predicate-resolve` and `merge-scorer` all have this shape.
--
-- Measured on cognitive_test (5,714 embedded facts, 60 deterministic query
-- vectors, target slice = corpus arxiv-nlp ≈ 50% of rows):
--
--   iterative_scan = off          mean 7.23 of 10 rows, 6/60 queries returned
--                                 ZERO rows, recall@10 vs exact = 0.715
--   iterative_scan = strict_order mean 10.00 of 10 rows, 0 zero-result queries,
--                                 recall@10 = 0.975 (ordinary HNSW approximation)
--
-- The failure band is MODERATELY selective filters, not highly selective ones,
-- and that is counter-intuitive enough to record: at 0.8% selectivity (corpus +
-- predicate, 46 of 5,714 rows) the planner switches to a BitmapAnd over
-- idx_facts_predicate + idx_facts_corpus and an exact Sort, so recall is 1.000 in
-- BOTH arms. The defect needs the planner to pick the HNSW index AND the filter
-- to eat most of the ef_search neighbourhood. A `corpus_id` filter on this
-- substrate sits exactly there. On a near-empty database the planner never picks
-- HNSW at all, which is why this never appeared in development — the same
-- batch-size-dependent, silent-degradation shape as the causal-prompt overflow.
--
-- Fix: pgvector 0.8's iterative index scan (available here, vector 0.8.2). The
-- scan resumes the HNSW walk until it has enough rows that pass the filter.
-- `strict_order` (not `relaxed_order`) because retrieval ranking and any RRF
-- built on it must see exact distance order.
--
-- Set at DATABASE level rather than per query: the alternative is remembering a
-- `SET LOCAL` in a transaction at every one of the five-plus call sites, and a
-- forgotten one degrades silently — the failure mode this whole migration is
-- about. `startup-validation.ts` asserts the setting so it is a checked
-- guarantee rather than an assumed one (the blocker-6 lesson: no DB guarantee
-- that nothing verifies).
--
-- Note: ALTER DATABASE ... SET affects NEW sessions only, so the session running
-- this migration will not observe it. `hnsw.max_scan_tuples` (default 20,000)
-- still bounds the walk; at this corpus size it is not reached.

DO $$
BEGIN
  EXECUTE format(
    'ALTER DATABASE %I SET hnsw.iterative_scan = %L',
    current_database(),
    'strict_order'
  );
END $$;
