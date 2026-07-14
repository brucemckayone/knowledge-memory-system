-- 053_element_catalogs.sql — Cross-corpus Phase A: element catalogs + embedding substrate
-- Bead nmemo-uhp.10. Spec: docs/architecture/cross-corpus-audit/04-hardened-spec.md §3 (D1).
--
-- Code/rule elements are BARE CATALOG ROWS, never `entities` — zero fusion surface by
-- construction (D1). element_ref = uuidV5(scheme|corpus|canonical_symbol), derived by a
-- pure resolver (services/element-ref.ts), so ids are stable and hand-seedable with no DB.
-- element_embeddings is the dedicated behaviour/rule-text vector table E1 recall queries
-- cross-corpus over — deliberately NOT entities.embedding (which is name-only).
--
-- AGE note (CLAUDE.md): 001 sets session search_path = ag_catalog, public, "$user";
-- do not change it, qualify everything public. Idempotent (CREATE ... IF NOT EXISTS).

-- ============================================
-- 1. code_elements — the code corpus catalog
-- ============================================
CREATE TABLE IF NOT EXISTS public.code_elements (
  element_ref       UUID PRIMARY KEY,                 -- uuidV5(scheme|corpus|canonical_symbol)
  corpus_id         TEXT NOT NULL,
  scheme            VARCHAR(8),                        -- 'scip' | 'ast'
  canonical_symbol  TEXT NOT NULL,
  source_commit     VARCHAR(40),
  content_hash      VARCHAR(64),
  file_path         TEXT,
  line_start        INT,
  line_end          INT,
  status            VARCHAR(12) NOT NULL DEFAULT 'live',
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (corpus_id, scheme, canonical_symbol),
  CONSTRAINT valid_code_element_status CHECK (status IN ('live', 'stale', 'removed'))
);
CREATE INDEX IF NOT EXISTS idx_code_elements_corpus ON public.code_elements(corpus_id);

-- ============================================
-- 2. rule_elements — the standard corpus catalog
-- ============================================
CREATE TABLE IF NOT EXISTS public.rule_elements (
  element_ref   UUID PRIMARY KEY,                     -- uuidV5(scheme|corpus|rule_id)
  corpus_id     TEXT NOT NULL,
  rule_id       TEXT NOT NULL,
  rule_set_hash TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (corpus_id, rule_id)
);
CREATE INDEX IF NOT EXISTS idx_rule_elements_corpus ON public.rule_elements(corpus_id);

-- ============================================
-- 3. element_embeddings — the E1 recall substrate (parser-populated)
-- ============================================
CREATE TABLE IF NOT EXISTS public.element_embeddings (
  element_ref UUID PRIMARY KEY,
  corpus_id   TEXT NOT NULL,
  kind        VARCHAR(12) NOT NULL,                   -- 'behaviour' | 'rule_text'
  text        TEXT NOT NULL,
  embedding   VECTOR(768),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT valid_element_embedding_kind CHECK (kind IN ('behaviour', 'rule_text'))
);
CREATE INDEX IF NOT EXISTS idx_element_embeddings_corpus ON public.element_embeddings(corpus_id);
CREATE INDEX IF NOT EXISTS idx_element_embeddings_embedding
  ON public.element_embeddings USING hnsw (embedding vector_cosine_ops);
