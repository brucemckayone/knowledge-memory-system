# Cross-Agent Interaction Tests

## Current State

`agent-pipeline.test.ts` tests the pipeline with **ALL ML calls mocked**. It verifies job chaining and data flow between agents, but never tests real ML responses flowing through the pipeline. The mocks return canned data that doesn't exercise predicate normalization, conflict detection, or entity resolution edge cases.

## Agent Pipeline Data Flow

```
Memory ingested
  -> entity-extraction agent:
     - ML.extractEntities() -> mentions with types/confidence
     - linkEntitiesToMemory() -> resolveEntity() per mention
     - If >= 2 entities: queue relationship agent

  -> relationship agent:
     - getMemoryEntities() from DB
     - ML.extractRelationships() -> triples with temporal hints
     - normalizePredicate() on each
     - createFact() with temporal hints
     - Queue conflict-resolution if facts created

  -> conflict-resolution agent:
     - findSupersedingFacts() for new facts
     - Heuristic fast path for obvious cases (antonyms, exclusive predicates)
     - ML debate protocol for subtle cases
     - Apply resolution: supersede / invalidate / coexist / flag

  -> schema-alignment agent (periodic):
     - syncOntologyToDb()
     - findNonCanonicalPredicates()
     - normalizeFactPredicates()

  -> context-linker agent (on session close):
     - Compute entity overlap across session members
     - Generate context summary via LLM
     - Create CO_TEMPORAL facts
     - Re-embed with context
```

## Key Issues

1. **Predicate normalization race**: Relationship agent may create `employed_at`, conflict resolution compares against `works_at` before schema alignment normalizes
2. **Entity merge mid-pipeline**: Entity extraction creates "John" and "J. Smith" which later merge — relationship agent's facts may reference deleted source entity (see entity-merge-cascade.md)
3. **No test verifies final DB state after full pipeline** — only individual agent outputs

## Relevant Files

| File | Purpose |
|------|---------|
| `gardener/agents/entity-extraction.agent.ts` | First pipeline stage |
| `gardener/agents/relationship.agent.ts` | Creates facts from relationships |
| `gardener/agents/conflict-resolution.agent.ts` | Resolves contradictions |
| `gardener/agents/schema-alignment.agent.ts` | Normalizes predicates |
| `gardener/agents/context-linker.agent.ts` | Session-level enrichment |
| `gardener/controller.ts` | Agent scheduling, job dependencies |
| `test/integration/agent-pipeline.test.ts` | Existing mocked pipeline test |
| `test/mocks/ml-service.mock.ts` | Available mock responses |
| `services/predicates.ts` | Predicate ontology and normalization |

## Test Scenarios

### CAI-001: Golden path — single memory through all agents
**Setup:** Mock ML to return deterministic responses for "John works at Google".
**Action:** Run entity-extraction -> relationship -> conflict-resolution -> schema-alignment in sequence.
**Assert final DB state:**
- Entity "John" exists (type: person)
- Entity "Google" exists (type: company)
- Fact: John works_at Google (canonical predicate, active, no conflicts)
- memory_entities links both entities to the memory
- No contradiction_reviews created
- fact_predicates shows works_at usage

### CAI-002: Conflict pipeline — two contradicting memories
**Setup:** Process memory 1: "John works at Acme". Process memory 2: "John works at Google".
**Action:** Full pipeline for both, including conflict resolution on second pass.
**Assert:**
- works_at Acme fact superseded (expired_at set)
- works_at Google fact active
- contradiction_reviews may have entry if subtle case
- Point-in-time query returns correct employer

### CAI-003: Predicate normalization ordering
**Setup:** Relationship agent creates fact with predicate "employed_at" (non-canonical).
**Action sequence A:** Schema alignment runs BEFORE conflict resolution.
**Action sequence B:** Conflict resolution runs BEFORE schema alignment.
**Assert:** Both orderings produce same final state: canonical "works_at" predicate, correct conflict detection regardless of whether predicate was normalized first.

### CAI-004: Entity merge mid-pipeline
**Setup:** Two memories mentioning "John" and "J. Smith" (same person, different names).
**Action:** Entity extraction creates two entities. Relationship creates facts on both. Resolution determines they're the same (>0.92 similarity). Merge triggered.
**Assert:** All facts consolidated under single entity. No orphaned facts. Aliases include both names.
**Note:** This will expose the CASCADE deletion bug (see entity-merge-cascade.md).

### CAI-005: Context linker after conflicts
**Setup:** Two memories in same ingestion session. Memory 1: "John works at Acme". Memory 2: "John just started at Google" (supersedes).
**Action:** Full pipeline including context-linker on session close.
**Assert:**
- CO_TEMPORAL fact created between the two memories
- Context summary reflects that John changed jobs (resolved state, not conflicting state)
- Qdrant payloads updated with cross-links

### CAI-006: Error resilience — agent failure mid-pipeline
**Setup:** Configure ML mock to fail on the SECOND call (e.g., extractRelationships fails after extractEntities succeeds).
**Action:** Run pipeline. Entity extraction succeeds, relationship agent fails.
**Assert:**
- Entities created and linked (first agent's work preserved)
- No facts created (second agent failed)
- Job marked as failed with retry available
- Re-running from checkpoint doesn't duplicate entities

## Mock Strategy

- **Mock:** ML services (extractEntities, extractRelationships, checkContradiction, chat) with deterministic responses
- **Real:** PostgreSQL, pg-boss job queue, all agent logic, predicate normalization, entity resolution
- **Gate:** Qdrant calls (mock or skip — not core to truth graph testing)

## Test File

**Location:** `platform/src/test/integration/cross-agent-interactions.test.ts`

**Imports:**
```typescript
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { testDb, createTestEntity, deleteFromTables, randomUUID, mockMLService } from '../setup.js';
// Import agents directly
import { entityExtractionAgent } from '../../gardener/agents/entity-extraction.agent.js';
import { relationshipAgent } from '../../gardener/agents/relationship.agent.js';
import { conflictResolutionAgent } from '../../gardener/agents/conflict-resolution.agent.js';
import { schemaAlignmentAgent } from '../../gardener/agents/schema-alignment.agent.js';
```

## Dependencies

- **Required:** PostgreSQL, pg-boss
- **Mocked:** ML Services (deterministic responses)
- **Optional:** Qdrant (mock or skip)
- **Not needed:** Ollama, Apache AGE
