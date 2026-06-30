-- 049_ios_milestone1.sql — iOS API v1 milestone-1 DB substrate
--
-- Three changes, all additive and idempotent (the migrate runner replays every
-- .sql file on every boot):
--   1. capture_idempotency  — at-most-once ingest under client retries.
--   2. notification_cards   — backs the iOS NotificationCard wire contract.
--   3. is_self flag         — NO new table/column. Flags the EXISTING
--                             default-stream USER speaker entity via its
--                             properties JSONB (properties->>'is_self' = true).
--
-- NOTE: 001_consolidated.sql sets search_path = ag_catalog, public, "$user" at
-- session level and we MUST NOT change it (AGE triggers + cypher() depend on
-- it). So ALL DDL below uses explicit public. qualifiers — without them new
-- objects would land in ag_catalog (first in the path). See 046_stream_participants.sql.

-- ============================================
-- 1. capture_idempotency
-- ============================================
-- A retried POST /api/ingest with the same idempotency_key returns the prior
-- memory_id (no duplicate ingest). memory_id is the Qdrant memory point id
-- minted by the first successful ingest — stored as TEXT (no Postgres memories
-- table to FK to; memories live in Qdrant).
CREATE TABLE IF NOT EXISTS public.capture_idempotency (
  idempotency_key TEXT PRIMARY KEY,
  memory_id       TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================
-- 2. notification_cards
-- ============================================
-- Backs the iOS NotificationCard contract. Backend serves only rows where
-- dismissed_at IS NULL; dismissal is a soft-delete (stamp dismissed_at).
CREATE TABLE IF NOT EXISTS public.notification_cards (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  notification_id TEXT NOT NULL,
  kind            TEXT NOT NULL,
  meta            TEXT,
  title           TEXT NOT NULL,
  body            TEXT NOT NULL,
  cta             TEXT,
  target_type     TEXT,
  target_id       TEXT,
  due_at          TIMESTAMPTZ,
  severity        TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  dismissed_at    TIMESTAMPTZ
);

-- Stable wire id the client keys on / references when dismissing.
CREATE UNIQUE INDEX IF NOT EXISTS notification_cards_notification_id_uniq
  ON public.notification_cards (notification_id);

-- Serve-undismissed-by-recency: WHERE dismissed_at IS NULL ORDER BY created_at.
CREATE INDEX IF NOT EXISTS idx_notification_cards_active
  ON public.notification_cards (created_at);

-- ============================================
-- 3. is_self flag (no schema change)
-- ============================================
-- Lowest-risk self flag: set properties->>'is_self' = true on the EXISTING
-- default-stream USER speaker entity. That entity is the one linked from
-- stream_participants where (stream_id, speaker_key) = ('default', 'user')
-- (see findOrCreateSpeaker in services/entities.ts and pipeline.ts
-- DEFAULT_STREAM_ID = 'default'). No new table, no new column, no hub entity.
--
-- Idempotent: jsonb_set with create_missing=true. Safe to run before the
-- speaker exists (the UPDATE simply matches zero rows on a fresh DB; the flag
-- is re-applied on the next migrate replay once the speaker has been created).
UPDATE public.entities e
SET properties = jsonb_set(
      CASE
        WHEN e.properties IS NULL OR jsonb_typeof(e.properties) <> 'object'
          THEN '{}'::jsonb
        ELSE e.properties
      END,
      '{is_self}',
      'true'::jsonb,
      true
    )
FROM public.stream_participants sp
WHERE sp.entity_id = e.id
  AND sp.stream_id = 'default'
  AND sp.speaker_key = 'user';
