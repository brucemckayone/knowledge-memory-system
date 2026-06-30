-- 040_staging_proposals.sql
--
-- Epoch v2 (doc 41 §3, §8a.4, §12 #1): the propose/promote staging buffer.
--
-- Extraction proposers (Phase 2) no longer write canonical. They write candidate
-- entities/facts into these DEDICATED staging tables (not a status flag on the
-- canonical rows — doc 41 §12 #1) in clean per-epoch isolation. A single
-- deterministic promotion step (E3) reads one epoch's staged rows, resolves
-- identity, orders + supersedes, and writes canonical in one transaction.
-- Nothing here is canonical: no AGE sync, no fact_history, no invariants.
--
-- AGE search_path gotcha (CLAUDE.md): 001_consolidated.sql sets the session
-- search_path to `ag_catalog, public, "$user"`, which persists across migration
-- files. Every object below is therefore EXPLICITLY `public.`-qualified — without
-- it, tables would land in ag_catalog and the FK to public.entities would fail
-- cross-schema. We do NOT change the session search_path here.

-- ── Proposed entities ──────────────────────────────────────────────────────
-- One row per entity a proposer either invented (new handle) or anchored to a
-- known canonical id. `handle` is the server-minted, epoch-local id that
-- propose_fact references — agents never invent id strings (kills the in-chunk
-- "3 Elenas" fragmentation, doc 41 §8a.4). `anchor_canonical_id` is set when the
-- proposer matched the epoch-start registry (doc 41 §4 anchoring); promotion
-- inherits it as the resolved identity instead of re-clustering.
CREATE TABLE IF NOT EXISTS public.staging_proposed_entities (
  handle              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Promotion-scope partition: one promotion consumes exactly one epoch_id's
  -- rows. source_id carries the doc 41 §12 #2 per-source promotion boundary;
  -- both are injected by the harness (env), not the agent.
  epoch_id            UUID NOT NULL,
  source_id           UUID,
  name                TEXT NOT NULL,
  entity_type         TEXT NOT NULL,
  summary             TEXT,
  -- Set ONLY when the proposer anchored to a known entity. ON DELETE SET NULL:
  -- a canonical entity vanishing before promotion degrades the anchor to a
  -- fresh proposal rather than orphaning the staged row.
  anchor_canonical_id UUID REFERENCES public.entities(id) ON DELETE SET NULL,
  mention_text        TEXT,
  proposed_by         VARCHAR(32) NOT NULL DEFAULT 'extraction_proposer',
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_staging_entities_epoch
  ON public.staging_proposed_entities (epoch_id);
CREATE INDEX idx_staging_entities_anchor
  ON public.staging_proposed_entities (anchor_canonical_id)
  WHERE anchor_canonical_id IS NOT NULL;

-- ── Proposed facts ─────────────────────────────────────────────────────────
-- Entity refs are HANDLES, not canonical ids — promotion resolves them after
-- identity is settled (doc 41 §3). Handles stay loose (no intra-staging FK) so
-- parallel proposer inserts never order-couple; promotion validates them.
-- exclusive_group is resolved at propose time from the E1 shared ontology
-- (resolveExclusiveGroup) and stored so promotion's group-aware supersession
-- (E3, doc 41 §5c) reuses it without re-deriving.
CREATE TABLE IF NOT EXISTS public.staging_proposed_facts (
  staged_fact_id  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  epoch_id        UUID NOT NULL,
  source_id       UUID,
  subject_handle  UUID NOT NULL,
  predicate       TEXT NOT NULL,
  -- Exactly one of object_handle / object_value is present.
  object_handle   UUID,
  object_value    TEXT,
  -- valid_at NULL with undated=true is an explicit "no date" (doc 41 §4) — not
  -- a silent omission. chunk_index is the narration-order fallback for undated
  -- facts (doc 41 §5c), injected by the harness.
  valid_at        TIMESTAMPTZ,
  undated         BOOLEAN NOT NULL DEFAULT false,
  chunk_index     INTEGER,
  confidence      REAL,
  reasoning       TEXT,
  exclusive_group TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT staging_fact_object_present
    CHECK (object_handle IS NOT NULL OR object_value IS NOT NULL),
  -- No silent omission (doc 41 §4): a fact is either explicitly dated
  -- (undated=false, valid_at set) or explicitly undated (undated=true, valid_at
  -- NULL). The biconditional forbids the ambiguous valid_at-NULL/undated-false.
  CONSTRAINT staging_fact_dated_xor_undated
    CHECK (undated = (valid_at IS NULL))
);

CREATE INDEX idx_staging_facts_epoch
  ON public.staging_proposed_facts (epoch_id);
CREATE INDEX idx_staging_facts_subject
  ON public.staging_proposed_facts (subject_handle);
