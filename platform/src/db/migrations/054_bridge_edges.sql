-- 054_bridge_edges.sql — Cross-corpus Phase A: the bridge_edges family
-- Bead nmemo-uhp.9. Spec: docs/architecture/cross-corpus-audit/04-hardened-spec.md §3 (D1) / §4.
--
-- A bridge is a saved, reasoned, sourced connection between an element in one corpus and an
-- element in another (e.g. "this code element VIOLATES this rule"). It reuses the causal-edge
-- shape wholesale: reasoning + source_references are NOT NULL (non-negotiable), partial-unique
-- dedup while live, corroborate-or-insert, stale_citation flag. Endpoints are POLYMORPHIC
-- UUIDs (a_kind/a_ref, b_kind/b_ref) — validated at disposal against code_elements/rule_elements
-- (053), NOT via FK, because an endpoint is a catalog row, not an entity.
--
-- Mirrors: staging_causal_edges (044) for the staging shape + CHECKs; edge_source_refs (010)
-- for the reverse-lookup index (ref_type widened to include code_element/rule_element).
--
-- AGE note (CLAUDE.md): 001 sets session search_path; do not change it, qualify public.
-- Bridges do NOT sync to AGE in v1 (D2). Idempotent.

-- ============================================
-- 1. bridge_edges — canonical
-- ============================================
CREATE TABLE IF NOT EXISTS public.bridge_edges (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- polymorphic endpoints (validated vs catalogs at disposal, not by FK)
  a_kind              VARCHAR(12) NOT NULL,
  a_ref               UUID NOT NULL,
  b_kind              VARCHAR(12) NOT NULL,
  b_ref               UUID NOT NULL,
  source_corpus_id    TEXT NOT NULL,
  target_corpus_id    TEXT NOT NULL,
  relation            VARCHAR(16) NOT NULL,
  -- audit metadata
  severity            VARCHAR(16),
  category            VARCHAR(64),
  code_location       JSONB,
  -- anchor columns (present but DORMANT in v1 — Phase C fills them)
  source_commit       TEXT,
  source_ast_hash     TEXT,
  rule_set_hash       TEXT,
  model_version       TEXT,
  -- reasoning & traceability (NON-NEGOTIABLE — mirrors causal_edges)
  reasoning           TEXT NOT NULL,
  source_references   JSONB NOT NULL,
  -- lifecycle
  corroboration_count INT NOT NULL DEFAULT 1,
  strength            FLOAT NOT NULL DEFAULT 0.5,
  stale_citation      BOOLEAN NOT NULL DEFAULT false,
  stale_reason        TEXT,
  expired_at          TIMESTAMPTZ,
  expire_reason       TEXT,
  invocation_id       UUID,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT valid_bridge_relation CHECK (relation IN ('violates', 'satisfies', 'not_applicable')),
  CONSTRAINT valid_bridge_kinds CHECK (a_kind IN ('code_element','rule_element') AND b_kind IN ('code_element','rule_element')),
  CONSTRAINT valid_bridge_reasoning CHECK (length(btrim(reasoning)) > 0),
  CONSTRAINT valid_bridge_refs CHECK (jsonb_typeof(source_references) = 'array' AND jsonb_array_length(source_references) >= 1)
);

-- partial-unique dedup: one live bridge per (a_ref, b_ref, relation)
CREATE UNIQUE INDEX IF NOT EXISTS idx_bridge_edges_unique
  ON public.bridge_edges (a_ref, b_ref, relation) WHERE expired_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_bridge_edges_a ON public.bridge_edges (a_ref) WHERE expired_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_bridge_edges_b ON public.bridge_edges (b_ref) WHERE expired_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_bridge_edges_corpus ON public.bridge_edges (source_corpus_id, target_corpus_id);

-- ============================================
-- 2. staging_bridge_edges — agent writes here; promotion disposes to canonical (mirrors 044)
-- ============================================
CREATE TABLE IF NOT EXISTS public.staging_bridge_edges (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  invocation_id     UUID NOT NULL,
  a_kind            VARCHAR(12) NOT NULL,
  a_ref             UUID NOT NULL,
  b_kind            VARCHAR(12) NOT NULL,
  b_ref             UUID NOT NULL,
  source_corpus_id  TEXT NOT NULL,
  target_corpus_id  TEXT NOT NULL,
  relation          VARCHAR(16) NOT NULL,
  severity          VARCHAR(16),
  category          VARCHAR(64),
  code_location     JSONB,
  reasoning         TEXT NOT NULL,
  source_references JSONB NOT NULL,
  strength          FLOAT NOT NULL DEFAULT 0.5,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- structural invariants at the staging boundary (no FK — endpoints validated at disposal)
  CONSTRAINT valid_staging_bridge_relation CHECK (relation IN ('violates', 'satisfies', 'not_applicable')),
  CONSTRAINT valid_staging_bridge_reasoning CHECK (length(btrim(reasoning)) > 0),
  CONSTRAINT valid_staging_bridge_refs CHECK (jsonb_typeof(source_references) = 'array' AND jsonb_array_length(source_references) >= 1)
);
CREATE INDEX IF NOT EXISTS idx_staging_bridge_edges_invocation ON public.staging_bridge_edges (invocation_id);

-- ============================================
-- 3. bridge_source_refs — reverse-lookup index (clone of edge_source_refs; ref_type widened)
-- ============================================
CREATE TABLE IF NOT EXISTS public.bridge_source_refs (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bridge_edge_id UUID NOT NULL REFERENCES public.bridge_edges(id) ON DELETE CASCADE,
  ref_type       VARCHAR(16) NOT NULL,
  ref_id         TEXT NOT NULL,
  relevance      FLOAT,
  CONSTRAINT valid_bridge_ref_type CHECK (ref_type IN ('fact', 'memory', 'code_element', 'rule_element'))
);
CREATE INDEX IF NOT EXISTS idx_bridge_source_refs_edge ON public.bridge_source_refs (bridge_edge_id);
CREATE INDEX IF NOT EXISTS idx_bridge_source_refs_lookup ON public.bridge_source_refs (ref_type, ref_id);
