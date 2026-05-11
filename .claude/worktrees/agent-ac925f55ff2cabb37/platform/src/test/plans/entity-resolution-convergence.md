# Entity Resolution Convergence Tests

## Current State

`resolveEntity()` in `services/entities.ts` is the core function that decides: create new entity, merge into existing, or link as alias.

### Thresholds
- **> 0.92**: Auto-merge (if exactly 1 high-confidence match)
- **0.75 - 0.92**: LLM-assisted verification via ML `/resolve-entity` endpoint
- **< 0.75**: Create new entity

### Existing Coverage
ENT-003/004/005 in `entity-extraction.test.ts` test the DB schema operations with hardcoded confidence values. They **bypass `resolveEntity()` entirely** — they don't test the actual resolution logic with embeddings and thresholds.

## Bugs Discovered

### Bug 1: Multiple high-confidence matches create duplicates
When 2+ entities score > 0.92, `highConfidence.length === 1` check fails. Code falls through to `mediumConfidence` filter which uses `<= 0.92`, excluding all the high-confidence matches. A new entity is created despite excellent matches existing.

### Bug 2: Context lost in linkEntitiesToMemory
`linkEntitiesToMemory()` passes empty string `''` as context to `resolveEntity()`. Entity embeddings are generated from the mention name alone, losing disambiguating context from the original message.

### Bug 3: No concurrency protection
Parallel workers processing the same new entity mention will both create separate entities. No advisory lock, no `ON CONFLICT` clause.

### Bug 4: Error swallowing in alias insertion
`addAliasIfNew()` catches ALL exceptions, not just unique constraint violations. A real error (e.g., connection failure) would be silently swallowed.

## Relevant Files

| File | Purpose |
|------|---------|
| `services/entities.ts` | resolveEntity(), findSimilarEntities(), createEntity(), addAliasIfNew() |
| `gardener/agents/entity-extraction.agent.ts` | Calls linkEntitiesToMemory() which loops resolveEntity() |
| `test/agents/entity-extraction.test.ts` | ENT-003 to ENT-005 (bypass resolveEntity) |
| `services/ml-client.ts` | ml.embed(), ml.resolveEntity() |
| `db/migrations/003_entities.sql` | Entity tables, merge function, find_similar_entities_by_name() |
| `test/setup.ts` | createTestEntity, randomEmbedding, normalizeVector, cosineSimilarity |
| `test/generators/entity.ts` | generateSimilarEntities(), generateHomonymEntities() |
| `test/mocks/ml-service.mock.ts` | Configurable embed and resolveEntity mocks |

## Test Scenarios

### ERC-001: Convergence — same mention resolves to same entity
**Setup:** Create entity "John Smith" with known embedding. Mock ML embed to return similar embedding for "John".
**Action:** Call resolveEntity("John", context) 5 times (simulating 5 different messages).
**Assert:** All 5 calls return the same entity ID. Entity count increases by 0 (all resolve to existing).

### ERC-002: Threshold boundary at 0.92
Three sub-tests using controlled embeddings:
- **ERC-002a:** Similarity 0.921 -> auto-merge (> 0.92)
- **ERC-002b:** Similarity 0.919 -> LLM verification (in medium range)
- **ERC-002c:** Similarity 0.920 -> LLM verification (strict `>` means 0.92 is NOT high-confidence)

### ERC-003: Threshold boundary at 0.75
Three sub-tests:
- **ERC-003a:** Similarity 0.751 -> LLM verification
- **ERC-003b:** Similarity 0.749 -> create new entity
- **ERC-003c:** Similarity 0.750 -> LLM verification (>= 0.75 is medium range)

### ERC-004: Multiple high-confidence matches (documents bug)
**Setup:** Create "Apple Inc" and "Apple Corp" both with embeddings very similar to "Apple" (both > 0.92).
**Action:** resolveEntity("Apple", context).
**Assert (current bug):** New entity created despite two excellent matches. Document expected fix: should merge to highest-scoring match.

