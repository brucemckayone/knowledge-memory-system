-- 051_onboarding_state.sql — iOS API v1 /api/onboarding/* (ASK-010 / EPIC 2)
--
-- Persists the single-user-v1 onboarding state machine: the current stage in
-- the prompt arc (design/08-onboarding.md §"Stage transitions"), the pre-
-- composed current prompt (composed ON stage transition, never synchronously
-- on GET — see §"Composition cadence"), the Stage 4 inferred-focus candidate
-- list, and the post-confirmation confirmed-focus list.
--
-- Additive + idempotent (the migrate runner replays every .sql file on boot).
-- NOTE: 001_consolidated.sql sets search_path = ag_catalog, public, "$user" at
-- session level and we MUST NOT change it. So all DDL uses explicit public.
-- qualifiers — without them new objects would land in ag_catalog. See
-- 050_recent_index.sql / 049_ios_milestone1.sql for the same constraint.
--
-- Single-row v1: there is exactly one user in the iOS milestone-1 deployment
-- (single-user-v1 — see design/00-vision.md). The row is keyed by the constant
-- 'v1' and created on first read/advance via UPSERT. A multi-user schema would
-- add a user_id column; that lift is not pre-built (fluid-contract-minimality:
-- adapt when reality crystallizes).

-- ============================================
-- user_onboarding_state
-- ============================================
-- The stage machine's persistent state. The stage NEVER regresses
-- (design/08-onboarding.md:137) — advancement writes here, manual demotion is
-- not exposed. The CHECK constraint guards the closed 5-value enum the iOS
-- OnboardingStage decoder enforces (an unknown value => iOS dataCorrupted; we
-- never emit anything else).
--
-- Columns mirror the iOS OnboardingState wire (Sources/MnemoBackend/ASK/
-- Onboarding/OnboardingState.swift) ONE-TO-ONE except for the nested prompt +
-- inferredFocus objects, which are flattened/packed:
--   - stage                       <- OnboardingState.stage (closed enum)
--   - current_prompt_*            <- OnboardingState.prompt flattened (the
--                                    prompt is a single object, not a list;
--                                    one row is enough). NULL prompt columns
--                                    == prompt:null on the wire (the confirmed
--                                    stage and the hard-topic suppression both
--                                    send prompt:null).
--   - inferred_focus (JSONB)      <- OnboardingState.inferredFocus packed.
--                                    Present ONLY at awaiting_confirmation
--                                    (NULL otherwise).
--   - confirmed_focus (JSONB)     <- the entity ids the user confirmed in the
--                                    Stage 4 "is that right?" tap. Used by the
--                                    going-toward emergence gate downstream; not
--                                    carried on the onboarding wire directly.
--   - is_hard_topic               <- OnboardingState.isHardTopic (absent→false
--                                    on the wire; here it is a real column that
--                                    defaults false).
CREATE TABLE IF NOT EXISTS public.user_onboarding_state (
  id                   TEXT PRIMARY KEY DEFAULT 'v1',
  stage                TEXT NOT NULL DEFAULT 'stage_1'
                       CHECK (stage IN ('stage_1','stage_2','stage_3','awaiting_confirmation','confirmed')),
  -- Flattened current prompt. NULL columns == no prompt (prompt:null on wire).
  current_prompt_id    TEXT,
  current_prompt_text  TEXT,
  current_prompt_kind  TEXT
                       CHECK (current_prompt_kind IS NULL OR current_prompt_kind IN
                         ('opening','entity-citing','themed','confirmation','re-entry-softener')),
  current_prompt_issued_at TIMESTAMPTZ,
  -- Packed inferred focus candidates. Present ONLY at awaiting_confirmation.
  inferred_focus       JSONB,
  -- Entity ids the user confirmed in the Stage 4 tap. Not on the onboarding
  -- wire directly; read by the going-toward emergence gate downstream.
  confirmed_focus      JSONB,
  is_hard_topic        BOOLEAN NOT NULL DEFAULT FALSE,
  last_advanced_at     TIMESTAMPTZ,
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Ensure only the single 'v1' row exists (single-user-v1). A second INSERT
-- with a different id is rejected; the UPSERT in the service pins id='v1'.
-- (No extra index: the table is one row.)
