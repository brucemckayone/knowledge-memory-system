-- 037_stream_participants.sql — speaker-aware extraction (nmemo-3f9.1)
--
-- Two additive changes for context-driven first-person / speaker-aware
-- extraction. No CHECK-constraint surgery: entity_type is a free varchar
-- validated against the public.entity_types catalog (001_consolidated.sql).
--
-- NOTE: 001_consolidated.sql sets search_path = ag_catalog, public, "$user"
-- at session level and we MUST NOT change it (AGE triggers + cypher() depend
-- on it). So ALL DDL below uses explicit public. qualifiers — without them new
-- objects would land in ag_catalog (first in the path) and the FK to
-- public.entities would fail cross-schema. See 002_causal_graph.sql.

-- ============================================
-- 1. Seed the `assistant` entity type
-- ============================================
-- Chosen over `agent` to avoid the codebase's agent overload. Canonical so it
-- is returned by getValidEntityTypes() (status canonical|provisional).
INSERT INTO public.entity_types (name, description, status) VALUES
  ('assistant', 'An AI assistant / conversational agent participant in a stream', 'canonical')
ON CONFLICT (name) DO NOTHING;

-- ============================================
-- 2. Stream-scoped speaker identity
-- ============================================
-- Maps a (stream_id, speaker_key) to a single entity, deterministically and
-- WITHOUT consulting names or embeddings. This is what lets two streams that
-- both call their speaker "User" resolve to two distinct entities:
-- find_or_create_speaker keys only on (stream_id, speaker_key), bypassing
-- resolveEntity's 0.92-cosine auto-merge and createEntity's name dedup.
--
-- entity_id is an FK (not a denormalised copy): a future merge re-points it
-- (deferred to nmemo-3f9.6 / accretion decision #6), and the reverse index
-- supports that re-point plus cross-stream convergence signals.
CREATE TABLE IF NOT EXISTS public.stream_participants (
  stream_id   TEXT NOT NULL,
  speaker_key TEXT NOT NULL,
  entity_id   UUID NOT NULL REFERENCES public.entities(id) ON DELETE CASCADE,
  role        TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (stream_id, speaker_key)
);

-- Reverse lookup: all stream rows owned by an entity (merge re-point in 3f9.6,
-- future cross-stream convergence).
CREATE INDEX idx_stream_participants_entity
  ON public.stream_participants (entity_id);
