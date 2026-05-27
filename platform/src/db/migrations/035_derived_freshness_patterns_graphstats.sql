-- 035_derived_freshness_patterns_graphstats.sql — Extend derived_freshness to
-- track pattern_detection and graph_stats cadences (bead nmemo-2yv.72).
--
-- Background: bead nmemo-2yv.84 introduced public.derived_freshness with two
-- rows ('topology', 'clustering') tracking facts_since_compute via an AFTER-
-- INSERT trigger on public.facts. Pattern-detection and graph-stats cadences
-- previously piggybacked on the reasoning-patrol success edge (pipeline.ts
-- counters; reasoning-agent.ts invokeReasoningAgent call site) — Rule 2
-- violation per doc 34 §3.4. This bead re-anchors both computes on the same
-- DB-reactive shape as topology/clustering: a counter on derived_freshness
-- ticked by the existing AFTER-INSERT trigger.
--
-- Two implementation notes:
--
--   1. The trigger function public.bump_derived_freshness_on_fact() from
--      migration 024 has NO WHERE clause — it updates EVERY row in
--      derived_freshness. Adding new rows here automatically extends the
--      counter behaviour without changing the trigger. No new DDL beyond
--      widening the CHECK constraint and seeding the new rows.
--
--   2. The platform layer reads the new counters via per-kind helpers in
--      services/derived-freshness.ts and fires the compute in-process
--      (computeGraphStats / detectCausalPatterns+promotePatterns). Unlike
--      topology + clustering — which proxy through HTTP to ml-services —
--      pattern detection and graph_stats are TS-side functions; no
--      /api/{...}/compute hop is needed.
--
-- AGE search_path gotcha (per CLAUDE.md / 016-021 headers): explicit
-- public. qualifiers throughout so DDL lands in public, not ag_catalog.

-- Widen the CHECK constraint to include the two new kinds. ALTER ... DROP/ADD
-- is the portable shape — postgres can't ALTER a CHECK in place. The DROP
-- accepts IF EXISTS for replay safety against any prior partial application.
ALTER TABLE public.derived_freshness
  DROP CONSTRAINT IF EXISTS derived_freshness_kind_known;

ALTER TABLE public.derived_freshness
  ADD CONSTRAINT derived_freshness_kind_known
  CHECK (derived_kind IN ('topology', 'clustering', 'pattern_detection', 'graph_stats'));

-- Seed the two new rows. ON CONFLICT DO NOTHING for idempotency — a re-run
-- of this migration must not reset a counter that has already advanced.
INSERT INTO public.derived_freshness (derived_kind, facts_since_compute)
VALUES ('pattern_detection', 0), ('graph_stats', 0)
ON CONFLICT (derived_kind) DO NOTHING;
