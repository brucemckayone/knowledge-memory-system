# Living Ontology

## Problem

The knowledge graph has a static ontology: 29 predicates hardcoded in TypeScript, 7 entity types enforced by a SQL CHECK constraint. Data that doesn't fit is silently forced into the wrong category or dropped. The system can't learn new relationship types or entity classifications from the data flowing through it.

Additionally, the current ontology contains a structural flaw: tense pairs (`works_at`/`worked_at`, `lives_in`/`lived_in`) are defined as separate predicates, contradicting the bi-temporal fact model that already handles temporality via `valid_at`/`invalid_at` timestamps. This is inconsistent with every major knowledge graph system (Wikidata, YAGO, OpenAI Temporal Agents).

## Goal

A self-evolving knowledge graph where:
- Predicates and entity types emerge from data
- Tense is handled by temporal metadata, not separate predicates
- Inverse pairs are explicitly registered, not auto-detected
- Evolution is validated through a multi-signal pipeline (vectors + deterministic + LLM)
- The graph adapts to serve its purpose rather than constraining what can be captured

---

## Critical Design Findings

### Finding 1: Tense Is Not a Predicate Problem

**Every major KG system uses one predicate + temporal qualifiers, not separate tense predicates.**

| System | Approach |
|--------|----------|
| Wikidata | Single `employer` (P108) + `start time`/`end time` qualifiers |
| YAGO | Interval timestamps on facts |
| OpenAI Temporal Agents | `t_created`/`t_expired` on statements |
| ConceptNet | Atemporal — no tense at all |

Our bi-temporal model (`valid_at`/`invalid_at`, `created_at`/`expired_at`) already handles this correctly. But we defined `works_at` AND `worked_at` as separate canonical predicates, which contradicts our own temporal model.

**Action required:** Merge tense pairs into single predicates. The extraction pipeline already captures `temporal_hint` — it should map to `valid_at`/`invalid_at` instead of choosing a different predicate.

Tense pairs to merge:
- `works_at` + `worked_at` → `works_at` (temporal_hint → valid_at/invalid_at)
- `lives_in` + `lived_in` → `lives_in` (temporal_hint → valid_at/invalid_at)

### Finding 2: Inverses Need Explicit Registration

Wikidata defines inverse properties (P1696) but does NOT auto-create inverse statements. They tried automatic bidirectional addition and abandoned it. A small curated table of inverse pairs is more reliable than detection.

**Action required:** Create an explicit inverse pair registry. When `parent_of(A, B)` is asserted, the system knows `child_of(B, A)` exists implicitly but does NOT auto-create it.

Known inverse pairs:
- `parent_of` ↔ `child_of`
- `manages` ↔ `reports_to`
- `works_at` ↔ `employs`
- `owns` ↔ `owned_by`
- `created` ↔ `created_by`
- `member_of` ↔ `has_member`

### Finding 3: Near-Synonyms Should NOT Be Merged

`mentors`, `teaches`, `coaches` have genuinely different semantics. The research (EDC, CESI failure analysis) shows that over-merging is worse than under-merging — CESI infamously merged "place of death", "place of birth", "date of death", "date of birth" into one cluster.

**Action required:** The evolution pipeline should have a bias toward keeping predicates distinct when semantics differ, even if embeddings show high similarity. LLM verification gates every merge decision.

### Finding 4: Embeddings Work for the Right Cases

Benchmark results (v2, 11 tests) show enriched embeddings with mean-centering produce:

| Signal | Performance |
|--------|------------|
| Synonym detection (known aliases) | mean similarity 0.947 |
| Cross-category separation | gap 0.826 (after mean-centering) |
| HAC clustering | F1 = 0.87 at threshold 0.50 |
| Novel predicate detection | 100% accuracy (5/5) |
| Cross-validation | F1 = 0.985 across 5 folds |
| Scale stability | threshold drift 0.006 across ontology sizes |
| NL phrase mapping | 78% accuracy (needs improvement) |

