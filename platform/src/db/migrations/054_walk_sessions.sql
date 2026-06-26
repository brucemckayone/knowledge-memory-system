-- 054_walk_sessions.sql — iOS API v1 /api/walks/* (ASK-007 / walk session lifecycle)
--
-- Persists the WALK SESSION lifecycle (design/07-modules/walk.md §"Backend
-- integration", ASK-007). A walk is the continuous-listening walking experience:
-- iOS starts a session, answers/skips questions one at a time, and ends to a
-- summary letter. The session record is what makes /state resume (the ~24h
-- window) and the cross-question per-session no-repeat (excludeGhostPatternIds)
-- work. ASK-013's composeWalkQuestions (services/walk-questions.ts, MNEMO-478.1)
-- is the question source; this table is the session + queue persistence.
--
-- Additive + idempotent (the migrate runner replays every .sql file on boot).
-- NOTE: 001_consolidated.sql sets search_path = ag_catalog, public, "$user" at
-- session level and we MUST NOT change it. So all DDL uses explicit public.
-- qualifiers — without them new objects would land in ag_catalog. See
-- 053_re_read_letters.sql / 051_onboarding_state.sql for the same constraint.
--
-- USER/STREAM KEYING (single-user-v1): there is exactly one user in the iOS
-- milestone-1 deployment. We follow the SAME single-user-v1 convention as
-- re_read_letters (053) / user_onboarding_state (051): a constant `user_id` TEXT
-- key defaulting to 'v1'. A multi-user lift would point user_id at the self
-- entity id; that lift is NOT pre-built (fluid-contract-minimality).

-- ============================================
-- walk_sessions — one row per started walk
-- ============================================
CREATE TABLE IF NOT EXISTS public.walk_sessions (
  -- Stable session identity (the iOS session_id carried on every subsequent call).
  session_id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Single-user-v1 key (see header). Constant 'v1' (mirrors re_read_letters).
  user_id                        TEXT NOT NULL DEFAULT 'v1',
  -- The thread this walk targets (nullable — a default/most-active walk has none).
  -- Carried into composeWalkQuestions({threadEntityId}) on start + re-eval.
  thread_entity_id               UUID,
  -- The entry point: 'radial' | 'notification' | 'bridge' (walk.md §"Entry points").
  -- Stored verbatim; the route validates the closed set.
  source                         TEXT,
  -- 'active' | 'ended' | 'abandoned'. A session whose updated_at is older than the
  -- ~24h resume window is LAZILY flipped to 'abandoned' on read (walk.md §"Open
  -- questions" — ~24h resume window). 'ended' is the explicit /end transition.
  status                         TEXT NOT NULL DEFAULT 'active',
  -- The pregenerated summary letter's composition id (re_read_letters.composition_id)
  -- once 478.3 wires the pregen. NULL until a summary exists. /end returns the
  -- pregenerated letter when this points at one, else summary_letter:null.
  summary_letter_composition_id  UUID,
  created_at                     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Last activity. Bumped on every answer/skip; the ~24h resume window measures
  -- from here, NOT created_at, so a long active walk is not falsely abandoned.
  updated_at                     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Resume lookup is by (user, session) PK; this index keeps the "most-recent active
-- session for the user" style scan cheap and documents that active rows are hot.
CREATE INDEX IF NOT EXISTS idx_walk_sessions_user_active
  ON public.walk_sessions (user_id, updated_at DESC)
  WHERE status = 'active';

-- ============================================
-- walk_session_questions — the persisted per-session question queue
-- ============================================
-- One row per question that has been in the session's queue (queued/asked/
-- answered/skipped). Persisting the queue + per-question state is what makes
-- /state resume the exact view and what backs the cross-question no-repeat: the
-- session's already-asked ghost_pattern_ids are SELECTed here and passed as
-- composeWalkQuestions({excludeGhostPatternIds}) so a re-eval never re-asks a gap.
CREATE TABLE IF NOT EXISTS public.walk_session_questions (
  -- The ASK-013 question_id (from composeWalkQuestions). PK — also the answer/skip
  -- lookup key. composeWalkQuestions mints a fresh uuid per question; we persist it.
  question_id        UUID PRIMARY KEY,
  session_id         UUID NOT NULL REFERENCES public.walk_sessions(session_id) ON DELETE CASCADE,
  -- Queue position (insertion order). Drives /state's current-question position +
  -- next_question selection (lowest position still 'queued').
  position           INT NOT NULL,
  question_prose     TEXT NOT NULL,
  -- Bare [] of {start,end,source:{type,id}} (UTF-16 offsets into question_prose).
  -- NEVER null on the wire.
  annotations        JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- {type:'missing_causal_edge', between_entity_ids:[...], ghost_pattern_id}.
  target_gap         JSONB,
  -- The ghost pattern this question targets (denormalised out of target_gap) — the
  -- no-repeat exclusion set + dedup key. NULL only if a question carried no gap.
  ghost_pattern_id   TEXT,
  -- 'queued' | 'asked' | 'answered' | 'skipped'. A walk presents one at a time:
  -- the lowest-position 'queued' becomes the next_question (and is flipped 'asked').
  state              TEXT NOT NULL DEFAULT 'queued',
  -- The memory id the answer ingest minted (answerWalk → store()). NULL until answered.
  answer_memory_id   UUID,
  asked_at           TIMESTAMPTZ,
  answered_at        TIMESTAMPTZ
);

-- Index by session — every read/re-eval scans a session's questions (the queue,
-- the answered list, the exclusion set).
CREATE INDEX IF NOT EXISTS idx_walk_session_questions_session
  ON public.walk_session_questions (session_id, position);