### ERC-005: Batch order sensitivity
**Setup:** Empty DB. Mock embeddings for "Alice" (person) and "Alice Corp" (company).
**Action A:** Process ["Alice", "Bob", "Alice Corp"] in order.
**Action B:** Process ["Alice Corp", "Bob", "Alice"] in order.
**Assert:** Both orderings produce same final entity set. "Alice" (person) and "Alice Corp" (company) are distinct entities regardless of order.

### ERC-006: Context-dependent resolution
**Setup:** Mock embeddings so "Python" + coding context produces different embedding than "Python" + biology context.
**Action:** resolveEntity("Python", "discussing programming languages") then resolveEntity("Python", "studying reptile species").
**Assert:** Two different entities created (different embedding similarity to existing).
**Note:** Currently broken because linkEntitiesToMemory passes empty context. Test documents the gap.

### ERC-007: Alias accumulation over time
**Setup:** Create entity "John Smith".
**Action:** Sequentially resolve: "John", "J. Smith", "John Smith", "Johnny" — each with embedding similar enough to merge (> 0.92).
**Assert:** Single entity "John Smith" with aliases: ["John", "J. Smith", "Johnny"]. No duplicate entities.

### ERC-008: Type mismatch — ML type vs DB match type
**Setup:** Create entity "Mercury" (type: planet). ML extracts mention "Mercury" with type "company".
**Action:** resolveEntity("Mercury", context) where embedding matches the planet entity > 0.92.
**Assert:** Document behavior — does it merge (ignoring type mismatch) or create new (respecting type)?

### ERC-009: Empty embedding fallback
**Setup:** pgvector extension unavailable (or entity created without embedding).
**Action:** resolveEntity("John", context).
**Assert:** Falls back to `findEntitiesByName()` (trigram matching). If name match found, uses it. If not, creates new entity without embedding.

### ERC-010: Concurrent resolution race condition
**Setup:** Empty DB. Two parallel calls to resolveEntity("New Entity X", context).
**Assert (current bug):** Both create separate entities (race condition). Document expected fix: advisory lock or ON CONFLICT.
**Note:** Use Promise.all() to simulate concurrency.

## Convergence Properties

### ERC-PROP-001: Idempotent
**Action:** Process the same message through entity extraction twice.
**Assert:** Entity graph is identical after both runs. No duplicate entities or aliases.

### ERC-PROP-002: Monotonic
**Action:** Process 20 messages mentioning "John" in various contexts.
**Assert:** Entity count for "John" stabilizes at 1 (not growing unboundedly).

### ERC-PROP-003: Consistent
**Action:** resolveEntity("John", same_context) called 10 times.
**Assert:** Same entity ID returned every time.

### ERC-PROP-004: Order independent
**Action:** Process messages [A, B, C] then [C, A, B].
**Assert:** Final entity graph is identical regardless of processing order.

## Test Helpers Needed

```typescript
// Create entity with controlled embedding (for threshold testing)
function createSeededEntity(name: string, type: string, embedding: number[]): Promise<{id: string}>

// Perturb a vector by a controlled amount (for threshold boundary tests)
function perturbVector(base: number[], similarity: number): number[]

// Mock ML embed to return specific embedding for specific mention
function mockEmbeddingForMention(mention: string, embedding: number[]): void
```

## Test File

**Location:** `platform/src/test/integration/entity-resolution-convergence.test.ts`

**Imports:**
```typescript
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { testDb, createTestEntity, deleteFromTables, randomEmbedding, normalizeVector, cosineSimilarity, hasVectorExtension } from '../setup.js';
```

## Dependencies

- **Required:** PostgreSQL + pgvector (threshold tests need vector similarity)
- **Required:** ML mock (for embedding generation and LLM verification)
- **Not needed:** Qdrant, Ollama, Apache AGE
