# Graph S Hardening — Fixing the Foundation

**Status:** Immediate priority
**Prerequisite for:** Graph C (Perpendicular Causal Graph)
**Reference:** [Truth Graph Findings](../../handoff/truth-graph-findings.md) — 10-chunk Frankenstein test, 2026-03-31

---

## 1. Why These Fixes Matter Beyond Graph S

Graph C — the perpendicular causal graph — indexes **state transitions** in Graph S. A causal edge connects two events: "the strengthening of the Anxiety→Work edge in Graph S was caused by the Boss→Criticism edge appearing three days earlier."

This means Graph C's reliability is bounded by Graph S's reliability:

```d2
direction: right

broken_s: "Graph S (broken)" {
  style.fill: "#f8d7da"
  style.opacity: 0.4
  margaret_1: "Margaret (id: a1)"
  margaret_2: "Margaret (id: a2)"
  margaret_3: "Margaret (id: a3)"
  narrator: "narrator (unlinked)"
  courage: "dauntless courage"
  note: "Duplicates, orphans, noise"
}

broken_c: "Graph C (built on broken S)" {
  style.fill: "#f8d7da"
  style.opacity: 0.4
  e1: "event → Margaret a1"
  e2: "event → Margaret a2"
  e3: "event → narrator ???"
  e1 -> e2: "causal chain\nfragmented" {style.stroke-dash: 3}
  note: "Chains split across\nduplicate IDs.\n48% of relationships\nnever created."
}

clean_s: "Graph S (fixed)" {
  style.fill: "#d4edda"
  style.opacity: 0.4
  margaret: "Margaret (canonical)"
  walton: "R. Walton"
  note: "Deduplicated, complete, clean"
}

clean_c: "Graph C (built on clean S)" {
  style.fill: "#d4edda"
  style.opacity: 0.4
  e1: "event → Margaret"
  e2: "event → R. Walton"
  e1 -> e2: "clean causal chain\nfull traceability"
}

broken_s -> broken_c: "garbage in"
clean_s -> clean_c: "clean in"
```

| Graph S Problem | Graph C Consequence |
|-----------------|---------------------|
| Duplicate entities | Causal chains fragment across duplicate IDs — the same real-world cause gets split into separate causal nodes |
| Lost relationships (48%) | Missing edges = missing causal inputs. Half the potential causal links never get created |
| Vague entities | Causal attribution to "a lady" or "dauntless courage" is meaningless — noise in the causal graph |
| Duplicate facts | Same state transition recorded twice = duplicate causal events |
| Static ontology | Causal extraction needs a stable, converging vocabulary of relationship types |

**Principle:** Fix Graph S to the point where every entity is canonical, every extractable relationship lands, and the ontology self-corrects — then Graph C has a clean substrate to build on.

**Infrastructure note:** Qdrant is retained in the sparse branch (not stripped as initially planned). The causal agent (Phase B) needs access to raw source texts via semantic search in Qdrant — pgvector on entities/facts is not sufficient because the agent needs to query the original inputs, not just the extracted graph. The `store()` function in `pipeline.ts` embeds text and stores it in Qdrant before extraction runs.

---

## 2. Fix 1: Close the Entity Resolution Loop

### The Bug

`linkEntitiesToMemory()` in `platform/src/services/entities.ts:338-358` calls `resolveEntity()` for each extracted entity. The resolution pipeline itself is well-designed — three-stage with embedding blocking, trigram fallback, and defined thresholds (>0.92 auto-merge, 0.75-0.92 medium confidence, <0.75 create new).

**But the pipeline has three execution bugs:**

**Bug 1a — Context not utilised effectively.** The `context` parameter defaults to empty string (`context = ''` at line 348). The entity extraction agent *does* pass `payload.content` (line 41 of `entity-extraction.agent.ts`), so context reaches `resolveEntity()`. However, the combined text for embedding generation is `mention + context.slice(0, 200)` — for short mentions like "Margaret", the 200-char context window may not capture enough disambiguating signal. The context window should be centred on the mention position, not taken from the start of the document.

**Bug 1b — No concurrency protection.** When multiple chunks mention the same new entity concurrently, parallel workers both call `createEntity()` before either's result is visible. No advisory lock or `ON CONFLICT` clause prevents this. This is the primary cause of the 15 duplicate rows across 7 entity names in the Frankenstein test.

**Bug 1c — Error swallowing in alias insertion.** `addAliasIfNew()` at line 288 catches *all* exceptions, not just unique constraint violations. Real errors (DB connection failure, permission errors) are silently dropped.

### The Fix

**1a — Context-windowed embedding:** When `start`/`end` positions are available from extraction, compute a context window centred on the mention (e.g., 100 chars before + 100 chars after). Fall back to first 200 chars only when positions are unavailable.

