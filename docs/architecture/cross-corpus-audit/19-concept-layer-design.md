# Doc 19 — The emergent-concept layer: design

**Status:** DESIGN (2026-07-20). Turns doc 18's four-bullet direction into a build spec.
Concludes nothing empirical — it specifies the symbolic recall path doc 18 chose over the
fuzzy one. The validation gate (does the JOIN beat the cosine baseline?) is owed and deferred,
see §7.

Reading order: doc 18 (the decision this builds), doc 04 §3 (D1/D9 substrate), then here.

## 1. What doc 18 decided, restated as a build

The fuzzy layer (embedding + LLM adjudicator) never robustly beat a lexical baseline across
docs 10–17. Decision: **lean symbolic**. Concepts become first-class nodes; an element
*exhibits* a concept via a typed edge; cross-corpus recall is a **symbolic JOIN over shared
concept nodes**, not a cosine gamble. Embedding is demoted to a merge-time helper; the LLM is
scoped to concept extraction + equivalence tie-breaking, not autonomous violation judgment.

This doc specifies the four moving parts: the **concept node**, the **exhibits/addresses
edge**, the **JOIN recall**, and **concept merge**.

## 2. Substrate findings (most of the plumbing already exists)

Confirmed by reading the shipped Phase A code, not memory:

- **Elements are bare catalog rows, never entities** — `code_elements` / `rule_elements`
  (mig 053), keyed by `element_ref = uuidV5(...)`. Zero fusion surface by construction (D1).
- **`bridge_edges` is already polymorphic and already knows about entities.** `bridge-promotion.ts`
  defines `ElementKind = 'code_element' | 'rule_element' | 'entity'`, and `catalogHas(ref,
  'entity')` already validates an endpoint against the `entities` table. **But** the DB CHECK
  in mig 054 (`valid_bridge_kinds`) still only allows `code_element`/`rule_element`. So pointing
  a bridge at an entity is wired in TypeScript and blocked at the DB — the enabling migration
  just closes that gap.
- **Corpus scoping (mig 052) forbids facts from crossing corpora** — a composite FK
  `facts(subject/object_entity_id, corpus_id) → entities(id, corpus_id)` pins a fact's endpoints
  into its own corpus, and `corpus_id` is immutable per row. This is *why* cross-corpus links
  must be bridges, not facts. `merge_candidates` is likewise same-corpus only.
- **`entity_type='concept'` already exists** — seeded canonical in `entity_types` (mig 001
  line 40). `entity_type` is a free varchar validated against that catalog (mig 046 note), so
  no schema change is needed for the concept type at all.
- **Recall today = pure cosine kNN** — `recallAcrossCorpus` runs `element_embeddings <=> query`
  filtered by target corpus/kind. This is the weak "cosine gamble" the JOIN replaces as the
  load-bearing path.

Net: the concept layer is mostly *enabling* existing machinery, not building new machinery.

## 3. The model

### 3.1 Concept node — an entity in a reserved shared corpus

A concept is a named, described node: `heap-allocation`, `ownership-transfer`,
`lock-discipline`. It is an ordinary `entities` row with `entity_type = 'concept'`, carrying
`canonical_name` + `description`.

All concepts live in **one reserved corpus, `_concepts`**. This is the key move: because every
concept shares a single corpus, the same-corpus `merge_candidates` FK and `mergeEntities` path
work on concepts *natively* — no exemption from the four Phase A fusion guards is needed (they
guard *cross*-corpus fusion, which never happens inside `_concepts`). Concepts are shared
vocabulary, adjacent to the "ontology stays global" stance mig 052 already takes for
`entity_types` / `fact_predicates`.

### 3.2 exhibits / addresses — the typed edges (bridge_edges)

- A `code_element` **exhibits** a concept: it does the thing (calls `new[]`, holds a raw owner).
- A `rule_element` **addresses** a concept: it governs the thing.

