-- 055_corpus_policies.sql — Cross-corpus Phase A: assimilating|comparative policy preset
-- Bead nmemo-uhp.8. Spec: docs/architecture/cross-corpus-audit/04-hardened-spec.md §2 (D5).
--
-- The honest home for the per-corpus stance knobs (word-prefix bind, contradiction stance),
-- instead of `if (corpus === ...)` branches scattered through the planner. A corpus is either:
--   * 'assimilating' — the current fuse-everything behaviour (main pile; blend in). Word-prefix
--     rule-3 single-match bind stays (D5).
--   * 'comparative'  — kept separate for cross-corpus analysis. The word-prefix single-match
--     branch escalates to the arbiter instead of binding (D5) — never an embedding gate, never
--     touching rule-4 fresh-cluster folding.
--
-- 'default' is seeded assimilating so existing single-corpus behaviour is unchanged.
-- AGE note (CLAUDE.md): do not change session search_path; qualify public. Idempotent.

CREATE TABLE IF NOT EXISTS public.corpus_policies (
  corpus_id   TEXT PRIMARY KEY,
  mode        VARCHAR(16) NOT NULL DEFAULT 'assimilating',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT valid_corpus_mode CHECK (mode IN ('assimilating', 'comparative'))
);

-- The default corpus is assimilating — preserves current fuse-everything behaviour.
INSERT INTO public.corpus_policies (corpus_id, mode)
VALUES ('default', 'assimilating')
ON CONFLICT (corpus_id) DO NOTHING;
