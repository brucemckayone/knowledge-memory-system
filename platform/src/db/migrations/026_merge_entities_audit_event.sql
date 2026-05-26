-- 026_merge_entities_audit_event.sql — Add 'merged' fact event type and drop
-- the PL/pgSQL merge_entities() function. Bead nmemo-2yv.30.
--
-- Background: merge_entities() (mig 005, extended by mig 020) silently mutates
-- facts in two ways during a reconciliation merge:
--   1. UPDATE subject_entity_id / object_entity_id from source -> target
--   2. UPDATE expired_at on duplicate rows after re-pointing
-- Neither path writes to public.fact_history, breaking the audit invariant
-- (Phase 1 of Reasoning Layer Hardening, doc 12). The reconciliation agent's
-- "read history before you act" decision-rule then runs against a fact whose
-- subject silently changed — see bead body for the full failure mode.
--
-- This migration:
--   (1) Extends the fact_history.event_type CHECK constraint to admit
--       'merged'. 'merged' carries semantics 'revised' can't: it signals the
--       change came from an entity-merge operation, not from a content
--       revision. Downstream consumers (blast-radius, contradictions) can
--       treat 'merged' as a distinct lifecycle event.
--   (2) DROPs the PL/pgSQL merge_entities(UUID,UUID,TEXT,VARCHAR,FLOAT)
--       function. There is no reason to keep a broken-by-design SQL path
--       alongside the audited TS replacement (services/entities.ts:mergeEntities).
--       Any future caller that wants to merge entities goes through TS.
--
-- Keep in sync with src/services/audit.ts:FactEventType (bead nmemo-2yv.30).
-- AGE search_path gotcha (per CLAUDE.md / 016-020 headers): explicit
-- public. qualifiers so DDL lands in public, not ag_catalog.

-- ============================================
-- 1. fact_history.event_type CHECK extension
-- ============================================
ALTER TABLE public.fact_history
  DROP CONSTRAINT IF EXISTS valid_fact_event_type;

ALTER TABLE public.fact_history
  ADD CONSTRAINT valid_fact_event_type CHECK (
    event_type IN (
      'created', 'confidence_raised', 'confidence_lowered',
      'revised', 'superseded', 'expired',
      'invalidated', 'restored', 'merged'
    )
  );

-- ============================================
-- 2. Drop PL/pgSQL merge_entities()
-- ============================================
-- Pre-flight check: this is a destructive drop, but the only production
-- caller (causal-agent.ts:1478 execute_merge) has been migrated to call
-- the TS replacement in the SAME diff as this migration. Tests have been
-- migrated too. Forward-only — restoring the SQL function would re-introduce
-- the audit-gap bug it was created with.
DROP FUNCTION IF EXISTS public.merge_entities(UUID, UUID, TEXT, VARCHAR, FLOAT);
