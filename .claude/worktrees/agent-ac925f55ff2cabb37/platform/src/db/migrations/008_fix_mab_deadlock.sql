-- Migration: 008_fix_mab_deadlock.sql
-- Fix: MAB deadlock when concurrent transactions update all rows
-- Created: 2026-01-25
--
-- Problem: update_mab_reward() calls recalculate_ucb_scores() which does
-- UPDATE mab_state SET ucb_score = ... (NO WHERE clause = ALL rows)
-- When two concurrent transactions both try to update all rows,
-- PostgreSQL detects a circular lock wait and kills one transaction.
--
-- Solution: Remove automatic UCB recalculation from update_mab_reward.
-- UCB scores are now calculated lazily inline in get_best_arm().

-- ============================================
-- FIXED: Update MAB Reward Function
-- No longer calls recalculate_ucb_scores()
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

    -- REMOVED: PERFORM recalculate_ucb_scores();
    -- UCB scores are now calculated lazily in get_best_arm()
    -- This prevents deadlocks when concurrent transactions update rewards
END;
$$ LANGUAGE plpgsql;

-- ============================================
-- FIXED: Get Best Arm with Inline UCB Calculation
-- Calculates UCB at query time instead of storing it
-- ============================================
CREATE OR REPLACE FUNCTION get_best_arm() RETURNS VARCHAR AS $$
DECLARE
    best_arm VARCHAR;
    total_pulls BIGINT;
BEGIN
    -- Get total pulls for UCB calculation
    SELECT COALESCE(SUM(pulls), 0) INTO total_pulls FROM mab_state;

    -- Select best arm using inline UCB calculation (UCB1 formula)
    -- UCB = avg_reward + sqrt(2 * ln(total_pulls + 1) / pulls)
    SELECT arm INTO best_arm
    FROM mab_state
    ORDER BY CASE
        WHEN pulls = 0 THEN 1.0  -- Encourage exploration of unused arms
        ELSE avg_reward + SQRT(2 * LN(total_pulls + 1) / pulls)
    END DESC
    LIMIT 1;

    RETURN best_arm;
END;
$$ LANGUAGE plpgsql;

-- ============================================
-- Optional: Batch UCB Recalculation (for admin use)
-- Can be called periodically outside of transactions
-- ============================================
CREATE OR REPLACE FUNCTION recalculate_ucb_scores_batch() RETURNS void AS $$
DECLARE
    total_pulls BIGINT;
BEGIN
    -- Get total pulls across all arms
    SELECT COALESCE(SUM(pulls), 0) INTO total_pulls FROM mab_state;

    -- Update UCB scores using UCB1 formula
    -- This should only be called during maintenance windows
    UPDATE mab_state
    SET ucb_score = CASE
        WHEN pulls = 0 THEN 1.0
        ELSE avg_reward + SQRT(2 * LN(total_pulls + 1) / pulls)
    END,
    updated_at = NOW();
END;
$$ LANGUAGE plpgsql;
