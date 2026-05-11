-- 007: Prevent self-referential facts
-- Expire existing self-referential facts, then add CHECK constraint.

-- Expire existing self-referential facts
UPDATE public.facts
SET expired_at = NOW(), expire_reason = 'Self-referential fact cleanup'
WHERE object_entity_id = subject_entity_id AND expired_at IS NULL;

-- Prevent future self-referential facts (idempotent: ALTER TABLE ADD CONSTRAINT
-- has no IF NOT EXISTS, so we swallow duplicate_object in a DO block).
DO $$ BEGIN
  ALTER TABLE public.facts ADD CONSTRAINT no_self_reference
    CHECK (object_entity_id IS NULL OR subject_entity_id != object_entity_id);
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
