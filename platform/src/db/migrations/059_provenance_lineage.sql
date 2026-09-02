-- 059_provenance_lineage.sql — nmemo-asf.2 / doc 35 §4 (Phase 1.1, option A).
--
-- First-class lineage backbone. The evidentiary LINK tables already existed and
-- (as of doc 35 §2) now populate: fact_sources (fact->window) and fact_units
-- (fact->unit, char offsets). What was missing is the fragment -> source chain:
-- an explicit source_document per ingested source, and a fragment row per
-- window/unit carrying char offsets, the window<-unit parent link, and the
-- chunker name+version that makes those offsets reproducible.
--
-- KEY DESIGN: fragment.id IS the deterministic Qdrant point id (windowPointId for
-- windows, unitPointId for units — pipeline.ts). One id space shared with Qdrant
-- and with fact_units.unit_point_id / fact_sources.memory_id, so Postgres lineage
-- and the Qdrant vector store can never drift. source_document.id is a distinct
-- uuidv5 (DOC namespace) of (corpus_id, source key), so all chunks/windows of one
-- batched source share one document row (idempotent upsert), and a single ingest
-- gets its own document keyed by the window id.
--
-- Forward-only + idempotent (IF NOT EXISTS / no data mutation), so the no-journal
-- runner re-applies it safely (src/db/migrate.ts).
--
-- AGE search_path gotcha (CLAUDE.md / 001 set search_path = ag_catalog, public,
-- "$user" at session level and later files depend on it): DO NOT change it, and
-- qualify every object with public. so nothing lands in ag_catalog. This file has
-- no cypher()/AGE/trigger dependency — pure public. table DDL.

-- ============================================
-- 1. source_document — one row per ingested source
-- ============================================
CREATE TABLE IF NOT EXISTS public.source_document (
  id                  UUID PRIMARY KEY,
  corpus_id           TEXT NOT NULL DEFAULT 'default',
  external_source_id  TEXT,                      -- batch source_id (doc 38 §1); NULL for single ingest
  content_type        VARCHAR(32),
  chunker_name        TEXT NOT NULL,
  chunker_version     TEXT NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_source_document_corpus
  ON public.source_document (corpus_id);
CREATE INDEX IF NOT EXISTS idx_source_document_external
  ON public.source_document (corpus_id, external_source_id);

-- ============================================
-- 2. fragment — window/unit chunks, keyed by the Qdrant point id
-- ============================================
CREATE TABLE IF NOT EXISTS public.fragment (
  id                  UUID PRIMARY KEY,          -- = windowPointId / unitPointId (Qdrant point id)
  source_document_id  UUID NOT NULL
                        REFERENCES public.source_document(id) ON DELETE CASCADE,
  parent_id           UUID
                        REFERENCES public.fragment(id) ON DELETE CASCADE,  -- unit -> window; NULL for a window
  kind                VARCHAR(16) NOT NULL,       -- 'window' | 'unit'
  char_start          INTEGER NOT NULL,
  char_end            INTEGER NOT NULL,
  chunker_name        TEXT NOT NULL,
  chunker_version     TEXT NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_fragment_source_doc
  ON public.fragment (source_document_id);
CREATE INDEX IF NOT EXISTS idx_fragment_parent
  ON public.fragment (parent_id);
