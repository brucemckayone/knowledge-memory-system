-- misra-chapter-impact.sql
-- Level 3 fixture for Phase 4 (Blast Radius Analysis)
-- klv.4 graduation criterion (doc 15 line 636).
--
-- Scenario: a coherent slice of MISRA C++:2023 Chapter 22 (Resource Management).
-- 10 rule entities + 4 supporting concept entities, with rule-to-rule
-- depends_on/related_to/supersedes facts and rule-to-concept addresses facts.
-- Causal edges synthesise the chapter's reasoning chain so the severity ladder
-- and the four adversarial scenarios baked into klv.4 graduation all fire:
--
--   (A) Orphan-a-pattern (F1 — nmemo-2yv.99):
--       A canonical pattern with one instance, all edges touching one rule.
--       Expiring that rule's root event leaves edges_outside_root = 0
--       → patternImpact[*].severity === 'high'.
--
--   (B) Well-corroborated cascade (F8 Rule 1 — nmemo-2yv.106):
--       Rule R22.1 (root MISRA-safe heap rule) is the citation source for
--       three sole-evidence edges with corroboration_count >= 3. Under
--       hypothetical=expire on R22.1 the related citation gets severity
--       'critical' (Rule 1).
--
--   (C) Low-corroboration sole-evidence (F8 Rule 1b — nmemo-2yv.106):
--       Three citing edges have corroboration_count = 1 and a single source
--       ref pointing at R22.1. Under hypothetical=expire on R22.1 these
--       become sole-evidence-lost-at-low-corroboration → severity 'high'.
--
--   (D) Redundant child (F2 — nmemo-2yv.100):
--       A shortcut edge from R22.1 root event -> R22.4 event makes R22.4 a
--       depth-1 effect of the root walk. R22.4 has three alternate causes
--       (R22.6, R22.7, R22.8) besides the root. Under analyzeImpact starting
--       from the chapter root, otherCausesCount === 3 → severity 'low'.
--
-- Selection criterion (from bead nmemo-2yv.107 Scoped fix):
--   - >=8 rules                    → 10 rule entities + 4 concept entities (14 total)
--   - >=15 dependency edges        → 15 active causal_edges
--   - >=3 layers transitive depth  → R22.1 → R22.2 → R22.3 → R22.4 → R22.5 (chain depth 4)
--   - >=2 candidate orphan-a-pattern scenarios → orphan tier + Rule 1 + Rule 1b combos
--
-- UUID convention:
--   Entities (rules):       00000008-0000-0000-0000-(01..0a)  -- 10 MISRA rules
--   Entities (concepts):    00000008-0000-0000-0000-(11..14)  -- 4 supporting concepts
--   Facts (deps):           10000008-0000-0000-0000-(01..0e)  -- 14 facts (10 rule-to-rule deps + 4 rule-to-concept addresses)
--   Events:                 20000008-0000-0000-0000-(01..0e)  -- 14 events
--   Edges (chain):          30000008-0000-0000-0000-(01..10)  -- 16 active edges
--                                                                (spine + alt-causes + cross-cut + pattern arm + R22.1->R22.4 shortcut)
--   Edge source refs:       implicit (no UUID)
--   Patterns:               40000008-0000-0000-0000-0001      -- 1 canonical pattern
--
-- The chosen "root rule" for chapter-wide impact tests is:
--   R22.1 entity id: 00000008-0000-0000-0000-000000000001
--   R22.1 root event id: 20000008-0000-0000-0000-000000000001
--
-- Expected severity ladder snapshot is frozen in
-- platform/src/test/data/phase4-blastradius/expected/misra-chapter-impact.expected.json

BEGIN;

