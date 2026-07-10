-- 051_causal_corroboration_idempotency.sql — replay-idempotent corroboration
-- for causal_edges (bead nmemo-uhp.4 / PC-3; docs/architecture/cross-corpus-audit/
-- 05-preconditions.md, 04-hardened-spec.md §8 issue 1).
--
-- Background: createCausalEdge's corroborate-or-insert (causal.ts) bumps
-- corroboration_count (+ strength, + a 'corroborated' audit row) on every
-- exact/semantic match. The post-promotion causal pass (applyCausalPromotion,
-- causal-promotion.ts) re-dispatches the SAME staging_causal_edges rows whenever
-- an epoch's causal pass re-runs (retry, re-promotion) — the staged rows are
-- never deleted and are reloaded by epoch_id. A literal replay therefore inflated
-- the count and drifted strength, silently breaching the epoch-v2 order-
-- independence guarantee. The idempotency test only asserted the row-SET, so it
-- stayed green while the count drifted.
--
-- Fix (the mig-034 invocation_id UPSERT model): scope each corroboration to a
-- stable identity — the staged-row id — recorded in this ledger under a unique
-- key. applyCorroboration inserts (edge_id, corroboration_key) ON CONFLICT DO
-- NOTHING inside the SAME transaction as the count bump; the bump lands only when
-- the insert is new. Re-dispatching the same staged row conflicts on the PK → the
-- count holds. A genuinely new proposal (a new staged-row id) still corroborates.
--
-- The key is nullable-by-omission at the call site: callers that pass no key
-- (legacy tests, direct reasoning-agent asserts) keep the unconditional-bump
-- path, exactly as mig-034 branched on invocation_id presence. No backfill:
-- existing edges simply have no ledger rows; their next corroboration from a
-- keyed caller starts recording.
--
-- PC-3 is a Blocker because Phase A clones corroborate-or-insert into
-- bridge_edges — this fixes the pattern before it is copied.
--
-- AGE search_path gotcha (CLAUDE.md / 034 header): 001_consolidated.sql set the
-- session search_path to `ag_catalog, public, "$user"`. DO NOT change it — AGE
-- and the Graph S triggers depend on ag_catalog being in the path. Every object
-- below is EXPLICITLY public.-qualified so it lands in public, not ag_catalog.
--
-- Forward-only + idempotent (migrate.ts has no journal; it re-runs every file on
-- every boot). CREATE ... IF NOT EXISTS throughout.

CREATE TABLE IF NOT EXISTS public.causal_edge_corroborations (
  edge_id           UUID NOT NULL REFERENCES public.causal_edges(id) ON DELETE CASCADE,
  corroboration_key UUID NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (edge_id, corroboration_key)
);
