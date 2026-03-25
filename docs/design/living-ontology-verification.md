# Living Ontology — Verification Framework

## What We're Verifying

The living ontology system has a three-layer architecture for deciding whether a new predicate or entity type should be merged with an existing one, promoted as genuinely novel, or rejected as noise:

```d2
direction: down

layers: {
  label: "Three-Layer Architecture"
  style.font-size: 20

  L1: "Layer 1: Structural" {
    style.fill: "#e8f5e9"
    label: "Deterministic — zero cost"
    tense: "Tense normalization"
    inverse: "Inverse registry lookup"
    lemma: "Lemmatization"
  }

  L2: "Layer 2: Embedding" {
    style.fill: "#e3f2fd"
    label: "Vector similarity — cheap"
    enrich: "Enriched description embedding"
    compare: "Compare to canonicals"
    threshold: "Two-threshold scoring"
  }

  L3: "Layer 3: LLM Gate" {
    style.fill: "#fff3e0"
    label: "Reasoning — expensive, minimal"
    verify: "Verify ALL merge candidates"
    batch: "Batch review (3-5 per call)"
    decide: "Promote / Merge / Reject / Defer"
  }

  L1 -> L2: "passes through\n(non-inverse, non-tense)"
  L2 -> L3: "merge candidates\n+ review zone"
}
```

Each layer has specific responsibilities. If any layer fails at its job, the downstream layers compensate — but at higher cost. The verification framework proves each layer works independently AND that the layers compose correctly.

## System Overview

```d2
direction: down

input: "Incoming Predicate\n(from extraction)" {
  style.fill: "#f5f5f5"
}

structural: "Layer 1: Structural" {
  style.fill: "#e8f5e9"
  tense_check: "Tense variant?"
  inverse_check: "Known inverse?"
  lemmatize: "Lemmatize + cleanup"

  tense_check -> timestamps: "yes" {style.stroke: "#4caf50"}
  inverse_check -> block: "yes" {style.stroke: "#f44336"}
}

timestamps: "Normalize to base form\n+ set valid_at/invalid_at" {
  style.fill: "#c8e6c9"
}
block: "Block merge\n(registry)" {
  style.fill: "#ffcdd2"
}

embedding: "Layer 2: Embedding" {
  style.fill: "#e3f2fd"
  embed: "Embed enriched description"
  score: "Cosine similarity to canonicals"
  zone: "Threshold zones"
}

auto_merge: "Auto-merge\ncandidate\n(≥ 0.905)" {style.fill: "#bbdefb"}
staging: "Staging\n(< 0.848)" {style.fill: "#e0e0e0"}
review: "LLM review\nzone\n(0.848–0.905)" {style.fill: "#ffe0b2"}

llm: "Layer 3: LLM Gate" {
  style.fill: "#fff3e0"
  verify: "LLM verifies merge"
  decide: "Decision"
}

promote: "Promote\n(novel canonical)" {style.fill: "#c8e6c9"}
merge: "Merge\n(add as alias)" {style.fill: "#bbdefb"}
reject: "Reject\n(noise)" {style.fill: "#ffcdd2"}
defer: "Defer\n(needs more data)" {style.fill: "#e0e0e0"}

input -> structural
structural.lemmatize -> embedding: "continues"
embedding.zone -> auto_merge: "≥ 0.905"
embedding.zone -> staging: "< 0.848"
embedding.zone -> review: "0.848–0.905"
auto_merge -> llm: "ALL merges\nLLM-verified"
review -> llm
llm.decide -> promote
llm.decide -> merge
llm.decide -> reject
llm.decide -> defer
```

The verification must prove that this pipeline:
1. Never merges things that are genuinely different (safety)
2. Reliably identifies things that are the same (completeness)
3. Routes uncertain cases to the right layer (efficiency)
4. Scales without degrading (stability)
5. Works end-to-end with real data (integration)

---

## Verification Gates

Every gate must pass before the system is considered verified. Gates are grouped by layer.

### Layer 1: Structural (Deterministic)

These are binary — they either work or they don't.