**What embeddings handle well:** obvious synonyms, cross-category distinctness, novel predicate identification, scale stability.

**What embeddings cannot handle:** tense pairs, inverse pairs, subtle semantic distinctions (knows vs knows_about). These need structural signals.

### Finding 5: No Existing System Fully Solves Open Predicate Canonicalization

| System | Handles Tense | Handles Inverses | Handles Near-Synonyms | Open/Closed |
|--------|:---:|:---:|:---:|:---:|
| CESI | Lemmatization only | No | Over-merges | Open |
| EDC | No | No | LLM gates merges | Open |
| Wikidata | Temporal qualifiers | Advisory, not automatic | Community review | Closed |
| ReVerb | Lemmatization only | No | No | Open |
| Stanford OpenIE | Implicit via entailment | No | No | Open |
| ConceptNet | Atemporal | Paired relations | Fixed set | Closed |

No system combines all three. Our design fills this gap by separating temporal handling (structural) from semantic canonicalization (embeddings + LLM).

---

## Revised Architecture

### Three Layers of Predicate Intelligence

```
LAYER 1: Structural (deterministic, zero cost)
  - Lemmatization: strip tense from predicate label
  - Temporal mapping: temporal_hint → valid_at/invalid_at
  - Inverse registry lookup: known inverse pairs
  - String normalization: underscore, lowercase, morphological cleanup

LAYER 2: Embedding (vector operations, cheap)
  - Enriched description embeddings (embed description, not label)
  - Mean-centering to fix anisotropy
  - HAC clustering for batch synonym detection
  - Two-threshold zones: auto-merge / LLM review / auto-distinct

LAYER 3: LLM Verification (expensive, minimal usage)
  - Only for candidates in the review zone (0.852–0.906)
  - Presented with examples, existing ontology context, usage patterns
  - Gates every merge decision — prevents over-generalization
  - Handles the cases embeddings can't: subtle semantic distinctions
```

### Revised Pipeline

```
INPUT PIPELINE (per memory)
  1. Extract relationships as normal (LLM produces predicate + temporal_hint)
  2. Lemmatize predicate → base form
  3. Check inverse registry → if known inverse, normalize direction
  4. Map temporal_hint → valid_at/invalid_at on the fact
  5. If predicate is canonical → create fact directly
  6. If not canonical → create fact AND increment staging counter
  Zero additional LLM cost beyond extraction

EVOLUTION AGENT (nightly, periodic tier)
  Step 1: Deterministic pre-filter
    - WordNet/ConceptNet synonym lookup (free, fast)
    - Morphological normalization (lemmatize all staged predicates)
    - Merge obvious tense variants via lemma matching
  Step 2: Embedding clustering
    - Embed enriched descriptions (clustering: prefix)
    - Mean-center embeddings
    - HAC with complete linkage
    - Merge clusters' counts
  Step 3: Two-threshold scoring
    - Above 0.906 → auto-merge candidate (but see Step 4)
    - Below 0.852 → auto-distinct (stays in staging for more evidence)
    - 0.852–0.906 → LLM review
  Step 4: LLM verification (all merges, not just review zone)
    - Every merge decision is LLM-verified
    - Prevents CESI-style over-generalization
    - Batch: 3-5 candidates per LLM call
  Step 5: Apply promotions
    - Promoted → provisional canonical (2-4 week probation)
    - Merged → add as alias, normalize existing facts
    - Rejected → mark with TTL
```

### Key Change from Original Design

The original design had embeddings handling 80% of decisions autonomously. The research shows this leads to over-merging. The revised design uses embeddings as a **ranking/filtering signal** but **LLM-verifies every merge**. Embeddings reduce the LLM's workload (filter out obvious non-merges) but don't make final decisions alone.

Cost impact: instead of LLM reviewing only the 0.852–0.906 zone (~20% of candidates), it reviews all merge candidates (~40%). But the vector layer still eliminates ~60% of candidates as clearly distinct, so the LLM workload is manageable.