**1b — Upsert with advisory lock:** Before `createEntity()`, acquire a PostgreSQL advisory lock on `hashtext(canonical_name || entity_type)`. Alternatively, add a unique partial index on `(lower(canonical_name), entity_type)` and use `INSERT ... ON CONFLICT DO UPDATE SET last_seen_at = NOW()`. The advisory lock approach is safer because it prevents the race without constraining the schema.

**1c — Targeted error catching:** Replace the bare `catch` with a catch that checks for unique constraint violation (PostgreSQL error code `23505`) and re-throws anything else.

### Files to Modify

| File | Change |
|------|--------|
| `platform/src/services/entities.ts` | `resolveEntity()` — context-windowed embedding. `createEntity()` — advisory lock or ON CONFLICT. `addAliasIfNew()` — targeted catch. |
| `platform/src/gardener/agents/entity-extraction.agent.ts` | Pass mention positions to `linkEntitiesToMemory()` (already available from ML extraction) |

### Graph C Prerequisite

Clean entity graph = clean causal node anchoring. Every entity in Graph S maps to exactly one node. Causal edges in Graph C that reference entity transitions point to the correct, canonical entity — not an arbitrary duplicate.

---

## 3. Fix 2: Coordinate Entity and Relationship Extraction

### The Bug

The relationship agent (`platform/src/gardener/agents/relationship.agent.ts:120-125`) resolves subjects and objects via exact case-insensitive string matching:

```typescript
const subjectEntity = entities.find(
  e => e.name.toLowerCase() === rel.subject.toLowerCase()
);
```

The ML relationship extraction returns generic references ("narrator", "I", "lieutenant", "the captain") that don't match the entity names extracted in the previous step ("R. Walton", "Captain Walton"). The entity extraction and relationship extraction prompts operate independently — they each decide what to call characters.

**Result:** 36 of 75 extracted relationships (48%) discarded. Two chunks produced zero facts. First-person narrated text is especially affected.

### The Fix

**Two-pass constrained extraction:**

1. Entity extraction runs first (already the case via job chaining).
2. The relationship extraction prompt receives the resolved entity list with explicit instructions: "Use ONLY these entity names as subjects and objects. Do not introduce new entity references." The ML service endpoint already receives entities — the prompt just needs to constrain output to those names.
3. Replace exact string matching in the relationship agent with fuzzy matching as a safety net:
   - First: exact match (current behaviour, fast)
   - Second: case-insensitive substring match ("Captain Walton" matches "Walton")
   - Third: embedding similarity against entity embeddings (handles "the narrator" → "R. Walton")
   - Fourth: skip with warning (current fallback)

**Coreference resolution (longer-term):** For first-person text, a lightweight coreference step before relationship extraction would resolve "I", "me", "the narrator" to the established entity. This could be a prompt instruction ("The narrator is R. Walton. Replace all first-person references accordingly.") rather than a separate NLP pipeline.

### Files to Modify

| File | Change |
|------|--------|
| `platform/src/gardener/agents/relationship.agent.ts` | Replace exact match (line 120-125) with multi-tier fuzzy matching. Pass entity list with constraint instructions to ML service. |
| `ml-services/app/` (relationship extraction prompt) | Add constraint: "Use ONLY the provided entity names as subjects/objects." Add coreference instruction for first-person text. |

### Graph C Prerequisite

Complete relationship set = complete causal input. Every relationship that can be extracted feeds into Graph C as a potential state transition. Losing 48% of relationships means losing 48% of potential causal links.

---

## 4. Fix 3: Entity Specificity Filtering

### The Bug

The entity extraction ML prompt accepts too many types and doesn't filter for specificity. The Frankenstein test produced ~15 entities that are descriptions, not proper entities:

- **Concepts that are attributes:** "dauntless courage"
- **Weather/nature:** "frost", "snow", "spring", "winter"
- **Objects mentioned in passing:** "the needle", "the magnet"
- **Anaphoric references:** "a lady", "her lover", "his rival", "the old man"
- **Relationship descriptors:** "the father of the girl"
- **Too generic:** "Englishman", "June", "vessel", "enterprise"

### The Fix

**Prompt engineering (primary):** Instruct the ML to extract only:
- Named entities (proper nouns with specific referents)
- Entities with stable identity (can be referenced again meaningfully)
- Reject common nouns, weather, generic descriptors, and anaphoric references

**Post-extraction filter (secondary):**
- Reject entities below a character threshold (e.g., 2 characters)
- Reject entities matching a stopword list (seasons, weather, generic roles)
- Reject entities with type "concept" unless they represent a specific, named concept
- Confidence threshold: drop entities below 0.5 confidence from the ML response

**Entity type constraint:** The dynamic entity type system (migration 024) should be leveraged — only types with `canonical` or `provisional` status are valid. The extraction prompt already receives `validTypes` from `getValidEntityTypes()`. Tightening the type definitions helps.