Both are `bridge_edges` rows (not facts — facts can't cross corpora):
`a_kind='code_element'|'rule_element'`, `a_ref=element_ref`, `b_kind='entity'`,
`b_ref=concept_entity_id`, `source_corpus_id`=the element's corpus, `target_corpus_id='_concepts'`,
`relation ∈ {'exhibits','addresses'}`. `reasoning` + `source_references` stay **NON-NEGOTIABLE**
(the mig 054 CHECKs already enforce this) — every exhibits edge carries why + the element/line it
came from. Written through the existing staging → `applyBridgePromotion` → corroborate-or-insert
path.

### 3.3 Recall = a symbolic JOIN, not cosine

To find rules a code element might violate, walk the shared concept:

```
code_element --exhibits--> concept <--addresses-- rule_element
```

```sql
SELECT DISTINCT be_rule.a_ref AS rule_element_ref, count(*) AS shared_concepts
FROM bridge_edges be_code
JOIN bridge_edges be_rule ON be_rule.b_ref = be_code.b_ref      -- shared concept node
WHERE be_code.a_ref = :codeElementRef
  AND be_code.relation = 'exhibits'  AND be_code.expired_at IS NULL
  AND be_rule.relation = 'addresses' AND be_rule.expired_at IS NULL
  AND be_rule.a_kind = 'rule_element'
GROUP BY be_rule.a_ref
ORDER BY shared_concepts DESC;
```

This is the candidate-generation that feeds the stage-2 adjudicator, replacing the cosine kNN.
The cosine path is not deleted — it stays as a fallback/helper (§3.5).

### 3.4 Concept extraction — the ingest pass

During element ingest (alongside `element-authoring`), a Haiku pass labels the element with the
concepts it exhibits/addresses: code snippet → `['heap-allocation','raw-pointer-ownership']`;
rule text → `['heap-allocation']`. Per the Haiku-first rule, this is a Haiku job; it can share
the authoring call (author description + emit concept labels in one turn). Each label is then
**resolved** (§3.5) into `_concepts` and an exhibits/addresses bridge is staged with reasoning +
the source element ref.

### 3.5 Concept merge / resolution — mergeEntities reused

Two ingests will produce `heap-allocation` and `dynamic memory allocation`. If they don't
resolve to one node, the JOIN won't connect. Resolution:

1. **Candidate discovery (helper):** embedding/lexical kNN over existing `_concepts` names +
   descriptions to find likely-same concepts. Embedding is a *helper* here, exactly its demoted
   role — a wrong candidate is caught by step 2, never silently merged.
2. **Equivalence tie-breaker (LLM):** on genuinely-confusable pairs only, a Haiku call decides
   same-concept vs distinct. This is the scoped adjudicator job doc 18 licensed.
3. **Merge:** `mergeEntities` (the nmemo-9vk fix — dedup before re-point) collapses the losing
   concept into the winner; exhibits/addresses bridges re-point to the survivor. This is the
   gardener's job applied to concept nodes.

## 4. Decisions

| id | decision | rationale |
|----|----------|-----------|
| **D-C1** | Concepts = `entities` with `entity_type='concept'`. | User-agreed fork (doc-18 "concept resolution IS entity resolution"); reuses mergeEntities/gardener wholesale. |
| **D-C2** | All concepts live in one reserved corpus `_concepts`. | Makes concept merge native under the same-corpus guards — no fusion-guard surgery. Concepts are shared vocabulary. |
| **D-C3** | exhibits/addresses = `bridge_edges` (`b_kind='entity'`), not facts. | Facts can't cross corpora (mig 052 composite FK); bridges are the cross-corpus edge and already accept `entity`. |
| **D-C4** | Two relations: `exhibits` (code→concept), `addresses` (rule→concept). | Legible JOIN; a_kind alone would work but the label makes direction explicit. Small vocab add to the CHECK. |
| **D-C5** | reasoning + source_references stay non-negotiable on exhibits edges. | Consistent with the whole architecture; already CHECK-enforced. |
| **D-C6** | Concept extraction is a Haiku pass, may share the authoring call. | Haiku-first; authoring already runs per element. |
| **D-C7** | JOIN recall augments, does not delete, cosine `recallAcrossCorpus`. | Cosine stays a fallback/candidate-discovery helper (D18 demotion, not removal). |

Open for sign-off before coding: **D-C2** (reserved `_concepts` corpus vs some other shared-namespace
mechanism) and **D-C4** (two relations vs one). Everything else follows from the doc-18 decision.

## 5. Non-goals

- No autonomous violation judgment. The JOIN generates candidates; adjudication stays a separate,
  human-in-the-loop-scoped step (E1 terminal disposition).
- No embedding as load-bearing recall. It is a merge-time helper only.
- No new merge machinery. Concept resolution rides `mergeEntities` as-is.
- No AGE sync for bridges (D2 unchanged); the JOIN is a Postgres query over `bridge_edges`.

## 6. Build breakdown (beads to file)

1. **Schema** — `entity_type='concept'` already seeded (mig 001), no change. Widen
   `bridge_edges.valid_bridge_kinds` to include `entity`; widen `valid_bridge_relation` +
   `valid_staging_bridge_relation` to include `exhibits`,`addresses` (staging has no kinds CHECK,
   so nothing to widen there). Register `_concepts` in `corpus_policies` (mode `assimilating` —
   we *want* concepts to fuse). Closes the TS-vs-DB `entity`-kind gap.
2. **Concept extraction service** — Haiku pass → concept labels per element; resolve into
   `_concepts`; stage exhibits/addresses bridges with reasoning + source refs.
3. **Concept resolution** — candidate discovery (embedding/lexical helper) + LLM equivalence
   tie-breaker + `mergeEntities`. Gardener-invocable.
4. **JOIN recall** — `recallByConcept(codeElementRef)` per §3.3; wire as candidate generation
   into the audit pass ahead of the adjudicator.
5. **Acceptance + pre-registered gate (§7)** — e2e concept round-trip test, then the recall
   comparison, pre-registered with a blind adversary per doc-14 discipline.

## 7. What is owed (deferred, not abandoned)

- **The validation gate:** does symbolic-JOIN recall beat the cosine-kNN baseline (and a lexical
  baseline) on a leak-controlled corpus? This is a *symbolic-path* measurement, so it is not the
  fuzzy-layer floor doc-18 told us to stop running — but it must be pre-registered with a bar and
  a blind adversary before any capability claim, per the discipline trail.
- **Field prevalence:** every prior number is a constructed floor; adoption still needs a
  real-code field-prevalence run (the standing owed item since the E1 arc).
- **Extraction quality:** concept extraction (labelling raw artifacts) is the still-untested,
  most-natural LLM job (doc-18). Its recall/precision is unmeasured and part of the gate.