-- =========================================================================
-- Entities — 10 MISRA Chapter 22 rules + 4 supporting concepts
-- =========================================================================
INSERT INTO public.entities (id, canonical_name, entity_type, properties)
VALUES
  ('00000008-0000-0000-0000-000000000001', 'MISRA-CPP-2023-Rule-22.1', 'standard_rule', '{"chapter": 22, "topic": "heap_allocation_forbidden_in_safety_critical"}'::jsonb),
  ('00000008-0000-0000-0000-000000000002', 'MISRA-CPP-2023-Rule-22.2', 'standard_rule', '{"chapter": 22, "topic": "raii_required_when_dynamic"}'::jsonb),
  ('00000008-0000-0000-0000-000000000003', 'MISRA-CPP-2023-Rule-22.3', 'standard_rule', '{"chapter": 22, "topic": "smart_pointer_usage"}'::jsonb),
  ('00000008-0000-0000-0000-000000000004', 'MISRA-CPP-2023-Rule-22.4', 'standard_rule', '{"chapter": 22, "topic": "ownership_must_be_explicit"}'::jsonb),
  ('00000008-0000-0000-0000-000000000005', 'MISRA-CPP-2023-Rule-22.5', 'standard_rule', '{"chapter": 22, "topic": "no_dangling_pointer_dereference"}'::jsonb),
  ('00000008-0000-0000-0000-000000000006', 'MISRA-CPP-2023-Rule-22.6', 'standard_rule', '{"chapter": 22, "topic": "raw_pointer_arithmetic_forbidden"}'::jsonb),
  ('00000008-0000-0000-0000-000000000007', 'MISRA-CPP-2023-Rule-22.7', 'standard_rule', '{"chapter": 22, "topic": "delete_must_match_new"}'::jsonb),
  ('00000008-0000-0000-0000-000000000008', 'MISRA-CPP-2023-Rule-22.8', 'standard_rule', '{"chapter": 22, "topic": "array_new_must_match_array_delete"}'::jsonb),
  ('00000008-0000-0000-0000-000000000009', 'MISRA-CPP-2023-Rule-22.9', 'standard_rule', '{"chapter": 22, "topic": "no_double_free"}'::jsonb),
  ('00000008-0000-0000-0000-00000000000a', 'MISRA-CPP-2023-Rule-22.10', 'standard_rule', '{"chapter": 22, "topic": "weak_ptr_must_be_locked_before_use"}'::jsonb),
  -- Concept entities (rule-to-concept "addresses" facts)
  ('00000008-0000-0000-0000-000000000011', 'RAII',             'concept', '{}'::jsonb),
  ('00000008-0000-0000-0000-000000000012', 'HeapAllocation',   'concept', '{}'::jsonb),
  ('00000008-0000-0000-0000-000000000013', 'SmartPointer',     'concept', '{}'::jsonb),
  ('00000008-0000-0000-0000-000000000014', 'Ownership',        'concept', '{}'::jsonb);

-- =========================================================================
-- Facts — rule-to-rule dependency facts + rule-to-concept addresses facts
--
-- depends_on   : the rule_a relies on rule_b being applied (used as the
--                primary directed-graph spine)
-- supersedes   : the newer rule replaces an older one
-- related_to   : non-directed cross-cutting relationship
-- addresses    : a rule speaks to a concept entity
-- =========================================================================
INSERT INTO public.facts (id, subject_entity_id, predicate, object_entity_id)
VALUES
  -- R22.1 depends_on R22.2 (root → spine)
  ('10000008-0000-0000-0000-000000000001', '00000008-0000-0000-0000-000000000001', 'depends_on', '00000008-0000-0000-0000-000000000002'),
  -- R22.2 depends_on R22.3 (chain spine)
  ('10000008-0000-0000-0000-000000000002', '00000008-0000-0000-0000-000000000002', 'depends_on', '00000008-0000-0000-0000-000000000003'),
  -- R22.3 depends_on R22.4 (chain spine)
  ('10000008-0000-0000-0000-000000000003', '00000008-0000-0000-0000-000000000003', 'depends_on', '00000008-0000-0000-0000-000000000004'),
  -- R22.4 depends_on R22.5 (chain spine, depth 4 from root)
  ('10000008-0000-0000-0000-000000000004', '00000008-0000-0000-0000-000000000004', 'depends_on', '00000008-0000-0000-0000-000000000005'),
  -- Three alternate depends_on facts targeting R22.4 (for F2 redundant-child)
  ('10000008-0000-0000-0000-000000000005', '00000008-0000-0000-0000-000000000006', 'depends_on', '00000008-0000-0000-0000-000000000004'),
  ('10000008-0000-0000-0000-000000000006', '00000008-0000-0000-0000-000000000007', 'depends_on', '00000008-0000-0000-0000-000000000004'),
  ('10000008-0000-0000-0000-000000000007', '00000008-0000-0000-0000-000000000008', 'depends_on', '00000008-0000-0000-0000-000000000004'),
  -- Side-chain: R22.7 supersedes R22.8 (cross-cutting causal claim)
  ('10000008-0000-0000-0000-000000000008', '00000008-0000-0000-0000-000000000007', 'supersedes', '00000008-0000-0000-0000-000000000008'),
  -- R22.9 related_to R22.5 (cross-cutting)
  ('10000008-0000-0000-0000-000000000009', '00000008-0000-0000-0000-000000000009', 'related_to', '00000008-0000-0000-0000-000000000005'),
  -- R22.10 depends_on R22.3 (a stand-alone leaf)
  ('10000008-0000-0000-0000-00000000000a', '00000008-0000-0000-0000-00000000000a', 'depends_on', '00000008-0000-0000-0000-000000000003'),
  -- Rule-to-concept addresses facts (semantic anchors)
  ('10000008-0000-0000-0000-00000000000b', '00000008-0000-0000-0000-000000000001', 'addresses', '00000008-0000-0000-0000-000000000012'),
  ('10000008-0000-0000-0000-00000000000c', '00000008-0000-0000-0000-000000000002', 'addresses', '00000008-0000-0000-0000-000000000011'),
  ('10000008-0000-0000-0000-00000000000d', '00000008-0000-0000-0000-000000000003', 'addresses', '00000008-0000-0000-0000-000000000013'),
  ('10000008-0000-0000-0000-00000000000e', '00000008-0000-0000-0000-000000000004', 'addresses', '00000008-0000-0000-0000-000000000014');

