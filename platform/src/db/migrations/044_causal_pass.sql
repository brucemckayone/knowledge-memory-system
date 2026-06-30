-- 044_causal_pass.sql
--
-- Epoch v2 E6 (doc 41 §6, §8a.6, §12 #5 + #6; bead nmemo-vpz.6): the post-promotion
-- causal pass's staging buffer + the canonical stale-citation flag.
--
-- Causality (Graph C) is a SEPARATE pass that runs AFTER promotion, over the SETTLED
-- canonical graph, conditional + delta-scoped (§6). The causal agent reads canonical
-- and PROPOSES edges between SETTLED causal events (minted deterministically by
-- promotion, §12 #5, so their ids are stable). It writes proposals HERE, never
-- canonical; a deterministic causal-promotion step disposes them into
-- public.causal_edges (ref-resolve, self-loop drop, dedup, cited-fact branch).
--
-- Two objects:
--   1. public.staging_causal_edges — the propose_causal_edge buffer (§8a.6). Like the
--      other staging_* tables this is NOT canonical: no AGE sync, no edge_source_refs,
--      no causal_edge_history. The doc-01 invariant (non-empty reasoning +
--      source_references on EVERY edge) is enforced structurally HERE too, so a
--      proposal can never violate it before disposal.
--   2. public.causal_edges.stale_citation — set by causal-promotion when a promoted
--      edge cites an INVALIDATED fact (§6, §12 #5): the edge is KEPT (we never
--      auto-repoint — a different fact may not support the same claim), but flagged so
--      the NEXT delta pass re-grounds or expires it WITH reasoning. A SUPERSEDED cited
--      fact is NOT flagged (the past event is still real; the timeline merely moved on).
--
-- Event ids are stored as plain UUIDs, NOT FK-constrained: ref-resolution is a
-- DISPOSAL step (causal-promotion drops an edge whose event id no longer resolves)
-- and a soft `refsResolve` signal the propose tool returns — a hallucinated or
-- since-removed id must be disposed gracefully, not crash the whole pass.
--
-- AGE search_path gotcha (CLAUDE.md): 001_consolidated.sql sets the session
-- search_path to `ag_catalog, public, "$user"`. Every object below is EXPLICITLY
-- public.-qualified; we do NOT change the session search_path here.

CREATE TABLE IF NOT EXISTS public.staging_causal_edges (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Promotion-scope partition (mirrors staging_* / arbiter_verdicts): the causal
  -- pass runs after ONE promotion; its proposals carry that promotion's epoch_id.
  -- Injected by the harness (env), not the agent.
  epoch_id          UUID NOT NULL,
  -- Settled canonical causal_events ids (minted by promotion, §12 #5). No FK — see
  -- header: ref-resolution is a disposal step, not an insert-time constraint.
  cause_event_id    UUID NOT NULL,
  effect_event_id   UUID NOT NULL,
  -- doc-01 invariant, enforced at the propose boundary AND structurally here.
  reasoning         TEXT NOT NULL,
  source_references JSONB NOT NULL,
  proposed_by       VARCHAR(32) NOT NULL DEFAULT 'causal_agent',
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT staging_causal_edge_reasoning_nonempty CHECK (length(btrim(reasoning)) > 0),
  CONSTRAINT staging_causal_edge_refs_nonempty
    CHECK (jsonb_typeof(source_references) = 'array' AND jsonb_array_length(source_references) > 0)
);

CREATE INDEX IF NOT EXISTS idx_staging_causal_edges_epoch
  ON public.staging_causal_edges (epoch_id);

-- Canonical stale-citation flag (see header). Default false so every existing edge
-- is unflagged; causal-promotion sets it true (+ a reason) only on the invalidated
-- cited-fact branch — never on a superseded one, and never as an auto-repoint.
ALTER TABLE public.causal_edges
  ADD COLUMN IF NOT EXISTS stale_citation BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS stale_citation_reason TEXT;