| ID | Gate | Description | Metric | Target | Status |
|----|------|-------------|--------|--------|--------|
| S1 | Tense normalization | Tense variants (`worked_at`, `lived_in`) normalize to base form (`works_at`, `lives_in`) and set appropriate `valid_at`/`invalid_at` timestamps | All known tense pairs correctly normalized | 100% | Not tested |
| S2 | Inverse registry blocks merges | Known inverse pairs (`parent_of`↔`child_of`) are never auto-merged, regardless of embedding similarity | 0 false merges on registered inverse pairs | 0 false merges | **Proven (B12)** |
| S3 | Inverse registry coverage | The registry catches a meaningful proportion of the pairs that embeddings would falsely merge | % of inverse pairs that need registry | > 50% | **Proven (67%)** |
| S4 | Lemmatization reduces surface variants | Morphological variants (`mentoring`→`mentor`, `supervised`→`supervise`) collapse to same base form | Lemmatization accuracy on predicate verbs | ≥ 95% | Not tested |

### Layer 2: Embedding (Vector Similarity)

These prove the embedding layer produces reliable signals.

| ID | Gate | Description | Metric | Target | Status |
|----|------|-------------|--------|--------|--------|
| E1 | Enriched >> raw | Enriched description embeddings produce a larger synonym-vs-distinct gap than raw labels | Gap ratio (enriched/raw) | > 2× | **Proven (0.83/0.18 = 4.6×)** |
| E2 | Mean-centering effective | Mean-centering improves separation by reducing anisotropy | Gap improvement after centering | > 50% improvement | **Proven (0.18→0.83)** |
| E3 | HAC clusters match ground truth | HAC with complete linkage produces clusters that align with known canonical groups | F1 on known alias groups | ≥ 0.90 | **Proven (0.95)** |
| E4 | Two thresholds separate cleanly | The auto-merge and auto-distinct thresholds don't overlap | merge_threshold > distinct_threshold | No overlap | **Proven (0.905 > 0.848)** |
| E5 | Novel predicates detected | Genuinely new predicates fall below the merge threshold for all existing canonicals | Novel detection accuracy | 100% | **Proven (5/5)** |
| E6 | Thresholds generalize | Thresholds calibrated on one subset generalize to held-out data | Cross-validated F1 | ≥ 0.90 | **Proven (0.96)** |
| E7 | Thresholds stable at scale | Thresholds don't drift as the ontology grows from 10 to 100 predicates | Max threshold drift | < 0.05 | **Proven (0.01)** |
| E8 | NL phrases map to correct canonical | Natural language predicates from LLM extraction map to the right canonical via nearest-neighbor | Mapping accuracy | ≥ 85% | **Failed (78%)** |
| E9 | Noise auto-rejected | Vague/garbage predicates score below the distinct threshold (auto-rejected without LLM cost) | Auto-reject rate for noise | ≥ 80% | **Failed (56%)** |
| E10 | Noise never auto-merged | No noise predicate scores above the merge threshold | Noise merge leaks | 0 | **Failed (2 leaks)** |

### Layer 3: LLM Verification Gate

These prove the LLM catches what embeddings miss.

| ID | Gate | Description | Metric | Target | Status |
|----|------|-------------|--------|--------|--------|
| L1 | LLM distinguishes subtle semantics | LLM correctly rejects merging predicates that are related but distinct (e.g., `knows` vs `knows_about`) | Rejection accuracy on adversarial pairs | 100% | Not tested |
| L2 | LLM confirms true synonyms | LLM correctly approves merging predicates that are genuine synonyms | Approval accuracy on known alias pairs | ≥ 95% | Not tested |
| L3 | LLM rejects noise | LLM correctly rejects merging noise predicates that leak past the embedding threshold | Rejection accuracy on noise leaks | 100% | Not tested |
| L4 | LLM handles batch review | LLM produces correct decisions when reviewing 3-5 candidates in a single prompt | Batch accuracy vs individual | No degradation | Not tested |
| L5 | LLM decisions are consistent | Same candidate presented twice produces the same decision | Consistency rate across 3 runs | ≥ 90% | Not tested |

### Multi-Signal Scoring

These prove combining signals outperforms any single signal.

| ID | Gate | Description | Metric | Target | Status |
|----|------|-------------|--------|--------|--------|
| M1 | Entity type pairs improve separation | Adding entity type pair overlap as a signal improves adversarial pair discrimination | B7 false merges with multi-signal | 0 | Not tested |
| M2 | Combined score fixes NL mapping | Multi-signal scoring improves NL phrase mapping accuracy beyond embedding alone | B9 accuracy with multi-signal | ≥ 85% | Not tested |
| M3 | WordNet/ConceptNet catches deterministic synonyms | Pre-filter identifies synonyms that embeddings would put in the LLM review zone | Synonyms caught without embedding | > 0 | Not tested |
| M4 | Signal weights are stable | Optimal signal weights don't change drastically across different data samples | Weight stability across folds | Std < 0.10 per weight | Not tested |