-- =========================================================================
-- Causal events — one per primary depends_on/supersedes/related_to fact
-- (concept "addresses" facts do not anchor causal events here; they exist
-- only to provide direct dependents for the entity-root tests.)
--
-- Event UUIDs map to subject rule positions:
--   01 : R22.1 root          (fact id 01: R22.1 depends_on R22.2)
--   02 : R22.2 spine         (fact id 02: R22.2 depends_on R22.3)
--   03 : R22.3 spine         (fact id 03: R22.3 depends_on R22.4)
--   04 : R22.4 spine         (fact id 04: R22.4 depends_on R22.5)
--   05 : R22.6 alt-cause     (fact id 05: R22.6 depends_on R22.4)
--   06 : R22.7 alt-cause     (fact id 06: R22.7 depends_on R22.4)
--   07 : R22.8 alt-cause     (fact id 07: R22.8 depends_on R22.4)
--   08 : R22.7 supersedes    (fact id 08: R22.7 supersedes R22.8)
--   09 : R22.9 related_to    (fact id 09: R22.9 related_to R22.5)
--   0a : R22.10 leaf         (fact id 0a: R22.10 depends_on R22.3)
--   0b..0e : pattern-arm     events used by the canonical pattern below
-- =========================================================================
INSERT INTO public.causal_events (id, fact_id, transition_type, subject_entity_id, predicate, source_text)
VALUES
  ('20000008-0000-0000-0000-000000000001', '10000008-0000-0000-0000-000000000001', 'created', '00000008-0000-0000-0000-000000000001', 'depends_on', 'MISRA Chapter 22 root claim: heap allocation forbidden depends on RAII enforcement'),
  ('20000008-0000-0000-0000-000000000002', '10000008-0000-0000-0000-000000000002', 'created', '00000008-0000-0000-0000-000000000002', 'depends_on', 'MISRA spine: RAII requires smart-pointer discipline'),
  ('20000008-0000-0000-0000-000000000003', '10000008-0000-0000-0000-000000000003', 'created', '00000008-0000-0000-0000-000000000003', 'depends_on', 'MISRA spine: smart pointer usage requires explicit ownership'),
  ('20000008-0000-0000-0000-000000000004', '10000008-0000-0000-0000-000000000004', 'created', '00000008-0000-0000-0000-000000000004', 'depends_on', 'MISRA spine: explicit ownership prevents dangling-pointer deref'),
  ('20000008-0000-0000-0000-000000000005', '10000008-0000-0000-0000-000000000005', 'created', '00000008-0000-0000-0000-000000000006', 'depends_on', 'R22.6 pointer-arithmetic depends on ownership rule'),
  ('20000008-0000-0000-0000-000000000006', '10000008-0000-0000-0000-000000000006', 'created', '00000008-0000-0000-0000-000000000007', 'depends_on', 'R22.7 delete-must-match-new depends on ownership rule'),
  ('20000008-0000-0000-0000-000000000007', '10000008-0000-0000-0000-000000000007', 'created', '00000008-0000-0000-0000-000000000008', 'depends_on', 'R22.8 array-delete depends on ownership rule'),
  ('20000008-0000-0000-0000-000000000008', '10000008-0000-0000-0000-000000000008', 'created', '00000008-0000-0000-0000-000000000007', 'supersedes', 'R22.7 supersedes R22.8 (array form folded into general delete rule)'),
  ('20000008-0000-0000-0000-000000000009', '10000008-0000-0000-0000-000000000009', 'created', '00000008-0000-0000-0000-000000000009', 'related_to', 'R22.9 double-free related to dangling-pointer'),
  ('20000008-0000-0000-0000-00000000000a', '10000008-0000-0000-0000-00000000000a', 'created', '00000008-0000-0000-0000-00000000000a', 'depends_on', 'R22.10 weak_ptr.lock depends on smart-pointer usage'),
  -- Pattern arm events (for scenario A — orphan-a-pattern). Single instance
  -- of a 3-step canonical pattern, all edges touching the R22.1 root.
  ('20000008-0000-0000-0000-00000000000b', NULL, 'created', '00000008-0000-0000-0000-000000000001', 'addresses', 'pattern instance arm 0 (cause = R22.1 root)'),
  ('20000008-0000-0000-0000-00000000000c', NULL, 'created', '00000008-0000-0000-0000-000000000001', 'addresses', 'pattern instance arm 1 (still cause = R22.1 root)'),
  ('20000008-0000-0000-0000-00000000000d', NULL, 'created', '00000008-0000-0000-0000-000000000011', 'addresses', 'pattern instance arm 2 (RAII concept)'),
  ('20000008-0000-0000-0000-00000000000e', NULL, 'created', '00000008-0000-0000-0000-000000000013', 'addresses', 'pattern instance arm 3 (SmartPointer concept)');

