-- Migration: 006_gardener_jobs.sql
-- Phase 3: Gardener Job Scheduling Infrastructure
-- Created: 2026-01-24
-- 
-- Multi-Armed Bandit based priority scheduling for KARMA agents

-- ============================================
-- GARDENER JOB METADATA
-- ============================================
CREATE TABLE IF NOT EXISTS gardener_job_meta (
    job_id UUID PRIMARY KEY,  -- References pg-boss job
    
    -- Job categorization
    job_type VARCHAR(100) NOT NULL,
    tier VARCHAR(20) NOT NULL,  -- realtime, frequent, periodic, deep
    
    -- Priority (higher = more urgent)
    priority INTEGER DEFAULT 0,
    
    -- Multi-armed bandit scoring
    exploration_score FLOAT DEFAULT 0.5,
    expected_value FLOAT DEFAULT 0.5,
    
    -- Checkpointing for long-running jobs
    checkpoint JSONB,
    checkpoint_at TIMESTAMPTZ,
    
    -- Execution tracking
    attempts INTEGER DEFAULT 0,
    max_attempts INTEGER DEFAULT 3,
    last_error TEXT,
    
    -- Metrics
    started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    duration_ms INTEGER,
    
    -- Created
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_gardener_jobs_type ON gardener_job_meta(job_type);
CREATE INDEX IF NOT EXISTS idx_gardener_jobs_tier ON gardener_job_meta(tier);
CREATE INDEX IF NOT EXISTS idx_gardener_jobs_priority ON gardener_job_meta(priority DESC);

-- ============================================
-- JOB METRICS: Performance tracking
-- ============================================
CREATE TABLE IF NOT EXISTS gardener_metrics (
    id SERIAL PRIMARY KEY,
    job_type VARCHAR(100) NOT NULL,
    
    -- Execution metrics
    execution_count INTEGER DEFAULT 0,
    success_count INTEGER DEFAULT 0,
    failure_count INTEGER DEFAULT 0,
    
    -- Timing
    avg_duration_ms FLOAT,
    min_duration_ms INTEGER,
    max_duration_ms INTEGER,
    
    -- Quality
    avg_confidence FLOAT,
    
    -- Window
    window_start TIMESTAMPTZ NOT NULL,
    window_end TIMESTAMPTZ NOT NULL,
    
    UNIQUE(job_type, window_start)
);

-- ============================================
-- MAB STATE: Multi-Armed Bandit state
-- ============================================
CREATE TABLE IF NOT EXISTS mab_state (
    arm VARCHAR(100) PRIMARY KEY,  -- Job type or strategy
    
    -- UCB1 algorithm state
    pulls INTEGER DEFAULT 0,        -- Number of times selected
    total_reward FLOAT DEFAULT 0,   -- Cumulative reward
    
    -- Computed values (updated periodically)
    avg_reward FLOAT DEFAULT 0,
    ucb_score FLOAT DEFAULT 1.0,    -- Upper confidence bound
    
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Initialize MAB arms for each job type
INSERT INTO mab_state (arm) VALUES
    ('gardener:extract-entities'),
    ('gardener:extract-relationships'),
    ('gardener:summarize'),
    ('gardener:align-schema'),
    ('gardener:resolve-conflicts'),
    ('gardener:evaluate'),
    ('gardener:community-detection'),
    ('gardener:insight-generation')
ON CONFLICT DO NOTHING;

-- ============================================
-- UCB1 Score Recalculation Function
-- ============================================
CREATE OR REPLACE FUNCTION recalculate_ucb_scores() RETURNS void AS $$
DECLARE
    total_pulls BIGINT;
BEGIN
    -- Get total pulls across all arms
    SELECT COALESCE(SUM(pulls), 0) INTO total_pulls FROM mab_state;
    
    -- Update UCB scores using UCB1 formula
    UPDATE mab_state
    SET ucb_score = CASE 
        WHEN pulls = 0 THEN 1.0
        ELSE avg_reward + SQRT(2 * LN(total_pulls + 1) / pulls)
    END,
    updated_at = NOW();
END;
$$ LANGUAGE plpgsql;

-- ============================================
-- Update MAB Reward Function
-- ============================================
CREATE OR REPLACE FUNCTION update_mab_reward(arm_name VARCHAR, reward FLOAT) RETURNS void AS $$
BEGIN
    UPDATE mab_state
    SET 
        pulls = pulls + 1,
        total_reward = total_reward + reward,
        avg_reward = (total_reward + reward) / (pulls + 1),
        updated_at = NOW()
    WHERE arm = arm_name;
    
    -- Recalculate all UCB scores
    PERFORM recalculate_ucb_scores();
END;
$$ LANGUAGE plpgsql;

-- ============================================
-- Get Best Arm Function (for exploration/exploitation)
-- ============================================
CREATE OR REPLACE FUNCTION get_best_arm() RETURNS VARCHAR AS $$
DECLARE
    best_arm VARCHAR;
BEGIN
    SELECT arm INTO best_arm
    FROM mab_state
    ORDER BY ucb_score DESC
    LIMIT 1;
    
    RETURN best_arm;
END;
$$ LANGUAGE plpgsql;