### End-to-End Integration

These prove the full pipeline works with real data.

| ID | Gate | Description | Metric | Target | Status |
|----|------|-------------|--------|--------|--------|
| I1 | Real extraction → correct mapping | Predicates extracted by the LLM from real text are correctly mapped to canonicals or correctly staged as novel | End-to-end mapping accuracy | ≥ 80% | **Partially proven (3/3 but tiny sample)** |
| I2 | Staging accumulates correctly | Multiple extractions of the same non-canonical predicate correctly increment the staging counter | Counter accuracy | 100% | Not tested (no staging infra yet) |
| I3 | Evolution agent produces correct decisions | Full pipeline (staging → clustering → scoring → LLM) produces correct promote/merge/reject on a synthetic dataset | Decision accuracy on synthetic stream | ≥ 90% | Not tested (no agent yet) |
| I4 | Promoted predicates are used by extraction | After a predicate is promoted, the next extraction run uses it (dynamic ontology loading works) | Extraction uses new predicates | 100% | Not tested (no dynamic loading yet) |
| I5 | Ontology converges | Given a bounded data stream, the ontology stops growing and promotion rate drops to near zero | Promotion rate after N messages | Trending to 0 | Not tested (needs simulation) |
| I6 | Entity type reclassification is accurate | When a new entity type is promoted, existing entities are correctly reclassified via centroid + LLM verify | Reclassification accuracy | ≥ 90% | Not tested (no entity type data) |

---

## Summary

| Layer | Total Gates | Proven | Failed | Not Tested |
|-------|-------------|--------|--------|------------|
| Structural (S1-S4) | 4 | 2 | 0 | 2 |
| Embedding (E1-E10) | 10 | 7 | 3 | 0 |
| LLM Gate (L1-L5) | 5 | 0 | 0 | 5 |
| Multi-Signal (M1-M4) | 4 | 0 | 0 | 4 |
| Integration (I1-I6) | 6 | 0 | 0 | 5 (1 partial) |
| **Total** | **29** | **9** | **3** | **16** (+ 1 partial) |

### Blocking Failures

These 3 failures must be resolved before the design is considered validated:

| Gate | Current | Root Cause | Resolution Path |
|------|---------|-----------|-----------------|
| E8 (NL mapping 78%) | 78% | Embedding quality for ambiguous phrases. "is based out of" → `created` instead of `lives_in` | Multi-signal scoring (M2) may fix. If not, enrichment strategy needs rethinking. |
| E9 (Noise reject 56%) | 56% | Many noise predicates land in LLM review zone instead of auto-reject | Acceptable IF L3 proves LLM catches them. Otherwise threshold tuning needed. |
| E10 (Noise leaks 2) | 2 leaks | `sort_of_works_at` and `basically_knows` are noisy near-duplicates | LLM gate (L3) must catch these. Morphological prefix stripping could also help. |

### Critical Untested Path

The **LLM verification gates (L1-L5)** are entirely untested. The design routes all merge decisions through the LLM as the safety net. If the LLM fails to distinguish `knows` from `knows_about`, or approves merging noise predicates, the entire architecture fails. This is the highest-priority testing gap.

### Recommended Testing Order

1. **L1-L3** — LLM gate correctness (blocks everything else)
2. **M1-M2** — Multi-signal scoring (may resolve E8, E9, E10)
3. **S1, S4** — Tense normalization and lemmatization
4. **L4-L5** — LLM batch and consistency
5. **M3-M4** — WordNet/ConceptNet and weight stability
6. **I1-I6** — Integration (requires infrastructure)

---

## Proven Findings (for reference)

| Finding | Evidence |
|---------|---------|
| Enriched embeddings are 4.6× better than raw | B1: gap 0.83 vs 0.18 |
| HAC with complete linkage is the right clustering algorithm | B2: F1=0.95, CESI research |
| Two-threshold system provides clean separation | B3: zones don't overlap |
| Tense pairs should merge (not separate predicates) | B7 rerun: F1 improved 0.87→0.95 |
| Inverse registry is structurally necessary | B12: 67% of pairs need it |
| Embeddings cannot distinguish directionality | Ad-hoc: role encoding made it worse |
| Thresholds generalize and are scale-stable | B10: F1=0.96, B11: drift=0.01 |
| String similarity alone is useless for semantic synonyms | B5: gap=0.075 |

---

*Created: 2026-03-25*
*Status: 9/29 gates proven, 3 blocking failures, 16 untested*
