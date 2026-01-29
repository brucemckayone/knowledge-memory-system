# Phase 4: KARMA Agents

> **Goal:** Implement the remaining KARMA agents for autonomous knowledge maintenance.
> **Last Updated:** 2026-01-29

---

## Phase Status

**Overall Completion:** ✅ **85% Complete** (7 of 8 agents fully implemented)

| Packet | Name | Status | Dependencies | Implementation |
|--------|------|--------|--------------|----------------|
| W22 | Ingestion Agent | ✅ Complete | W21 | Chunking + downstream queuing ✓ |
| W23 | Reader Agent | ✅ Complete | W22 | Metadata extraction ✓ |
| W24 | Summarizer Agent | ✅ Complete | W22 | Multi-granularity summaries ✓ |
| W25 | Entity Extraction Agent | ✅ Complete | W21 | LLM-based NER + resolution ✓ |
| W26 | Relationship Extraction Agent | ✅ Complete | W25, W17 | Bi-temporal facts ✓ |
| W27 | Schema Alignment Agent | ✅ Complete | W17, W26 | Ontology management ✓ |
| W28 | Conflict Resolution Agent | ⚠️ Partial | W17 | Detection working, LLM debate TODO |
| W29 | Evaluator Agent | ✅ Complete | W28, W21 | Quality scoring + MAB ✓ |

### Implementation Notes (Last Reviewed: 2026-01-29)

**✅ Fully Implemented Agents:**
- **W22 Ingestion**: Content chunking with 200-char overlap, stores in `memory_chunks` table
- **W23 Reader**: Content classification, metadata extraction, 8 content types supported
- **W24 Summarizer**: Style-based summaries (concise, article, action, timeline, bullet, answer)
- **W25 Entity**: Threshold-based resolution (>0.92 auto-merge, 0.75-0.92 LLM verify, <0.75 create new)
- **W26 Relationship**: 25+ predicates across 7 categories, bi-temporal fact creation
- **W27 Schema**: Predicate ontology normalization with alias mapping
- **W29 Evaluator**: Quality scoring (40% success, 30% duration, 30% items), MAB updates

**⚠️ Partially Implemented:**
- **W28 Conflict Resolution**: Basic detection working, LLM debate system not implemented

**Key Deviations from Original Plan:**
- Entity extraction uses KARMA agents (not skill framework)
- Most agents use `frequent` tier instead of `nearterm`
- Enhanced features: checkpointing, batch processing, error recovery
- ML service integration via generated API client (not direct fetch)

---

## 9-Agent KARMA Architecture

```
                    ┌─────────────────────────────┐
                    │     Central Controller      │
                    │   (Scheduler + MAB + Jobs)  │
                    └─────────────┬───────────────┘
                                  │
        ┌─────────────────────────┼─────────────────────────┐
        │                         │                         │
        ▼                         ▼                         ▼
┌───────────────┐         ┌───────────────┐         ┌───────────────┐
│   Ingestion   │         │    Reader     │         │  Summarizer   │
│     Agent     │────────▶│     Agent     │────────▶│     Agent     │
│     (W22)     │         │     (W23)     │         │     (W24)     │
└───────────────┘         └───────────────┘         └───────────────┘
        │                                                   │
        ▼                                                   ▼
┌───────────────┐         ┌───────────────┐         ┌───────────────┐
│    Entity     │────────▶│ Relationship  │────────▶│    Schema     │
│  Extraction   │         │  Extraction   │         │   Alignment   │
│     (W25)     │         │     (W26)     │         │     (W27)     │
└───────────────┘         └───────────────┘         └───────────────┘
        │                                                   │
        ▼                                                   ▼
┌───────────────┐         ┌───────────────┐
│   Conflict    │────────▶│   Evaluator   │
│  Resolution   │         │     Agent     │
│     (W28)     │         │     (W29)     │
└───────────────┘         └───────────────┘
```

---

## Agent Descriptions

### W22: Ingestion Agent ✅
**File:** `platform/src/gardener/agents/ingestion.agent.ts`
- Receives raw memories from message processor
- Chunks long content (>4000 chars) with 200-char overlap
- Stores chunks in `memory_chunks` table
- Queues `gardener:reader` and `gardener:extract-entities` jobs
- Tier: Realtime
- Tests: ING-001 through ING-004 passing

### W23: Reader Agent ✅
**File:** `platform/src/gardener/agents/reader.agent.ts`
- Reads and parses stored memories
- Extracts structured metadata (dates, links, tags, mentions)
- Determines content type (8 types: thought, task, link, event, note, question, idea, reference)
- Stores metadata in `memory_metadata` table
- Queues summarizer for long content (>500 words)
- Tier: Realtime
- Tests: RDR-001 through RDR-005 passing

