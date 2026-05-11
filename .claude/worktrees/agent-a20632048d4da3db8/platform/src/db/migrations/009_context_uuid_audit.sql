-- Migration: Context UUID Audit Table
-- Purpose: Track deterministic UUID usage for drift detection and reverse mapping
--
-- This table stores the mapping between generated context UUIDs and their source
-- platform + conversation_id. It serves two purposes:
-- 1. Audit trail of all UUID usage (first_seen_at, last_seen_at)
-- 2. Drift detection - if the same UUID is ever generated from different inputs

CREATE TABLE IF NOT EXISTS context_uuid_audit (
  context_uuid UUID PRIMARY KEY,
  platform VARCHAR(50) NOT NULL,
  conversation_id VARCHAR(255) NOT NULL,
  first_seen_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  last_seen_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Index for looking up by platform + conversation_id (reverse lookup)
CREATE INDEX IF NOT EXISTS idx_context_audit_platform_conv
  ON context_uuid_audit(platform, conversation_id);

-- Comment for documentation
COMMENT ON TABLE context_uuid_audit IS 'Tracks deterministic context UUID usage for auditing and drift detection';
