-- Migration 014: Source Adapter Framework tables (W34)
-- Content deduplication and source tracking for multi-source ingestion.

CREATE TABLE IF NOT EXISTS content_hashes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  hash VARCHAR(64) NOT NULL UNIQUE,
  source VARCHAR(50) NOT NULL,
  item_id VARCHAR(255) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_content_hashes_hash ON content_hashes(hash);
CREATE INDEX IF NOT EXISTS idx_content_hashes_source ON content_hashes(source);

CREATE TABLE IF NOT EXISTS ingest_sources (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_name VARCHAR(50) NOT NULL,
  channel_id VARCHAR(255) NOT NULL,
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  item_count INTEGER NOT NULL DEFAULT 0,
  config JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(source_name, channel_id)
);

CREATE INDEX IF NOT EXISTS idx_ingest_sources_name ON ingest_sources(source_name);
