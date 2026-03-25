-- Migration 025: Predicate Staging Lifecycle
-- Part of Living Ontology Phase B
-- Created: 2026-03-25

-- Add staging lifecycle columns
ALTER TABLE fact_predicates ADD COLUMN IF NOT EXISTS status VARCHAR(20) DEFAULT 'canonical';
ALTER TABLE fact_predicates ADD COLUMN IF NOT EXISTS first_seen_at TIMESTAMPTZ;
ALTER TABLE fact_predicates ADD COLUMN IF NOT EXISTS distinct_memory_count INTEGER DEFAULT 0;
ALTER TABLE fact_predicates ADD COLUMN IF NOT EXISTS promoted_at TIMESTAMPTZ;
ALTER TABLE fact_predicates ADD COLUMN IF NOT EXISTS rejected_at TIMESTAMPTZ;
ALTER TABLE fact_predicates ADD COLUMN IF NOT EXISTS rejection_reason TEXT;

-- Migrate is_canonical to status
UPDATE fact_predicates SET status = 'canonical' WHERE is_canonical = true;
UPDATE fact_predicates SET status = 'staging' WHERE is_canonical = false;

-- Set first_seen_at for existing predicates
UPDATE fact_predicates SET first_seen_at = created_at WHERE first_seen_at IS NULL;

-- Index for evolution agent queries
CREATE INDEX IF NOT EXISTS idx_predicates_staging ON fact_predicates(status, usage_count DESC) WHERE status IN ('staging', 'candidate');
CREATE INDEX IF NOT EXISTS idx_predicates_provisional ON fact_predicates(status, promoted_at) WHERE status = 'provisional';

-- Add status constraint
ALTER TABLE fact_predicates ADD CONSTRAINT valid_predicate_status CHECK (
    status IN ('staging', 'candidate', 'provisional', 'canonical', 'rejected')
);
