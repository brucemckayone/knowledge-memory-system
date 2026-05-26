-- 027_same_as_created_by_default.sql — Bead nmemo-2yv.66
--
-- Relax the same_as_links.created_by default from 'reconciliation_agent'
-- to 'unknown'. The application-layer handler (causal-agent.ts
-- create_same_as_link) now always supplies the actual caller actor from
-- the dispatcher's resolved ToolCallContext. If a write ever lands on the
-- DB without an explicit value, that's a code-path bug worth surfacing
-- (an 'unknown' row in audit queries) rather than a silent attribution
-- to reconciliation_agent.
--
-- Backfill note: existing rows attributed to 'reconciliation_agent' from
-- before this fix are NOT retroactively re-attributed. They remain
-- 'reconciliation_agent' even when the actual creator was the gardener.
-- Forensic queries against rows created before this migration cannot
-- reliably distinguish gardener-driven from reconciliation-driven
-- attribution. See docs/architecture/truth-graph/issues/05-merge-same-as-quality.md
-- §What May Still Need Attention item 1 (now resolved).
--
-- NOTE: Uses explicit public. schema qualifier (AGE sets search_path =
-- ag_catalog first, so unqualified names resolve to ag_catalog not public).

ALTER TABLE public.same_as_links
  ALTER COLUMN created_by SET DEFAULT 'unknown';
