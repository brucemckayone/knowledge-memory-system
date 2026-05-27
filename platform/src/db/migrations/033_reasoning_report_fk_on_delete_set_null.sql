-- 033_reasoning_report_fk_on_delete_set_null.sql — Explicit ON DELETE SET NULL
-- on every FK referencing public.reasoning_reports(id). Bead nmemo-2yv.78.
--
-- Background: three FK columns reference public.reasoning_reports(id) without
-- an explicit ON DELETE clause, so PostgreSQL fell back to NO ACTION
-- (effectively RESTRICT at commit time). Nobody declared the policy — the
-- defaulted behaviour silently blocks any future "prune old reasoning
-- reports" pass and has already pushed src/test/harness/contradictions.test.ts
-- (cleanSlate, formerly lines 67-69) into a hand-maintained
--   `DELETE FROM public.reasoning_reports`
-- workaround because deleteFromTables's canonical order couldn't include the
-- table without provoking the constraint.
--
-- Affected columns (verified against pg_constraint at write time —
-- constraint names match the PostgreSQL auto-generated `*_fkey` shape):
--   - fact_history.reasoning_report_id          → fact_history_reasoning_report_id_fkey
--     (009_audit_trail.sql:36)
--   - causal_edge_history.reasoning_report_id   → causal_edge_history_reasoning_report_id_fkey
--     (009_audit_trail.sql:82)
--   - contradictions.resolution_report_id       → contradictions_resolution_report_id_fkey
--     (011_contradictions.sql:57)
--
-- Right policy is ON DELETE SET NULL. The history tables ARE the audit trail
-- — they must outlive any storage-pressure prune of reasoning_reports.
-- CASCADE would silently destroy audit rows (wrong direction). NO ACTION
-- prevents the prune. SET NULL preserves the audit row while acknowledging
-- the provenance link is gone. All three columns are already nullable —
-- non-agent actors (user, system_trigger, cascade) already write history
-- rows with NULL reasoning_report_id today.
--
-- Aligns with the "Explicit Over Implicit" principle articulated in
-- docs/architecture/truth-graph/10-reasoning-layer-overview.md: every
-- history row carries the actor, the reasoning, and the reasoning_report_id
-- that caused it. The column is the link, not the parent.
--
-- Production impact today: zero. No production code path deletes
-- reasoning_reports rows. This change is policy-explicit + future-proofing.
-- The test workaround at the old contradictions.test.ts cleanSlate becomes
-- unnecessary; reasoning_reports joins deleteFromTables's canonical order
-- (src/test/setup.ts) so future tests don't have to hand-maintain teardown.
--
-- Idempotent re-run: DROP CONSTRAINT IF EXISTS clears any prior definition
-- (named or auto-generated) before re-adding under the original PostgreSQL-
-- generated name. Forward-only — rolling back ON DELETE SET NULL to NO
-- ACTION re-introduces the latent defect, so fix forward.
--
-- AGE search_path gotcha (per CLAUDE.md / 020+ headers): 001 set
-- search_path = ag_catalog, public, "$user" at session level. DO NOT change
-- it — AGE and Graph S triggers depend on ag_catalog being in the path.
-- Explicit public. qualifier on every DDL statement.

ALTER TABLE public.fact_history
  DROP CONSTRAINT IF EXISTS fact_history_reasoning_report_id_fkey;
ALTER TABLE public.fact_history
  ADD CONSTRAINT fact_history_reasoning_report_id_fkey
    FOREIGN KEY (reasoning_report_id)
    REFERENCES public.reasoning_reports(id)
    ON DELETE SET NULL;

ALTER TABLE public.causal_edge_history
  DROP CONSTRAINT IF EXISTS causal_edge_history_reasoning_report_id_fkey;
ALTER TABLE public.causal_edge_history
  ADD CONSTRAINT causal_edge_history_reasoning_report_id_fkey
    FOREIGN KEY (reasoning_report_id)
    REFERENCES public.reasoning_reports(id)
    ON DELETE SET NULL;

ALTER TABLE public.contradictions
  DROP CONSTRAINT IF EXISTS contradictions_resolution_report_id_fkey;
ALTER TABLE public.contradictions
  ADD CONSTRAINT contradictions_resolution_report_id_fkey
    FOREIGN KEY (resolution_report_id)
    REFERENCES public.reasoning_reports(id)
    ON DELETE SET NULL;
