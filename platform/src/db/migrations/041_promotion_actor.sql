-- 041_promotion_actor.sql
--
-- Epoch v2 (doc 41 §5f, §8, bead nmemo-vpz.3 / E3): register the `promotion`
-- audit actor.
--
-- Unlike `extraction_proposer` (mig 040 / E2), which writes ONLY staging and is
-- deliberately ABSENT from the audit CHECKs (a proposer value reaching an audit
-- column is a bug), `promotion` IS the deterministic authority that writes
-- canonical entities/facts in one transaction (doc 41 §5f). Every supersession /
-- insert it performs emits a fact_history row stamped actor='promotion', so the
-- value MUST be permitted by the CHECK. Audit consumers can then isolate
-- promotion-driven mutations from agent (graph_agent) and merge (cascade) writes.
--
-- Added to the edge CHECK too: E6's causal-promotion will stamp the same actor on
-- edge mutations it disposes; permitting it now avoids a second migration then,
-- and the value is meaningless until used.
--
-- AGE search_path gotcha (CLAUDE.md): 001_consolidated.sql sets the session
-- search_path to `ag_catalog, public, "$user"`. Both tables are EXPLICITLY
-- public.-qualified; we do NOT change the session search_path here.

ALTER TABLE public.fact_history
  DROP CONSTRAINT IF EXISTS valid_fact_actor;
ALTER TABLE public.fact_history
  ADD CONSTRAINT valid_fact_actor CHECK (
    actor IN ('graph_agent', 'reasoning_agent', 'gardener_agent',
              'reconciliation_agent', 'user', 'system_trigger', 'cascade',
              'promotion')
  );

ALTER TABLE public.causal_edge_history
  DROP CONSTRAINT IF EXISTS valid_edge_actor;
ALTER TABLE public.causal_edge_history
  ADD CONSTRAINT valid_edge_actor CHECK (
    actor IN ('graph_agent', 'reasoning_agent', 'gardener_agent',
              'reconciliation_agent', 'user', 'system_trigger', 'cascade',
              'promotion')
  );