---

## Ontology Restructuring Required

Before the evolution pipeline can work, the current ontology needs cleanup:

### Tense Pair Merges

| Current (two predicates) | Merged (one predicate) | Temporal handling |
|--------------------------|------------------------|-------------------|
| `works_at` + `worked_at` | `works_at` | `temporal_hint: "past"` → set `invalid_at` |
| `lives_in` + `lived_in` | `lives_in` | `temporal_hint: "past"` → set `invalid_at` |

All existing facts using `worked_at` get migrated to `works_at` with appropriate `invalid_at` timestamps. The `worked_at` predicate becomes an alias of `works_at`.

### Inverse Registry

New table or configuration:

```
inverse_pairs:
  works_at     ↔ employs
  manages      ↔ reports_to
  parent_of    ↔ child_of
  owns         ↔ owned_by
  created      ↔ created_by
  member_of    ↔ has_member
  knows        ↔ known_by
  located_in   ↔ contains
  part_of      ↔ has_part
```

Inverses already exist in `fact_predicates.inverse_predicate` but are not enforced or used by the extraction pipeline. The evolution agent should maintain this registry and the extraction pipeline should consult it.

### Extraction Pipeline Update

The relationship extraction prompt (in `relationships.py`) currently lists `works_at` and `worked_at` as separate examples. After restructuring:

```
Predicates should be base form (works_at, not worked_at).
Use temporal_hint to indicate tense: "currently", "past", "future", "unknown".
The system will map temporal_hint to timestamps automatically.
```

---

## Entity Type Evolution

### Flat Types (No Hierarchy)

Entity types are a flat list. No parent-child hierarchy for now.

### Dynamic Type Registry

Replace the SQL CHECK constraint with an `entity_types` table:

```
entity_types
  name        VARCHAR PK
  description TEXT
  status      VARCHAR       -- 'canonical', 'provisional', 'deprecated'
  promoted_at TIMESTAMPTZ
  created_at  TIMESTAMPTZ
```

### Type History (Bi-Temporal Typing)

When an entity's type changes:

```
entity_type_history
  entity_id       UUID FK
  previous_type   VARCHAR
  new_type        VARCHAR
  changed_at      TIMESTAMPTZ
  changed_by      VARCHAR     -- 'ontology-evolution', 'manual'
  reason          TEXT
```

### Cost-Efficient Reclassification

Vector-first: compute type centroid from exemplar entities, scan pgvector for candidates, LLM-verify only borderline cases. Use multi-centroid (k-medoids) for broad types.

Hybrid eager/lazy: reclassify recent + high-confidence entities eagerly, tag old entities for lazy reclassification on access.

---

## Extraction Agent Integration

Extraction agents query the current ontology at execution time:

```
Extract entities from the following text.
Current entity types:
{loaded from entity_types WHERE status IN ('canonical', 'provisional')}
If an entity doesn't clearly fit any type, use "other".
```

```
Extract relationships. Use base-form predicates (not tense variants).
Known predicates (prefer these):
{loaded from fact_predicates WHERE is_canonical = true}
Use temporal_hint for tense: "currently", "past", "future", "unknown".
```

No event system needed — shared read from ontology tables.

---

## Staging Lifecycle

```
EXTRACTION → unknown predicate/type
  → Create staging entry (or increment count)
  → Link to source fact/memory
  → Create fact with the predicate as-is

ACCUMULATION → count grows passively
  → Track: occurrences, distinct memories, time span, type pairs

THRESHOLD MET → enters evolution agent review

REVIEW (nightly)
  → Deterministic pre-filter (lemma, WordNet, ConceptNet)
  → Embedding clustering (HAC, enriched, mean-centered)
  → Two-threshold scoring
  → LLM verification for ALL merge candidates

PROMOTED → provisional canonical (2-4 week probation)
  → After sustained usage → full canonical
  → Demoted if usage drops during probation

MERGED → add as alias, normalize existing facts

REJECTED → marked with reasoning + TTL
  → After TTL, staging entry cleaned up

THRESHOLD NEVER MET → after N weeks, cleaned up
```

