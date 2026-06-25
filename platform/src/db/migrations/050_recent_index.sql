-- 050_recent_index.sql — iOS API v1 /api/recent (ASK-002)
--
-- A cheap Postgres recency index for memories, which otherwise live only in
-- Qdrant (Qdrant cannot ORDER BY created_at cheaply, and the recent section is
-- a pure recency read). store() writes one row per ingested memory right after
-- the Qdrant upsert; /api/recent is then a single PG read + a two-table join to
-- memory_entities ⋈ entities for the italic entity.
--
-- Additive + idempotent (the migrate runner replays every .sql file on boot).
-- NOTE: 001_consolidated.sql sets search_path = ag_catalog, public, "$user" at
-- session level and we MUST NOT change it. So all DDL uses explicit public.
-- qualifiers — without them new objects would land in ag_catalog. See
-- 049_ios_milestone1.sql for the same constraint.

-- ============================================
-- memory_index
-- ============================================
-- One row per ingested memory (one-to-one with the Qdrant parent window point
-- whose id == memory_id). memory_id is the canonical memory id (the Qdrant
-- parent point id minted by store() — same value facts.source_memory_id and
-- memory_entities.memory_id anchor on). TEXT, no FK: there is no Postgres
-- memories table to FK to (memories live in Qdrant).
--
-- created_at: the memory's ingest timestamp (matches the Qdrant payload
-- created_at, so /api/recent ordering agrees with every other created_at view).
-- pulled_line: a deterministic short excerpt of the memory body (first sentence
--   or first ~120 chars), computed in store(). May be NULL for legacy rows;
--   /api/recent falls back to an on-the-fly excerpt from the Qdrant content.
-- source / stream_id: passthrough of the ingest metadata for filtering/audit.
CREATE TABLE IF NOT EXISTS public.memory_index (
  memory_id    TEXT PRIMARY KEY,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  pulled_line  TEXT,
  source       TEXT,
  stream_id    TEXT
);

-- /api/recent is ORDER BY created_at DESC LIMIT N. This index serves it.
CREATE INDEX IF NOT EXISTS idx_memory_index_created_at
  ON public.memory_index (created_at DESC);
