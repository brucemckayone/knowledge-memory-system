-- 057_concept_layer.sql — Cross-corpus: enable the emergent-concept layer
-- Bead nmemo-uhp.20. Spec: docs/architecture/cross-corpus-audit/19-concept-layer-design.md.
--
-- Concepts are `entities` rows with entity_type='concept' (already seeded canonical in mig 001,
-- no change needed here), all living in ONE reserved corpus `_concepts` (D-C2) so mergeEntities
-- and the same-corpus merge_candidates FK apply natively — no fusion-guard surgery. An element
-- "exhibits"/"addresses" a concept via a bridge_edges row with b_kind='entity' — NOT a fact
-- (facts can't cross corpora, mig 052 composite FK). This migration only OPENS the CHECK
-- vocabularies the concept layer needs:
--   * bridge_edges.valid_bridge_kinds        += 'entity'   (bridge-promotion.ts ElementKind and
--     catalogHas already handle 'entity'; the mig 054 DB CHECK is the last gate that rejects it)
--   * bridge_edges.valid_bridge_relation     += 'exhibits','addresses'
--   * staging_bridge_edges.valid_staging_bridge_relation += 'exhibits','addresses'
-- staging_bridge_edges has NO kinds CHECK (mig 054), so there is nothing to widen there.
--
-- Widening a CHECK is a DROP + re-ADD (Postgres can't alter a CHECK in place). Existing rows all
-- use the old (narrower) vocabulary, so re-adding the wider CHECK never fails validation.
--
-- AGE note (CLAUDE.md): 001 sets session search_path = ag_catalog, public, "$user"; do NOT change
-- it and qualify every object with public. Idempotent (DROP CONSTRAINT IF EXISTS before ADD;
-- INSERT ... ON CONFLICT DO NOTHING).

-- ============================================
-- 1. Reserve the shared concept corpus (D-C2)
-- ============================================
-- 'assimilating' — within _concepts we WANT same-mechanism concepts to fuse/merge (that is the
-- whole point of concept resolution); the comparative stance is for the audit corpora, not here.
INSERT INTO public.corpus_policies (corpus_id, mode)
VALUES ('_concepts', 'assimilating')
ON CONFLICT (corpus_id) DO NOTHING;

-- entity_type='concept' is already seeded canonical in mig 001 line 40. Re-asserted here
-- (no-op on a normal DB) purely to document the dependency and stay safe on a hand-built DB.
INSERT INTO public.entity_types (name, description, status) VALUES
  ('concept', 'An abstract concept, idea, or topic', 'canonical')
ON CONFLICT (name) DO NOTHING;

-- ============================================
-- 2. bridge_edges — widen endpoint kinds to include 'entity' (D-C3)
-- ============================================
ALTER TABLE public.bridge_edges DROP CONSTRAINT IF EXISTS valid_bridge_kinds;
ALTER TABLE public.bridge_edges ADD CONSTRAINT valid_bridge_kinds CHECK (
  a_kind IN ('code_element', 'rule_element', 'entity')
  AND b_kind IN ('code_element', 'rule_element', 'entity')
);

-- ============================================
-- 3. bridge_edges + staging — widen relation vocabulary (D-C4)
-- ============================================
ALTER TABLE public.bridge_edges DROP CONSTRAINT IF EXISTS valid_bridge_relation;
ALTER TABLE public.bridge_edges ADD CONSTRAINT valid_bridge_relation CHECK (
  relation IN ('violates', 'satisfies', 'not_applicable', 'exhibits', 'addresses')
);

ALTER TABLE public.staging_bridge_edges DROP CONSTRAINT IF EXISTS valid_staging_bridge_relation;
ALTER TABLE public.staging_bridge_edges ADD CONSTRAINT valid_staging_bridge_relation CHECK (
  relation IN ('violates', 'satisfies', 'not_applicable', 'exhibits', 'addresses')
);