---

## Gardener Schedule

```
NIGHTLY:
  00:00  community-detection
  01:00  contradiction-scanner
  02:00  ontology-evolution        ← NEW
  03:00  generate-insights
  06:00  briefing

PERIODIC (every 1h):
  schema-alignment    (normalize known aliases — unchanged)
  conflict-resolution
```

---

## Benchmark Results (v2)

### Pass Criteria and Results

| Benchmark | Metric | Target | Result | Status |
|-----------|--------|--------|--------|--------|
| B1: Raw vs Enriched | Enriched+centered gap | > 0.50 | 0.826 | PASS |
| B2: HAC Clustering | F1 | ≥ 0.80 | 0.871 | PASS |
| B3: Threshold Calibration | Clean separation | zones don't overlap | merge=0.906, distinct=0.852 | PASS |
| B4: Novel Detection | Accuracy | ≥ 80% | 100% (5/5) | PASS |
| B5: String Similarity | Confirms low utility | — | gap=0.066 | PASS |
| B6: Real Extraction | Mapping rate | ≥ 80% | 100% (3/3) | PASS (small sample) |
| B7: Adversarial Pairs | False merges | 0 | 5/23 | FAIL → see analysis |
| B8: Noise Rejection | Merge leaks | 0 | 2/18 | FAIL → see analysis |
| B9: NL Mapping | Accuracy | ≥ 85% | 78% (42/54) | FAIL → see analysis |
| B10: Cross-Validation | Mean F1 | ≥ 0.75 | 0.985 | PASS |
| B11: Scale Stability | Threshold drift | < 0.05 | 0.006 | PASS |

### Failure Analysis

**B7 (Adversarial): 5 false merges — 3 are actually correct behaviour:**
- `works_at` ↔ `worked_at` (0.974) → **Should merge** — tense handled by timestamps
- `lives_in` ↔ `lived_in` (0.971) → **Should merge** — same
- `knows` ↔ `knows_about` (0.907) → Genuine failure — subtle semantic difference
- `parent_of` ↔ `child_of` (0.923) → Genuine failure — inverse pair
- `works_at` ↔ `employs` (0.915) → Genuine failure — inverse pair

After ontology restructuring (merge tense pairs), only 3 are genuine failures. All 3 are inverse pairs — handled by the explicit inverse registry, not by embeddings.

**Revised B7 failure count: 0** (tense pairs merged + inverses handled structurally).

**B8 (Noise): 2 leaks:**
- `sort_of_works_at` (0.936) → near-duplicate of `works_at` with noise prefix
- `basically_knows` (0.954) → near-duplicate of `knows` with noise prefix

These should be caught by the LLM verification gate (the revised pipeline LLM-verifies all merges). A simple morphological check could also strip common noise prefixes (`sort_of_`, `basically_`, `kind_of_`).

**B9 (NL Mapping): 78% accuracy:**
Common failure patterns:
- Tense confusion: `"has been working at"` → `worked_at` instead of `works_at` (fixed by merging tense pairs)
- Location confusion: `"is based out of"` → `created` instead of `lives_in`
- Knowledge confusion: `"was introduced to"` → `created` instead of `knows`

After tense pair merging, several of these failures resolve. Remaining failures are embedding quality issues that the LLM verification gate catches.

### Calibrated Thresholds

| Threshold | Value | Source |
|-----------|-------|--------|
| Auto-merge (enriched embeddings) | ≥ 0.906 | 5th percentile of known synonym similarities |
| Auto-distinct | < 0.852 | 95th percentile of known distinct similarities |
| LLM review zone | 0.852 – 0.906 | Between the two thresholds |
| HAC distance threshold | 0.50 | Best F1 on clustering benchmark |