-- =========================================================================
-- Canonical pattern — single instance, all edges touching the R22.1 root.
-- Used to validate the F1 orphan tier (severity = 'high').
-- =========================================================================
INSERT INTO public.causal_patterns (id, name, description, template_structure, template_length, status)
VALUES
  ('40000008-0000-0000-0000-000000000001',
   'MISRA-Heap-RAII-SmartPtr-Chain',
   'Chapter 22 canonical pattern: heap allocation rule -> RAII -> smart pointer (orphan tier scenario)',
   '[{"entity_type":"standard_rule","predicate_category":"depends_on"},
     {"entity_type":"concept","predicate_category":"addresses"}]'::jsonb,
   2, 'canonical')
ON CONFLICT (id) DO NOTHING;

-- =========================================================================
-- Causal edges — primary chain spine + cross-cutting + pattern arm.
--
-- Active edges:
--   01: R22.1_event  -> R22.2_event   (chain depth 1)               strength 0.9
--   02: R22.2_event  -> R22.3_event   (chain depth 2)               strength 0.85
--   03: R22.3_event  -> R22.4_event   (chain depth 3 via spine)     strength 0.8
--   04: R22.4_event  -> R22.9_event   (chain depth 4 via spine)     strength 0.75
--   05: R22.6_event  -> R22.4_event   (alt cause for R22.4)         strength 0.7
--   06: R22.7_event  -> R22.4_event   (alt cause for R22.4)         strength 0.7
--   07: R22.8_event  -> R22.4_event   (alt cause for R22.4)         strength 0.7
--   08: R22.7sup     -> R22.10_event  (cross-cutting)               strength 0.65
--   09: R22.9_event  -> R22.10_event  (cross-cutting)               strength 0.6
--   0a: R22.10_event -> R22.1_event   (back-edge cross-cut)         strength 0.55
--   0b: R22.1_event  -> pattern_arm_0 (pattern edge, touches root)  strength 0.8
--   0c: pattern_arm_0 -> pattern_arm_1 (pattern edge, both endpoints have R22.1 subject) strength 0.8
--   0d: pattern_arm_1 -> pattern_arm_2 (pattern edge, cause has R22.1 subject)  strength 0.8
--   0e: R22.1_event   -> pattern_arm_3 (pattern edge, cause IS R22.1 root)      strength 0.8
--   0f: R22.10_event  -> R22.9_event  (cross-cut leaf)              strength 0.5
--   10: R22.1_event   -> R22.4_event  (shortcut for F2 redundant-child) strength 0.4
--
-- For orphan tier (F1): all four pattern edges have cause_event_id pointing
-- at the R22.1 chapter root event (or arm-of-root). Expiring the R22.1
-- entity orphans the pattern → edges_outside_root === 0.
--
-- Citation edges (Rule 1 / Rule 1b under hypothetical=expire):
--   - Edges 01, 02, 03: each cites R22.1 (well-corroborated). corroboration_count = 3 → Rule 1 critical.
--   - Edges 05, 06, 07: each cites R22.1 (sole evidence, corroboration=1). → Rule 1b high.
--
-- Strength severity (Rule 3):
--   - Edges 01..04 all have strength >= 0.7 → high
-- =========================================================================
INSERT INTO public.causal_edges (
  id, cause_event_id, effect_event_id, strength, reasoning,
  source_references, extraction_method, corroboration_count, initial_strength
)
VALUES
  -- Spine
  ('30000008-0000-0000-0000-000000000001', '20000008-0000-0000-0000-000000000001', '20000008-0000-0000-0000-000000000002', 0.9,  'Forbidding heap allocation requires RAII to be in place first',           '[]'::jsonb, 'manual', 3, 0.9),
  ('30000008-0000-0000-0000-000000000002', '20000008-0000-0000-0000-000000000002', '20000008-0000-0000-0000-000000000003', 0.85, 'RAII enforcement materially benefits from smart-pointer adoption',        '[]'::jsonb, 'manual', 3, 0.85),
  ('30000008-0000-0000-0000-000000000003', '20000008-0000-0000-0000-000000000003', '20000008-0000-0000-0000-000000000004', 0.8,  'Smart-pointer usage relies on explicit ownership semantics',              '[]'::jsonb, 'manual', 3, 0.8),
  ('30000008-0000-0000-0000-000000000004', '20000008-0000-0000-0000-000000000004', '20000008-0000-0000-0000-000000000009', 0.75, 'Explicit ownership prevents dangling-pointer deref scenarios',            '[]'::jsonb, 'manual', 2, 0.75),
  -- Alt causes for R22.4_event (depth-1 effect from root chain, used by F2)
  ('30000008-0000-0000-0000-000000000005', '20000008-0000-0000-0000-000000000005', '20000008-0000-0000-0000-000000000004', 0.7,  'R22.6 pointer-arithmetic forbidance also flows into the ownership rule',  '[]'::jsonb, 'manual', 1, 0.7),
  ('30000008-0000-0000-0000-000000000006', '20000008-0000-0000-0000-000000000006', '20000008-0000-0000-0000-000000000004', 0.7,  'R22.7 delete-match-new also relies on ownership',                         '[]'::jsonb, 'manual', 1, 0.7),
  ('30000008-0000-0000-0000-000000000007', '20000008-0000-0000-0000-000000000007', '20000008-0000-0000-0000-000000000004', 0.7,  'R22.8 array-form also relies on ownership',                               '[]'::jsonb, 'manual', 1, 0.7),
  -- Cross-cutting edges
  ('30000008-0000-0000-0000-000000000008', '20000008-0000-0000-0000-000000000008', '20000008-0000-0000-0000-00000000000a', 0.65, 'R22.7 supersedes claim cross-cuts the weak_ptr.lock requirement',         '[]'::jsonb, 'manual', 1, 0.65),
  ('30000008-0000-0000-0000-000000000009', '20000008-0000-0000-0000-000000000009', '20000008-0000-0000-0000-00000000000a', 0.6,  'Double-free reasoning informs weak_ptr.lock motivation',                  '[]'::jsonb, 'manual', 1, 0.6),
  ('30000008-0000-0000-0000-00000000000a', '20000008-0000-0000-0000-00000000000a', '20000008-0000-0000-0000-000000000001', 0.55, 'weak_ptr.lock rule informs back-propagated review of R22.1 rationale',    '[]'::jsonb, 'manual', 1, 0.55),
  -- Pattern arm edges (single-instance canonical pattern; orphan-tier scenario).
  -- Every edge has its cause or effect inside the R22.1 root_event_ids set
  -- (events 01, 0b, 0c — events whose subject_entity_id is R22.1).
  ('30000008-0000-0000-0000-00000000000b', '20000008-0000-0000-0000-000000000001', '20000008-0000-0000-0000-00000000000b', 0.8,  'pattern step 0 - R22.1 root anchors the heap-RAII-smartptr arc',          '[]'::jsonb, 'manual', 1, 0.8),
  ('30000008-0000-0000-0000-00000000000c', '20000008-0000-0000-0000-00000000000b', '20000008-0000-0000-0000-00000000000c', 0.8,  'pattern step 1 - same arm, both endpoints have R22.1 as subject',         '[]'::jsonb, 'manual', 1, 0.8),
  ('30000008-0000-0000-0000-00000000000d', '20000008-0000-0000-0000-00000000000c', '20000008-0000-0000-0000-00000000000d', 0.8,  'pattern step 2 - bridges to RAII concept (cause still a root event)',     '[]'::jsonb, 'manual', 1, 0.8),
  ('30000008-0000-0000-0000-00000000000e', '20000008-0000-0000-0000-000000000001', '20000008-0000-0000-0000-00000000000e', 0.8,  'pattern step 3 - bridges to SmartPointer concept (cause is R22.1 root event)', '[]'::jsonb, 'manual', 1, 0.8),
  -- Spare valid edge to round out 15 active edges (R22.10 leaf direct)
  ('30000008-0000-0000-0000-00000000000f', '20000008-0000-0000-0000-00000000000a', '20000008-0000-0000-0000-000000000009', 0.5,  'weak_ptr.lock rationale references the double-free rule directly',        '[]'::jsonb, 'manual', 1, 0.5),
  -- Shortcut edge: R22.1 root event -> R22.4 event. Makes R22.4 a depth-1
  -- effect from the root walk, with 3 alternate causes (edges 05/06/07) →
  -- F2 redundant-child scenario fires here.
  ('30000008-0000-0000-0000-000000000010', '20000008-0000-0000-0000-000000000001', '20000008-0000-0000-0000-000000000004', 0.4,  'R22.1 directly motivates the ownership rule (shortcut for F2 redundant-child scenario)', '[]'::jsonb, 'manual', 1, 0.4);

