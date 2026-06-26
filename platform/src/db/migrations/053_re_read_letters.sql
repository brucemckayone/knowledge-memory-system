-- 053_re_read_letters.sql — iOS API v1 /api/re-read/* (ASK-011 / re-read read-path)
--
-- Persists the PREGENERATED re-read letters (design/07-modules/re-read.md
-- §"Letters are pregenerated", §"The composed letter", §"The archive"). A letter
-- is past-you speaking to current-you, synthesized server-side from past entries
-- on an open thread; iOS reads what is already prepared and never waits.
--
-- Additive + idempotent (the migrate runner replays every .sql file on boot).
-- NOTE: 001_consolidated.sql sets search_path = ag_catalog, public, "$user" at
-- session level and we MUST NOT change it. So all DDL uses explicit public.
-- qualifiers — without them new objects would land in ag_catalog. See
-- 051_onboarding_state.sql / 050_recent_index.sql / 049_ios_milestone1.sql for
-- the same constraint.
--
-- USER/STREAM KEYING (single-user-v1): there is exactly one user in the iOS
-- milestone-1 deployment. The canonical SELF identity is the default-stream USER
-- speaker — stream_participants.stream_id='default' AND speaker_key='user' —
-- resolved by getSelfEntity() (services/entities.ts). Rather than denormalise the
-- self entity id onto every row, we follow the SAME single-user-v1 convention the
-- onboarding state table uses (051_onboarding_state.sql): a constant `user_id`
-- TEXT key defaulting to 'v1'. A multi-user schema would point user_id at the
-- self entity id (or a users table); that lift is NOT pre-built
-- (fluid-contract-minimality: adapt when reality crystallizes). The service scopes
-- every read to user_id='v1', mirroring how getOpenPromises scopes to the self
-- entity and how user_onboarding_state pins id='v1'.
--
-- Columns mirror the iOS ReReadLetter wire (Sources/MnemoBackend/ASK/ReRead/
-- ReReadLetter.swift) — camelCase on the wire, snake_case here:
--   - letter_id              <- ReReadLetter.letterId  (stable archive identity)
--   - composition_id         <- ReReadLetter.compositionId (carried into reply ctx)
--   - eyebrow                <- ReReadLetter.eyebrow   (one-line time+theme anchor)
--   - body                   <- ReReadLetter.body      (the composed Voice-C prose)
--   - annotations (JSONB)    <- ReReadLetter.annotations (bare [] of {start,end,
--                               source:{type,id}}; UTF-16 offsets into body)
--   - is_intro_letter        <- ReReadLetter.isIntroLetter
--   - is_hard_topic          <- ReReadLetter.isHardTopic
--   - thread_focus_entity_ids(JSONB) <- ReReadLetter.threadFocusEntityIds ([] not null)
--   - composed_at            <- ReReadLetter.composedAt (ISO8601 on the wire)
--   - prev_reply (JSONB)     <- ReReadLetter.prevReply ({replyMemoryId,transcript,
--                               recordedAt} | null)
-- Plus the storage/lifecycle columns the read queries need:
--   - thread_entity_id       the thread this letter is ABOUT (nullable — the intro
--                            letter has no thread). Distinct from
--                            thread_focus_entity_ids (the focus-area set carried
--                            into reply context): thread_entity_id is the lookup
--                            key for GET /api/re-read/?threadEntityId=.
--   - is_current             marks the LIVE letter for a thread. Prior compositions
--                            are immutable + retained for the archive (re-read.md
--                            §"The archive" — recent letters live on); composing a
--                            new letter for a thread flips the prior row's
--                            is_current FALSE (supersede) and inserts a new current
--                            row with a fresh composition_id. The intro letter is
--                            is_current=FALSE always (it is never the "current"
--                            most-resonant letter — it is the permanent
--                            archive-bottom).

-- ============================================
-- re_read_letters
-- ============================================
CREATE TABLE IF NOT EXISTS public.re_read_letters (
  -- Stable per-letter archive identity (the iOS ForEach id). Distinct rows always
  -- get distinct letter_ids; the archive list is list-unique on this.
  letter_id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The composition that produced this letter. A NEW composition_id per compose
  -- (re-read.md §"Reply recording" — carried into the reply's ingest context so a
  -- future re-read knows the reply answered THIS letter).
  composition_id         UUID NOT NULL DEFAULT gen_random_uuid(),
  -- Single-user-v1 key (see header). Constant 'v1' (mirrors user_onboarding_state).
  user_id                TEXT NOT NULL DEFAULT 'v1',
  -- The thread this letter is ABOUT. NULL for the intro letter (no thread).
  thread_entity_id       UUID,
  -- The focus-area entity ids carried into the reply's thread context. [] (never
  -- null) on the wire; stored as a JSONB array. Empty for the intro letter.
  thread_focus_entity_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  eyebrow                TEXT NOT NULL,
  body                   TEXT NOT NULL,
  -- Bare [] of {start,end,source:{type,id}} (UTF-16 offsets into body). Empty for
  -- the intro letter (it cites nothing). NEVER null on the wire.
  annotations            JSONB NOT NULL DEFAULT '[]'::jsonb,
  is_intro_letter        BOOLEAN NOT NULL DEFAULT FALSE,
  is_hard_topic          BOOLEAN NOT NULL DEFAULT FALSE,
  -- The live/current letter per thread. Prior compositions stay (immutable,
  -- retained for the archive) with is_current FALSE.
  is_current             BOOLEAN NOT NULL DEFAULT FALSE,
  composed_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- {replyMemoryId, transcript, recordedAt} | NULL. NULL until the user replies.
  prev_reply             JSONB
);

-- The CURRENT letter per (user, thread). The service's getCurrentLetter() and
-- getLetterByThread() both filter is_current=TRUE; this partial index keeps those
-- reads cheap and also documents the intent (only current rows are hot).
CREATE INDEX IF NOT EXISTS idx_re_read_current
  ON public.re_read_letters (user_id, composed_at DESC)
  WHERE is_current = TRUE;

-- Lookup by thread (GET /api/re-read/?threadEntityId=). Partial-current so the
-- per-thread current letter resolves in one index hit.
CREATE INDEX IF NOT EXISTS idx_re_read_thread_current
  ON public.re_read_letters (user_id, thread_entity_id)
  WHERE is_current = TRUE;

-- Archive list (GET /api/re-read/all) — recent-first across ALL letters for the
-- user (current + retained prior compositions), intro letter sorted last in the
-- service.
CREATE INDEX IF NOT EXISTS idx_re_read_archive
  ON public.re_read_letters (user_id, composed_at DESC);

-- ============================================
-- The introduction letter — static sentinel row
-- ============================================
-- The single curated, static letter present from first launch (re-read.md
-- §"The introduction letter"). It is the ONE place the never-an-entity rule is
-- suspended (the intro explains what the experience IS, because the user has no
-- past-self yet to speak for). Permanent archive-bottom, never pruned, no
-- annotations (cites nothing), no thread. is_current=FALSE always (it is never the
-- "most-resonant current" letter — getCurrentLetter excludes intro).
--
-- Fixed letter_id + composition_id sentinels so re-running this migration is
-- idempotent (ON CONFLICT DO NOTHING) and the intro is stably identifiable.
--
-- ⚠️ PLACEHOLDER COPY — the real intro letter prose is PENDING the design lead.
-- This body is a clearly-marked stand-in so the archive renders an intro from day
-- one; replace `body` (and `eyebrow`) with the final curated copy when it lands.
-- Voice-C: lowercase, no system-self "i, mnemo" framing beyond the sanctioned
-- intro suspension. composeReReadLetter NEVER touches this row (it is hand-curated,
-- not LLM-composed — the one exception to "Voice-C prose only via compose").
INSERT INTO public.re_read_letters (
  letter_id,
  composition_id,
  user_id,
  thread_entity_id,
  thread_focus_entity_ids,
  eyebrow,
  body,
  annotations,
  is_intro_letter,
  is_hard_topic,
  is_current,
  composed_at,
  prev_reply
) VALUES (
  '00000000-0000-0000-0000-000000000011'::uuid,  -- fixed intro letter_id sentinel
  '00000000-0000-0000-0000-000000000011'::uuid,  -- fixed intro composition_id sentinel
  'v1',
  NULL,
  '[]'::jsonb,
  'the beginning',
  -- PLACEHOLDER — replace with the design lead's final intro copy.
  'this is where your past self will write to you. as you capture, threads form — and one day a letter from an earlier you will be waiting here. for now, this is the first page.',
  '[]'::jsonb,
  TRUE,   -- is_intro_letter
  FALSE,  -- is_hard_topic
  FALSE,  -- is_current (intro is never the "current most-resonant" letter)
  -- Pin composed_at to the epoch so the intro always sorts LAST in a recent-first
  -- archive list (oldest = bottom). The service also force-sorts intro last as a
  -- belt-and-braces guard.
  '1970-01-01T00:00:00Z'::timestamptz,
  NULL
)
ON CONFLICT (letter_id) DO NOTHING;
