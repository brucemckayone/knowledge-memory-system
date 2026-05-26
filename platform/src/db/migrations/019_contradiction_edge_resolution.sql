-- 019_contradiction_edge_resolution.sql — Extend contradictions.resolution_type
-- vocabulary with three edge-mutating variants for the cyclic_causal /
-- temporal_impossible / expired_but_cited detection types.
--
-- Background: bead nmemo-2yv.37. Three of the five contradiction detection
-- types flag conflicts on edges rather than facts (cyclic_causal,
-- temporal_impossible, expired_but_cited). The historical resolveContradiction
-- dispatcher only knew fact-mutating types (expire_a/b/both, invalidate_a/b)
-- plus no-op closers (reconcile / both_valid / dismissed), so edge-only
-- contradictions could only be falsely "resolved" without touching the
-- broken edge in the graph.
--
-- This migration swaps the valid_resolution_type CHECK to allow:
--   expire_edge_a, expire_edge_b, expire_both_edges
-- alongside the original eight values. The resolveContradiction switch in
-- contradictions.ts dispatches these to expireCausalEdge (which writes
-- causal_edges.expired_at and a causal_edge_history 'expired' row in one tx).
--
-- AGE search_path gotcha (per CLAUDE.md / 016-018 headers): explicit public.
-- qualifiers so DDL lands in public, not ag_catalog.

ALTER TABLE public.contradictions
  DROP CONSTRAINT IF EXISTS valid_resolution_type;

ALTER TABLE public.contradictions
  ADD CONSTRAINT valid_resolution_type CHECK (
    resolution_type IS NULL OR resolution_type IN (
      'expire_a', 'expire_b', 'expire_both',
      'invalidate_a', 'invalidate_b',
      'expire_edge_a', 'expire_edge_b', 'expire_both_edges',
      'reconcile', 'both_valid', 'dismissed'
    )
  );