-- =========================================================================
-- Attach pattern arm to canonical pattern (sets pattern_id + pattern_position)
-- =========================================================================
UPDATE public.causal_edges
SET pattern_id = '40000008-0000-0000-0000-000000000001', pattern_position = 0
WHERE id = '30000008-0000-0000-0000-00000000000b';

UPDATE public.causal_edges
SET pattern_id = '40000008-0000-0000-0000-000000000001', pattern_position = 1
WHERE id = '30000008-0000-0000-0000-00000000000c';

UPDATE public.causal_edges
SET pattern_id = '40000008-0000-0000-0000-000000000001', pattern_position = 0
WHERE id = '30000008-0000-0000-0000-00000000000d';

UPDATE public.causal_edges
SET pattern_id = '40000008-0000-0000-0000-000000000001', pattern_position = 1
WHERE id = '30000008-0000-0000-0000-00000000000e';

-- =========================================================================
-- Edge source refs — citation evidence per the spec's Rule 1 / Rule 1b tests.
--
-- Three spine edges (01..03) cite R22.1 as the SOLE evidence and have
-- corroboration_count = 3 → under hypothetical=expire on R22.1, severity
-- becomes 'critical' (Rule 1).
--
-- Three alt-cause edges (05..07) each have a single source ref to R22.1
-- with corroboration_count = 1 → under hypothetical=expire on R22.1,
-- severity becomes 'high' (Rule 1b).
--
-- Other edges either omit citations or cite distinct entities so they do
-- not interact with hypothetical=expire on R22.1.
-- =========================================================================
INSERT INTO public.edge_source_refs (edge_id, ref_type, ref_id)
VALUES
  -- Well-corroborated sole-evidence (Rule 1)
  ('30000008-0000-0000-0000-000000000001', 'entity', '00000008-0000-0000-0000-000000000001'),
  ('30000008-0000-0000-0000-000000000002', 'entity', '00000008-0000-0000-0000-000000000001'),
  ('30000008-0000-0000-0000-000000000003', 'entity', '00000008-0000-0000-0000-000000000001'),
  -- Low-corroboration sole-evidence (Rule 1b)
  ('30000008-0000-0000-0000-000000000005', 'entity', '00000008-0000-0000-0000-000000000001'),
  ('30000008-0000-0000-0000-000000000006', 'entity', '00000008-0000-0000-0000-000000000001'),
  ('30000008-0000-0000-0000-000000000007', 'entity', '00000008-0000-0000-0000-000000000001'),
  -- Other citations — keep them on different entities so hypothetical on R22.1 doesn't reclassify them
  ('30000008-0000-0000-0000-000000000004', 'entity', '00000008-0000-0000-0000-000000000004'),
  ('30000008-0000-0000-0000-000000000008', 'entity', '00000008-0000-0000-0000-000000000007');

COMMIT;
