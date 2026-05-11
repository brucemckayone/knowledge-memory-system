-- Migration 013: Contradiction reviews table
-- Stores results of scheduled contradiction scanning (W33).

CREATE TABLE IF NOT EXISTS contradiction_reviews (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  fact_id_1 UUID NOT NULL REFERENCES facts(id) ON DELETE CASCADE,
  fact_id_2 UUID NOT NULL REFERENCES facts(id) ON DELETE CASCADE,
  contradiction_type VARCHAR(50) NOT NULL,
  resolution VARCHAR(50) NOT NULL,
  confidence REAL NOT NULL DEFAULT 0.5,
  reasoning TEXT,
  resolved_at TIMESTAMPTZ,
  resolved_by VARCHAR(50),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_contradiction_reviews_fact1 ON contradiction_reviews(fact_id_1);
CREATE INDEX IF NOT EXISTS idx_contradiction_reviews_fact2 ON contradiction_reviews(fact_id_2);
CREATE INDEX IF NOT EXISTS idx_contradiction_reviews_unresolved ON contradiction_reviews(resolved_at) WHERE resolved_at IS NULL;
