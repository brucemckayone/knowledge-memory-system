-- 034_reasoning_reports_invocation_id.sql — Server-side idempotency for
-- save_reasoning_report. Bead nmemo-2yv.77.
--
-- Background: the "save a report exactly once per pass" contract was enforced
-- entirely by prompt guidance (in three places — the MCP tool description and
-- two passages in the python reasoning agent prompt). The TS handler
-- (src/services/causal-agent.ts:2229) executed a plain INSERT on every call,
-- so any LLM nondeterminism over the 100-tool-call budget, any future retry
-- wrapper, or a sloppy refactor on the python side could silently produce
-- duplicate reasoning_reports rows. Downstream impact when that happens:
--   - get_reasoning_history returns more rows than expected, polluting the
--     prompt context of subsequent patrols.
--   - fact_history.reasoning_report_id / causal_edge_history.reasoning_report_id
--     (set during the pass via update_fact_confidence and similar) reference
--     whichever save row was current at the time of the mutation. A second
--     save row sits orphaned with no audit links — provenance fragments.
--   - entity_meta.last_reasoned_at gets overwritten twice in succession
--     (cosmetic).
--
-- This migration adds a nullable UUID `invocation_id` column carrying the
-- /api/reason invocation identifier. The platform endpoint (src/index.ts)
-- generates it per HTTP request, forwards it through invokeReasoningAgent
-- to ml-services, the python agent renders it into the system prompt, and
-- the LLM passes it back on save_reasoning_report. The TS handler then does
-- INSERT ... ON CONFLICT (invocation_id) DO UPDATE — duplicate calls inside
-- the same pass return the same row id and overwrite (not append) the
-- payload fields.
--
-- The column is nullable + unique-via-partial-index (WHERE invocation_id IS
-- NOT NULL) so that:
--   - legacy callers (older python clients, ad-hoc test fixtures, tools that
--     call handleToolCall directly) keep working with the existing INSERT
--     path — the handler branches on presence.
--   - backfill for existing rows is unnecessary — NULLs don't participate in
--     the unique constraint.
--   - the UPSERT path only kicks in when the platform supplied an id, which
--     is exactly when the agent claims to be running a single /api/reason
--     invocation.
--
-- AGE search_path gotcha (per CLAUDE.md / 020+ migration headers): 001 set
-- search_path = ag_catalog, public, "$user" at session level. DO NOT change
-- it — AGE and Graph S triggers depend on ag_catalog being in the path.
-- Explicit public. qualifier on every DDL statement.
--
-- Forward-only — rolling back the column re-introduces the latent duplicate-
-- row defect, so fix forward.

ALTER TABLE public.reasoning_reports
  ADD COLUMN IF NOT EXISTS invocation_id UUID;

CREATE UNIQUE INDEX IF NOT EXISTS uniq_reasoning_reports_invocation_id
  ON public.reasoning_reports (invocation_id)
  WHERE invocation_id IS NOT NULL;
