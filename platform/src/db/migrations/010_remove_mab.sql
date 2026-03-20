-- Migration: 010_remove_mab.sql
-- Remove dead MAB (Multi-Armed Bandit) machinery
-- Created: 2026-03-13
--
-- The MAB system is non-functional: ucb_score is frozen at 1.0 for all agents
-- since migration 008 removed recalculate_ucb_scores() from update_mab_reward().
-- Every enqueue() queries the DB to get the same useless score. Removing entirely.

-- Drop MAB functions
DROP FUNCTION IF EXISTS update_mab_reward(VARCHAR, FLOAT);
DROP FUNCTION IF EXISTS recalculate_ucb_scores();
DROP FUNCTION IF EXISTS recalculate_ucb_scores_batch();
DROP FUNCTION IF EXISTS get_best_arm();

-- Drop MAB state table
DROP TABLE IF EXISTS mab_state;

-- Drop unused MAB columns from gardener_job_meta
ALTER TABLE gardener_job_meta DROP COLUMN IF EXISTS exploration_score;
ALTER TABLE gardener_job_meta DROP COLUMN IF EXISTS expected_value;
ALTER TABLE gardener_job_meta DROP COLUMN IF EXISTS max_attempts;
