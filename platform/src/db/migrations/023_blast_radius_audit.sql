-- nmemo-2yv.102 — Service-level blast-radius audit columns.
--
-- Three nullable JSONB columns capturing the pre-mutation severitySummary at
-- the moment of agent-initiated destructive actions. Populated by the service
-- layer; NULL when preflight was not run (cascade-internal mutations, legacy
-- rows). Warn-only observability — never blocks the mutation.
--
-- The bead body cites file `012_blast_radius_audit.sql`; that number was
-- already taken by 012_pattern_rejected.sql before the bead was claimed, so
-- the file lands as 023 instead. Spec contract (three columns, comments,
-- nullable, no indexes/FKs) is unchanged.
--
-- See docs/architecture/truth-graph/15-blast-radius-analysis.md §"Audit Surface".

-- IF NOT EXISTS keeps the migration idempotent under replay. migrate.ts logs
-- and continues on per-file errors (no abort) — without IF NOT EXISTS, every
-- re-run after the first emits noise that buries genuine failures of later
-- migrations on the same boot. Matches the convention in 017/021.

ALTER TABLE public.fact_history
  ADD COLUMN IF NOT EXISTS pre_expire_blast_radius JSONB NULL;

ALTER TABLE public.causal_edge_history
  ADD COLUMN IF NOT EXISTS pre_expire_blast_radius JSONB NULL;

ALTER TABLE public.contradictions
  ADD COLUMN IF NOT EXISTS pre_resolve_blast_radius JSONB NULL;

COMMENT ON COLUMN public.fact_history.pre_expire_blast_radius IS
  'BlastRadiusReport.severitySummary captured at the moment of expire/invalidate. NULL for cascade-internal mutations or legacy rows.';

COMMENT ON COLUMN public.causal_edge_history.pre_expire_blast_radius IS
  'BlastRadiusReport.severitySummary captured at the moment of edge expiry. NULL for cascade-internal mutations or legacy rows.';

COMMENT ON COLUMN public.contradictions.pre_resolve_blast_radius IS
  'BlastRadiusReport.severitySummary for the fact/edge targeted by the resolution. For expire_both / expire_both_edges, contains both severities keyed by fact_a/fact_b/edge_a/edge_b.';
