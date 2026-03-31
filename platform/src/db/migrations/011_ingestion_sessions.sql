-- Ingestion Sessions: temporal grouping of related items from the same user
-- Groups messages arriving within a configurable time window for cross-source context linking

CREATE TABLE IF NOT EXISTS ingestion_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sender_id TEXT NOT NULL,
  session_key TEXT NOT NULL UNIQUE,
  opened_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  closed_at TIMESTAMPTZ,
  member_count INTEGER NOT NULL DEFAULT 0,
  raw_types TEXT[] NOT NULL DEFAULT '{}',
  platforms TEXT[] NOT NULL DEFAULT '{}',
  shared_entities UUID[] DEFAULT '{}',
  shared_tags TEXT[] DEFAULT '{}',
  context_summary TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sessions_open ON ingestion_sessions(closed_at) WHERE closed_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_sessions_sender ON ingestion_sessions(sender_id, opened_at DESC);

CREATE TABLE IF NOT EXISTS ingestion_session_members (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL REFERENCES ingestion_sessions(id) ON DELETE CASCADE,
  memory_id UUID NOT NULL,
  platform TEXT NOT NULL,
  raw_type TEXT NOT NULL,
  content_preview TEXT,
  ingested_at TIMESTAMPTZ NOT NULL,
  UNIQUE(session_id, memory_id)
);

CREATE INDEX IF NOT EXISTS idx_session_members_memory ON ingestion_session_members(memory_id);
CREATE INDEX IF NOT EXISTS idx_session_members_session ON ingestion_session_members(session_id);
