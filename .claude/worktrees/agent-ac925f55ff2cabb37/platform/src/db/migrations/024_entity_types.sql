-- Migration 024: Dynamic Entity Types + Type History
-- Part of Living Ontology Phase B
-- Created: 2026-03-25

-- ============================================
-- 1. Entity Types Registry
-- ============================================
CREATE TABLE IF NOT EXISTS entity_types (
    name VARCHAR(100) PRIMARY KEY,
    description TEXT,
    status VARCHAR(20) DEFAULT 'canonical' NOT NULL,
    promoted_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
    CONSTRAINT valid_entity_type_status CHECK (
        status IN ('canonical', 'provisional', 'deprecated')
    )
);

-- Seed with current 7 types
INSERT INTO entity_types (name, description, status) VALUES
    ('person', 'A human individual', 'canonical'),
    ('company', 'A business organization or corporation', 'canonical'),
    ('project', 'A project, product, or initiative', 'canonical'),
    ('concept', 'An abstract concept, idea, or topic', 'canonical'),
    ('place', 'A geographic location', 'canonical'),
    ('event', 'A specific event or occurrence', 'canonical'),
    ('other', 'Uncategorized entity type', 'canonical')
ON CONFLICT (name) DO NOTHING;

-- ============================================
-- 2. Entity Type History (bi-temporal typing)
-- ============================================
CREATE TABLE IF NOT EXISTS entity_type_history (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    entity_id UUID NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    previous_type VARCHAR(100) NOT NULL,
    new_type VARCHAR(100) NOT NULL,
    changed_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
    changed_by VARCHAR(50) DEFAULT 'system',
    reason TEXT
);

CREATE INDEX IF NOT EXISTS idx_entity_type_history_entity ON entity_type_history(entity_id);
CREATE INDEX IF NOT EXISTS idx_entity_type_history_time ON entity_type_history(changed_at DESC);

-- ============================================
-- 3. Drop hardcoded CHECK constraint on entities
-- ============================================
ALTER TABLE entities DROP CONSTRAINT IF EXISTS valid_entity_type;
