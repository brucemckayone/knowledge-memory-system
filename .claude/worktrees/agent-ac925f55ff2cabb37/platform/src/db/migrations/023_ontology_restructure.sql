-- Migration 023: Ontology Restructure — Tense Pair Merge + Inverse Sync
-- Part of Living Ontology Phase A
-- Created: 2026-03-25

-- ============================================
-- 1. Migrate worked_at facts to works_at
-- ============================================
-- Set invalid_at for past-tense facts if not already set
UPDATE facts
SET predicate = 'works_at',
    invalid_at = COALESCE(invalid_at, valid_at, created_at)
WHERE predicate = 'worked_at'
  AND expired_at IS NULL;

-- Also update expired facts (for consistency)
UPDATE facts
SET predicate = 'works_at'
WHERE predicate = 'worked_at'
  AND expired_at IS NOT NULL;

-- ============================================
-- 2. Migrate lived_in facts to lives_in
-- ============================================
UPDATE facts
SET predicate = 'lives_in',
    invalid_at = COALESCE(invalid_at, valid_at, created_at)
WHERE predicate = 'lived_in'
  AND expired_at IS NULL;

UPDATE facts
SET predicate = 'lives_in'
WHERE predicate = 'lived_in'
  AND expired_at IS NOT NULL;

-- ============================================
-- 3. Remove tense variants from fact_predicates
-- (they're now aliases, not separate predicates)
-- ============================================
DELETE FROM fact_predicates WHERE predicate = 'worked_at';
DELETE FROM fact_predicates WHERE predicate = 'lived_in';

-- ============================================
-- 4. Sync inverse pairs to fact_predicates
-- ============================================
UPDATE fact_predicates SET inverse_predicate = 'employs' WHERE predicate = 'works_at' AND inverse_predicate IS NULL;
UPDATE fact_predicates SET inverse_predicate = 'works_at' WHERE predicate = 'employs' AND inverse_predicate IS NULL;
UPDATE fact_predicates SET inverse_predicate = 'owned_by' WHERE predicate = 'owns' AND inverse_predicate IS NULL;
UPDATE fact_predicates SET inverse_predicate = 'owns' WHERE predicate = 'owned_by' AND inverse_predicate IS NULL;
UPDATE fact_predicates SET inverse_predicate = 'created_by' WHERE predicate = 'created' AND inverse_predicate IS NULL;
UPDATE fact_predicates SET inverse_predicate = 'created' WHERE predicate = 'created_by' AND inverse_predicate IS NULL;
UPDATE fact_predicates SET inverse_predicate = 'has_member' WHERE predicate = 'member_of' AND inverse_predicate IS NULL;
UPDATE fact_predicates SET inverse_predicate = 'member_of' WHERE predicate = 'has_member' AND inverse_predicate IS NULL;
UPDATE fact_predicates SET inverse_predicate = 'known_by' WHERE predicate = 'knows' AND inverse_predicate IS NULL;
UPDATE fact_predicates SET inverse_predicate = 'knows' WHERE predicate = 'known_by' AND inverse_predicate IS NULL;
-- manages <-> reports_to and parent_of <-> child_of already set in seed data