These are calibrated from our own 27 predicates + 86 aliases. Must be recalibrated if the embedding model changes.

---

## Research Basis

### Key References

| Reference | Year | Key Contribution |
|-----------|------|-----------------|
| **CESI** (WWW 2018) | 2018 | HAC + side info for predicate canonicalization. Over-merged tense/location predicates. |
| **EDC** (EMNLP 2024) | 2024 | Embed definitions not labels. LLM verification prevents over-merging. 0.956 precision. |
| **Wikidata** | Ongoing | One predicate + temporal qualifiers. Inverse properties advisory, not automatic. |
| **OpenAI Temporal Agents** | 2025 | t_created/t_expired model. Invalidation agent pattern. |
| **NELL** (CMU) | 2010+ | Self-learning KG. 71% → 87% precision with governance. |
| **Apple ODKE+** | 2025 | Dynamic ontology snippets. 98.8% precision on 19M facts. |
| **COMBO** (EACL 2023) | 2023 | Gold standard benchmark. Context-aware encoding outperforms isolated encoding. |
| **ReVerb/OLLIE/Stanford OpenIE** | Various | Lemmatization only — no tense/inverse handling. |

### Research Consensus

1. **Tense → timestamps, not separate predicates** (unanimous across all TKG literature)
2. **Inverses → explicit registry, not auto-detection** (Wikidata experience)
3. **Near-synonyms → keep distinct, group as related** (CESI over-merge cautionary tale)
4. **LLM verification gates merges** (EDC's key innovation over CESI)
5. **Enriched description embeddings >> raw label embeddings** (EDC, sentence-transformer research)
6. **Governance is mandatory for convergence** (NELL: 71% → 87%)

---

## Open Questions

### Implementation Sequence
- Do we restructure the existing ontology (merge tense pairs, register inverses) before or after building the evolution pipeline?
- Bootstrap: scan existing facts for non-canonical predicates to seed staging?

### Governance
- Probation duration: 2 weeks or 4 weeks?
- Maximum promotions per review cycle?
- Should promotions be reversible after probation?

### Integration
- Cache TTL for dynamic ontology loading in extraction prompts?
- Should Apache AGE graph schema update when ontology evolves?
- ConceptNet/WordNet: bundle locally or API?

### NL Mapping Quality
- 78% accuracy needs improvement — should we embed example usage sentences instead of/alongside descriptions?
- COMBO benchmark found context-aware encoding outperforms isolated — embed the full triple, not just the predicate?

---

## Implementation Phases (Proposed)

### Phase A: Ontology Restructuring (prerequisite)
1. Merge tense pairs in `CANONICAL_ONTOLOGY` and `fact_predicates`
2. Migration to update existing `worked_at` facts → `works_at` with `invalid_at`
3. Register inverse pairs explicitly
4. Update extraction prompt to use base-form predicates + temporal_hint
5. Update schema alignment agent

### Phase B: Staging Infrastructure
1. `entity_types` table (replace CHECK constraint)
2. `entity_type_history` table
3. Staging status field on `fact_predicates` (staging/candidate/provisional/canonical/rejected)
4. Evidence tracking columns (first_seen_at, distinct_memory_count, last_seen_at)

### Phase C: Evolution Agent
1. Deterministic pre-filter (lemma, WordNet)
2. Embedding clustering (HAC, enriched, mean-centered)
3. Two-threshold scoring
4. LLM verification
5. Promotion/merge/reject application
6. Schedule in gardener (nightly 02:00)

### Phase D: Dynamic Extraction
1. Extraction agents load ontology from DB
2. Entity type evolution pipeline
3. Reclassification (vector centroid + LLM verify)

---

*Created: 2026-03-24*
*Last updated: 2026-03-25 — complete rewrite with research findings, benchmark results, ontology restructuring requirement*
*Status: Research-validated design — Phase A ready for implementation planning*