### Files to Modify

| File | Change |
|------|--------|
| `ml-services/app/` (entity extraction prompt) | Specificity instructions, proper noun emphasis |
| `platform/src/services/entities.ts` or `entity-extraction.agent.ts` | Post-extraction filter before `linkEntitiesToMemory()` |

### Graph C Prerequisite

Clean entities = reliable causal attribution. A causal edge pointing to "dauntless courage" as a participant is noise. Only entities that can meaningfully participate in causal chains should enter Graph S.

---

## 5. Fix 4: Fact Deduplication

### The Bug

**Exact duplicates (Bug 4):** "Mrs. Saville lives_in England" appears twice with different confidence scores (0.95 and 0.99) because two chunks both mention the same fact. `createFact()` in `platform/src/services/facts.ts` doesn't check for existing identical triples before inserting.

**Semantic duplicates (Bug 5):** "Uncle Thomas owns 'books of voyages'" and "Uncle Thomas owns 'library of voyage histories'" are the same fact with different wording in `object_value`.

### The Fix

**Exact dedup:** Before inserting, check for existing active facts with matching `(subject_entity_id, predicate, object_entity_id)` or `(subject_entity_id, predicate, object_value)`. If found, update confidence to `MAX(existing, new)` and add the new `source_memory_id` as additional provenance. Use `INSERT ... ON CONFLICT` or a pre-check query.

**Semantic dedup (longer-term):** For `object_value` facts (free-text objects), generate an embedding for the object value and compare against existing facts with the same subject+predicate. If embedding similarity exceeds a threshold (e.g., 0.90), treat as duplicate. This is what the conflict resolution agent should handle — wire it to check for semantic duplicates, not just contradictions.

### Files to Modify

| File | Change |
|------|--------|
| `platform/src/services/facts.ts` | `createFact()` — pre-insert check for existing matching triple. Upsert logic for confidence and provenance. |
| `platform/src/gardener/agents/conflict-resolution.agent.ts` | Enhance to detect semantic duplicates via embedding similarity on `object_value` |

### Graph C Prerequisite

Unique facts = unique causal events. A duplicate fact creates a duplicate state transition node in Graph C, which spawns duplicate causal edges. The causal graph must have a 1:1 relationship with actual state changes in Graph S.

---

## 6. Wire the Ontology Evolution Pipeline

### Current State

The living ontology system is the most thoroughly designed subsystem that isn't fully operational. The design in `docs/design/living-ontology.md` specifies three layers of predicate intelligence:

1. **Layer 1 (Structural):** Lemmatization, tense→timestamps mapping, inverse registry lookup. **Implemented** in `services/predicates.ts` via `normalizePredicate()`.

2. **Layer 2 (Embedding):** Enriched description embeddings with mean-centering, HAC clustering, two-threshold scoring (>0.905 auto-merge, <0.848 distinct, 0.848-0.905 review zone). **Designed and benchmarked** (F1=0.87 clustering, F1=0.985 cross-validation) but **not wired** in the ontology evolution agent.

3. **Layer 3 (LLM Gate):** LLM verifies merge candidates, batch review of 3-5 predicates per call. **Designed** but **not called** — the `/compare-predicates` ML endpoint exists but the agent doesn't invoke it.

The database infrastructure is ready: migration 025 added staging lifecycle columns (`status`, `first_seen_at`, `distinct_memory_count`, `usage_count`, `promoted_at`, `rejected_at`). Valid status transitions are defined. The `ontologyEvolutionAgent` in `platform/src/gardener/agents/ontology-evolution.agent.ts` has the three-layer structure but Layers 2 and 3 aren't connected.

### The Fix

**Wire Layer 2:** Integrate embedding generation with enriched descriptions (not raw labels), compute cosine similarity against canonical predicates, apply the two-threshold scoring from the benchmarks.

**Wire Layer 3:** Call the ML `/compare-predicates` endpoint for candidates in the 0.848-0.905 review zone. Apply the LLM decision (merge/keep_separate) with the defined confidence threshold.

**Activate the promotion lifecycle:**
- Predicates that appear 3+ times enter `staging`
- Embedding + LLM review promotes to `provisional` (14-day probation)
- Sustained usage after probation promotes to `canonical`
- Usage drop demotes back to `staging`

**Enable the scheduled job:** The ontology evolution agent is registered but its nightly schedule (2 AM) was disabled during truth graph testing. Re-enable it.

### Files to Modify

| File | Change |
|------|--------|
| `platform/src/gardener/agents/ontology-evolution.agent.ts` | Wire embedding similarity scoring (Layer 2) and ML comparison call (Layer 3). Apply promotion lifecycle logic. |
| `platform/src/services/predicates.ts` | Add `getPredicateEmbedding()`, `findSimilarPredicates()` functions |
| `platform/src/gardener/controller.ts` | Re-enable nightly ontology evolution schedule |

