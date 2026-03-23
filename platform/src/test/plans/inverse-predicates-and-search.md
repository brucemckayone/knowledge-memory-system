# Inverse Predicate Consistency & Hybrid Search Safety

## Part A: Inverse Predicates

### Current State

The predicate ontology in `services/predicates.ts` defines inverse relationships:
- `manages` <-> `reports_to`
- `parent_of` <-> `child_of`
- `member_of` <-> `has_member`
- `teaches` <-> `studies_under`

**However:** `createFact()` in `services/facts.ts` does **NOT** auto-create inverse facts. The `inverse` field in the ontology is defined but never used at write time — it's metadata only.

The relationship agent also does not create inverse facts. It creates one fact per extracted relationship.

**Result:** Creating "Alice manages Bob" does NOT create "Bob reports_to Alice". Querying "Who does Bob report to?" won't find Alice unless graph traversal walks edges bidirectionally.

### Design Decision

This is a design decision, not a bug. Two approaches:
1. **Auto-create inverse facts** — doubles fact count, but queries are simple and bidirectional
2. **Query-time inference** — keep one fact, resolve inverse at query time via predicate metadata

The tests should document the current behavior and provide a foundation for whichever approach is chosen.

### Relevant Files

| File | Purpose |
|------|---------|
| `services/predicates.ts` | Ontology with inverse mappings, getPredicateInfo() |
| `services/facts.ts` | createFact() — does NOT create inverses |
| `services/graph.ts` | Graph traversal — does it walk bidirectionally? |
| `gardener/agents/relationship.agent.ts` | Creates facts from relationships |
| `test/agents/schema-alignment.test.ts` | SCH-001 to SCH-004 (normalization only) |

## Part B: Hybrid Search Entity Safety

### Current State

`hybridSearch()` in `services/hybrid-search.ts` extracts entities from query text using `findEntitiesByName()` (trigram search), **NOT** `resolveEntity()`. So it does **not** create new entities during search — the initial concern was a false alarm.

However, `findEntitiesByName()` returns multiple matches ranked by similarity. The search picks the top match. No test verifies this selection logic or behavior with ambiguous queries.

### RRF Scoring
Reciprocal Rank Fusion with k=60: `score = 1/(k + rank)`. Each source (vector, graph, keyword) contributes independently. Results merged by memory ID, scores summed.

### Relevant Files

| File | Purpose |
|------|---------|
| `services/hybrid-search.ts` | hybridSearch(), RRF, entity extraction from query |
| `services/entities.ts` | findEntitiesByName(), resolveEntity() |
| `test/integration/hybrid-search.test.ts` | HS-001 to HS-007 |

## Test Scenarios — Part A: Inverse Predicates

### IPT-001: Inverse facts NOT auto-created (document current behavior)
**Setup:** Create entities Alice, Bob. Create fact: Alice manages Bob.
**Assert:** Only 1 fact exists (manages). No reports_to fact auto-created. This documents current behavior.

### IPT-002: Bidirectional graph traversal
**Setup:** Create fact: Alice manages Bob (creates graph edge Alice->Bob).
**Action:** Query graph from Bob's perspective (incoming edges).
**Assert:** Bob can discover Alice via incoming "manages" edge. Document whether graph.ts supports this natively or if it only walks outgoing edges.

### IPT-003: Symmetric predicates
**Setup:** Create fact: Alice knows Bob.
**Action:** Query facts for Bob.
**Assert:** If `knows` is symmetric, Bob should be able to find Alice. Document whether this works via graph bidirectionality or requires explicit inverse fact.

### IPT-004: Inverse metadata correctness
**Action:** For every predicate in the ontology that has an `inverse` field, verify:
- `getPredicateInfo(predicate).inverse` returns the correct inverse
- `getPredicateInfo(inverse).inverse` returns the original (round-trip)
- Both predicate and inverse exist in the ontology

### IPT-005: Inverse + supersession interaction
**Setup:** Create "Alice manages Bob". Later create "Alice no longer manages Bob" (supersession).
**Assert:** If inverses were auto-created, "Bob reports_to Alice" should also be superseded. Document what would need to change to support this.

## Test Scenarios — Part B: Hybrid Search Safety

### HST-001: Search for existing entity
**Setup:** Create entity "Google" with facts. Seed Qdrant with related memories.
**Action:** `hybridSearch("What do we know about Google?")`
**Assert:** Entity "Google" matched via findEntitiesByName(). Results include Google-related memories. Entity count unchanged after search.

### HST-002: Search for nonexistent entity
**Setup:** No entity "Acme" exists.
**Action:** `hybridSearch("Tell me about Acme")`
**Assert:** No phantom entity created. Entity count unchanged. Search returns empty or keyword-only results.

### HST-003: RRF with empty vector results
**Setup:** Graph has entities with edges, but Qdrant has no matching vectors.
**Action:** hybridSearch with graph-only matches.
**Assert:** Results come from graph source only. RRF scores still valid (1/(60+rank) for graph matches, 0 for vector).

### HST-004: RRF with all three sources
**Setup:** Seed Qdrant (vector matches), graph (entity neighbors), and keyword payload.
**Action:** hybridSearch with a query matching all three.
**Assert:** Final scores reflect contribution from all sources. Top result has highest combined RRF score.

### HST-005: Entity name disambiguation
**Setup:** Create "Apple Inc" (company) and "Apple Records" (company). Both have "Apple" in name.
**Action:** `hybridSearch("Apple engineering team")`
**Assert:** findEntitiesByName returns both. Verify which is selected for graph expansion and whether both contribute to results.

## Test File

**Location:** `platform/src/test/integration/inverse-predicates-and-search.test.ts`

**Imports:**
```typescript
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { testDb, createTestEntity, createTestFact, deleteFromTables, isQdrantAvailable } from '../setup.js';
```

## Dependencies

- **Required:** PostgreSQL (all predicate tests)
- **Required for search tests:** Qdrant (gate with `beforeAll(ctx.skip)`)
- **Optional:** Apache AGE (gate graph traversal tests)
- **Not needed:** ML Services, Ollama
