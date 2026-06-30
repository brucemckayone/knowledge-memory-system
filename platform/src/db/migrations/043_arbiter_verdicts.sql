-- 043_arbiter_verdicts.sql
--
-- Epoch v2 E5 (doc 41 §8a.5, §12 #4; bead nmemo-vpz.5): the promotion-escalation
-- arbiter's verdict store.
--
-- Promotion runs a first (pure) planning pass that surfaces escalations the
-- deterministic backbone cannot settle: IDENTITY (a cluster word-prefix-matching
-- ≥2 distinct canonical entities) and CONFLICT (an exclusive-group collision
-- valid_at ordering cannot break). For each, promotion PUSHES a focused dossier to
-- the arbiter (reconciliation_agent recast, Haiku), which returns a verdict via the
-- propose_identity_verdict / propose_conflict_resolution tools. The verdict is
-- recorded HERE against its dossier, then fed into a second, verdict-aware planning
-- pass that promotion applies (the arbiter decides; promotion executes).
--
-- Flow: promotion pre-records the dossier (verdict NULL) keyed by
-- (epoch_id, escalation_key); the verdict tool UPDATEs the verdict on that row — so
-- an agent can only attach a decision to an escalation promotion actually raised,
-- never invent one. promotion then reads back the decided rows.
--
-- Replay determinism (doc 41 §12 #4): the graph is frozen during arbitration
-- (single writer + no source interleaving), so the only nondeterminism is the LLM
-- verdict. escalation_key is the VALUE-DERIVED stable identity of the escalation
-- (promotion-plan.ts escalationKey) — independent of proposal arrival order — so a
-- replayed promotion of the SAME epoch finds the SAME keys with their verdicts
-- already set and REUSES them without re-invoking the LLM.
--
-- This is a disposal/staging table, NOT canonical: no AGE sync, no fact_history,
-- no invariants. dossier + verdict are JSONB for replay + audit.
--
-- AGE search_path gotcha (CLAUDE.md): 001_consolidated.sql sets the session
-- search_path to `ag_catalog, public, "$user"`. Every object below is EXPLICITLY
-- public.-qualified; we do NOT change the session search_path here.

CREATE TABLE IF NOT EXISTS public.arbiter_verdicts (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Promotion-scope partition (mirrors staging_*): one promotion consumes exactly
  -- one epoch_id's escalations. Injected by the harness (env), not the agent.
  epoch_id        UUID NOT NULL,
  -- Value-derived stable identity of the escalation this verdict resolves
  -- (promotion-plan.ts escalationKey). UNIQUE per epoch so a re-run reuses, not dupes.
  escalation_key  TEXT NOT NULL,
  kind            TEXT NOT NULL,
  -- The focused context promotion pushed to the arbiter (cluster/conflict + why it
  -- escalated + members' facts/aliases/sources). Stored so the verdict stays
  -- interpretable on replay/audit (doc 41 §8a.5).
  dossier         JSONB NOT NULL,
  -- The arbiter's decision (IdentityVerdict | ConflictVerdict shape). NULL until a
  -- verdict tool fills it; a row left NULL means the arbiter declined and promotion
  -- keeps its deterministic conservative default for that escalation.
  verdict         JSONB,
  -- The arbiter actor that decided (reconciliation_agent in normal flow).
  decided_by      VARCHAR(32),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_at      TIMESTAMPTZ,
  CONSTRAINT arbiter_verdict_kind CHECK (kind IN ('identity', 'conflict')),
  CONSTRAINT arbiter_verdict_epoch_key_uniq UNIQUE (epoch_id, escalation_key)
);

CREATE INDEX IF NOT EXISTS idx_arbiter_verdicts_epoch
  ON public.arbiter_verdicts (epoch_id);