### Graph C Prerequisite

Stable ontology = stable causal vocabulary. Graph C's causal extraction needs to reference predicates by their canonical names. If "works_at" and "employed_at" aren't merged, causal chains that span both predicates can't be traversed as a single causal pattern. The emergent ontology ensures that Graph C's causal patterns are built on a converging vocabulary, not a diverging one.

This also extends to Graph C itself — the causal graph will develop its own emergent ontology of causal pathway types (meta-causal patterns). The mechanism is identical: extract freely, canonicalise by convergence, promote through staging. The living ontology pipeline designed for Graph S predicates will be reused for Graph C's causal vocabulary.

---

## 7. Performance: Entity Extraction Bottleneck

### Current State

Entity extraction averages **62 seconds per chunk** using Claude API via ML services. Relationship extraction averages **14 seconds per chunk**. At current throughput, 351 Frankenstein chunks would take ~6 hours for entity extraction alone.

Graph C adds another extraction pass (causal extraction) to every chunk. The base pipeline must be efficient before adding load.

### Options (Not Mutually Exclusive)

**Increase gardener concurrency:** `teamSize: 3` for realtime tier entity extraction. pg-boss supports concurrent workers. Risk: Ollama embedding service overloads at concurrency >2 (observed timeout at concurrency=5).

**Batch entity extraction:** Send 3-5 chunks in a single ML call. Reduces per-call overhead and allows cross-chunk entity awareness (the ML sees all chunks together and can resolve references). Tradeoff: longer individual call latency, harder error isolation.

**Faster/cheaper model for extraction:** Use a smaller model (Haiku, Llama 3) for entity extraction. The current 62s is dominated by Claude API round-trip time. A local model via Ollama would eliminate network latency. Quality tradeoff needs benchmarking.

**Separate embedding service:** Replace Ollama for embeddings with a dedicated service that handles concurrency better (e.g., text-embeddings-inference from Hugging Face). This unblocks higher gardener concurrency without Ollama serialization bottleneck.

### Recommended Approach

1. **Short-term:** Increase entity extraction concurrency to 2-3 and batch embedding requests
2. **Medium-term:** Benchmark a local extraction model (Llama 3.1 8B or similar) against Claude for entity quality
3. **Before Graph C:** Ensure the base pipeline can handle continuous ingestion without multi-hour backlogs

---

## 8. Implementation Order

These fixes should be applied in dependency order:

```d2
direction: down

f1b: "1. Entity concurrency protection\n(Fix 1b — advisory lock / ON CONFLICT)" {
  shape: step
  style.fill: "#f8d7da"
  style.opacity: 0.4
}

f3: "2. Entity specificity filtering\n(Fix 3 — reject vague entities)" {
  shape: step
  style.fill: "#f8d7da"
  style.opacity: 0.4
}

f1a: "3. Entity resolution context\n(Fix 1a — context-windowed embeddings)" {
  shape: step
  style.fill: "#fff3cd"
  style.opacity: 0.4
}

f2: "4. Relationship extraction coordination\n(Fix 2 — multi-tier fuzzy matching)" {
  shape: step
  style.fill: "#fff3cd"
  style.opacity: 0.4
}

f4: "5. Fact deduplication\n(Fix 4 — pre-insert check)" {
  shape: step
  style.fill: "#d4edda"
  style.opacity: 0.4
}

f6: "6. Ontology evolution wiring\n(Fix 6 — connect Layer 2 + 3)" {
  shape: step
  style.fill: "#d4edda"
  style.opacity: 0.4
}

f7: "7. Performance optimization\n(Fix 7 — concurrency, batching, model)" {
  shape: step
  style.fill: "#e8f4fd"
  style.opacity: 0.4
}

f1b -> f3: "unblocks\nparallel processing"
f3 -> f1a: "reduces noise\nfor downstream"
f1a -> f2: "clean entities\nenable matching"
f2 -> f4: "clean relationships\nenable dedup"
f4 -> f6: "stable fact flow\nenables ontology"
f6 -> f7: "correct first\nthen fast"
```

After all fixes, re-run the 10-chunk Frankenstein test and compare metrics against the baseline from `truth-graph-findings.md`:

| Metric | Baseline | Target |
|--------|----------|--------|
| Duplicate entity names | 7 (15 excess rows) | 0 |
| Relationships skipped (subject mismatch) | 36 of 75 (48%) | <5 (<7%) |
| Vague/generic entities | ~15 | <3 |
| Duplicate facts | 1 exact + semantic dupes | 0 exact, semantic flagged |
| Predicates used | 14 of 47 canonical | Wider coverage, non-canonical staged |
| Avg entity extraction time | 62s | <30s (with batching/local model) |