### W24: Summarizer Agent ✅
**File:** `platform/src/gardener/agents/summarizer.agent.ts`
- Creates style-based summaries (concise, article, action, timeline, bullet, answer, standard)
- Extracts key points
- Updates embeddings with summary-enhanced content
- Stores summaries in `memory_summaries` table
- Batch processing with checkpoint support
- Tier: Frequent
- Tests: SUM-001 through SUM-004 passing

### W25: Entity Extraction Agent ✅
**File:** `platform/src/gardener/agents/entity-extraction.agent.ts`
- LLM-based named entity recognition (NER)
- Entity types: person, company, project, concept, place, event, other
- Confidence-based resolution (>0.92 auto-merge, 0.75-0.92 LLM verify, <0.75 create new)
- Links entities to memories via `memory_entities` table
- Tier: Realtime
- Tests: EE-001 through EE-008 + ENT-003 through ENT-005 passing

### W26: Relationship Extraction Agent ✅
**File:** `platform/src/gardener/agents/relationship.agent.ts`
- Extracts subject-predicate-object relationships
- Supports 25+ predicates across 7 categories (professional, personal, location, education, creation, skills, events)
- Creates bi-temporal facts with proper temporal handling (past/future/current)
- Pattern-based + LLM hybrid extraction
- Tier: Frequent
- Tests: REL-001 through REL-003 passing

### W27: Schema Alignment Agent ✅
**File:** `platform/src/gardener/agents/schema-alignment.agent.ts`
- Normalizes predicates to canonical ontology
- Maps aliases (e.g., "employed_at" → "works_at")
- Manages inverse relationships (works_at ↔ employs)
- Tracks usage counts and last-used timestamps
- Flags unknown predicates for manual review
- Tier: Periodic
- Tests: SCH-001 through SCH-004 passing

### W28: Conflict Resolution Agent ⚠️
**File:** `platform/src/gardener/agents/conflict-resolution.agent.ts`
- Detects contradictions using ALICE framework (heuristics + LLM)
- Five contradiction types: antonym, numeric, negation, structural, temporal
- Implements supersession logic (bi-temporal fact management)
- Flags ambiguous cases for manual review
- **Missing:** LLM debate system (uses simple LLM call instead)
- Tier: Periodic
- Tests: CR-001 through CR-008 + CNF-001 through CNF-005 passing

### W29: Evaluator Agent ✅
**File:** `platform/src/gardener/agents/evaluator.agent.ts`
- Validates agent outputs for quality (0.0-1.0 score)
- Weighted scoring: 40% success, 30% duration, 30% items processed
- Anomaly detection (>2 standard deviations from mean)
- Updates MAB weights via Thompson Sampling
- Tracks metrics in `gardener_metrics` table
- Tier: Frequent
- Tests: EVL-001 through EVL-004 passing

---

## Recommended Implementation Order

1. **W22 → W23 → W24**: Core ingestion pipeline
2. **W26 → W27**: Relationship extraction
3. **W29**: Quality evaluation (can be developed in parallel)

---

## Success Criteria

- [x] All agents registered with Central Controller
- [x] Jobs flow through pipeline correctly
- [x] Entities and facts populated automatically
- [x] Performance metrics tracked
- [x] MAB scheduling optimizes priorities
- [ ] LLM debate system for conflict resolution (W28 - missing feature)

---

## Agent Inventory

| Agent | File | ML Service | Tests | Tier |
|-------|------|------------|-------|------|
| W22 Ingestion | `ingestion.agent.ts` | - | ✓ 4 tests | realtime |
| W23 Reader | `reader.agent.ts` | `reader.py` | ✓ 5 tests | realtime |
| W24 Summarizer | `summarizer.agent.ts` | `summarize.py` | ✓ 4 tests | frequent |
| W25 Entity | `entity-extraction.agent.ts` | `extract_entities.py` | ✓ 11 tests | realtime |
| W26 Relationship | `relationship.agent.ts` | `relationships.py` | ✓ 12 tests | frequent |
| W27 Schema | `schema-alignment.agent.ts` | - | ✓ 18 tests | periodic |
| W28 Conflict | `conflict-resolution.agent.ts` | `check_contradiction.py` | ✓ 13 tests | periodic |
| W29 Evaluator | `evaluator.agent.ts` | - | ✓ 4 tests | frequent |

**Total Test Coverage:** 71 tests across all agents

---

## Known Issues

1. **W28 Conflict Resolution**: LLM debate system not implemented (uses simple LLM call)
2. **W25 Entity Extraction**: Simplified implementation (47 lines vs 105 lines in spec)
3. **ML Service Dependencies**: All agents depend on `ml-services` being running
4. **No Human Review Interface**: Flagged conflicts have no UI for manual resolution
