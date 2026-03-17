# Phase 4: KARMA Agents

> **Goal:** Implement the remaining KARMA agents for autonomous knowledge maintenance.
> **Last Updated:** 2026-03-16

---

## Phase Status

**Overall:** ✅ **Mostly Complete** (5 of 7 agents fully implemented, 2 replaced)

| Packet | Name | Status | Dependencies | Implementation |
|--------|------|--------|--------------|----------------|
| W22 | ~~Ingestion Agent~~ | 🔀 Replaced | W21 | Chunking → reader, sessions → context-linker |
| W23 | Reader Agent | ✅ Complete | W21 | Chunk reassembly + metadata extraction ✓ |
| W24 | Summarizer Agent | ✅ Complete | W23 | Multi-granularity summaries ✓ |
| W25 | Entity Extraction Agent | ✅ Complete | W21 | LLM-based NER + resolution ✓ |
| W26 | Relationship Extraction Agent | ✅ Complete | W25, W17 | Bi-temporal facts ✓ |
| W27 | Schema Alignment Agent | ✅ Complete | W17, W26 | Ontology management ✓ |
| W28 | Conflict Resolution Agent | ⚠️ Partial | W17 | Detection working, LLM debate TODO |
| W29 | ~~Evaluator Agent~~ | 🔀 Replaced | W21 | Controller records metrics directly |
| [W22b](./W22b-context-linker.md) | Context-Linker Agent | ✅ Complete | W21 | Ingestion sessions, CO_TEMPORAL facts ✓ |

### Implementation Notes (Last Reviewed: 2026-03-16)

**✅ Fully Implemented Agents:**
- **W23 Reader**: Content classification, chunk reassembly (`reassembleContent`), metadata extraction, 8 content types
- **W24 Summarizer**: Style-based summaries (concise, article, action, timeline, bullet, answer)
- **W25 Entity**: Threshold-based resolution (>0.92 auto-merge, 0.75-0.92 LLM verify, <0.75 create new)
- **W26 Relationship**: 25+ predicates across 7 categories, bi-temporal fact creation
- **W27 Schema**: Predicate ontology normalization with alias mapping
- **Context-Linker**: Ingestion session processing, CO_TEMPORAL facts, cross-linking, tag propagation

**🔀 Replaced Agents:**
- **W22 Ingestion**: Deleted — chunking absorbed by reader, session grouping by context-linker
- **W29 Evaluator**: Deleted — metrics recorded by controller directly to `gardener_metrics`. MAB removed (migration 010).

**⚠️ Partially Implemented:**
- **W28 Conflict Resolution**: Basic detection working, LLM debate system not implemented

**Key Deviations from Original Plan:**
- Entity extraction uses KARMA agents (not skill framework)
- Three tiers: realtime, frequent, periodic
- Typed error hierarchy: `AgentError`, `MlServiceError`, `PayloadError`, `DataFetchError`
- Controller records per-job metrics (replacing evaluator agent)
- Enriched `AgentContext` with traceId, config, services (ml + controller), signal (AbortSignal)
- Enhanced features: checkpointing, batch processing, error recovery

---

## 7-Agent KARMA Architecture

```
                    ┌─────────────────────────────┐
                    │     Central Controller      │
                    │  (Priority + Tier Defaults   │
                    │   + Metrics Recording)       │
                    └─────────────┬───────────────┘
                                  │
        ┌─────────────────────────┼─────────────────────────┐
        │                         │                         │
        ▼                         ▼                         ▼
┌───────────────┐         ┌───────────────┐         ┌───────────────┐
│    Reader     │────────▶│  Summarizer   │         │    Entity     │
│     Agent     │         │     Agent     │         │  Extraction   │
│     (W23)     │         │     (W24)     │         │     (W25)     │
└───────────────┘         └───────────────┘         └───────────────┘
                                                            │
                                                            ▼
                                  ┌───────────────┐  ┌───────────────┐
                                  │ Relationship  │──│    Schema     │
                                  │  Extraction   │  │   Alignment   │
                                  │     (W26)     │  │     (W27)     │
                                  └───────┬───────┘  └───────────────┘
                                          │
                                          ▼
                                  ┌───────────────┐
                                  │   Conflict    │
                                  │  Resolution   │
                                  │     (W28)     │
                                  └───────────────┘

        ┌───────────────────────────────────────────────────┐
        │              Context-Linker Agent                  │
        │  (Ingestion sessions, CO_TEMPORAL, cross-linking) │
        └───────────────────────────────────────────────────┘
```

---

## Agent Descriptions

### W22: Ingestion Agent 🔀 Replaced
**File:** Deleted (`ingestion.agent.ts` removed)
- Chunking absorbed by reader agent (`reassembleContent()` in `services/chunks.ts`)
- Session grouping absorbed by context-linker agent (ingestion sessions, migration 011)
- See [W22 work packet](./W22-ingestion-agent.md) for successor details

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

### W29: Evaluator Agent 🔀 Replaced
**File:** Deleted (`evaluator.agent.ts` removed)
- Quality metrics now recorded by controller directly in `gardener_metrics` table
- MAB scheduling removed (migration 010)
- Gardener observability added (migration 012, `gardener_agent_stats` view)
- See [W29 work packet](./W29-evaluator-agent.md) for successor details

### Context-Linker Agent ✅
**File:** `platform/src/gardener/agents/context-linker.agent.ts`
- Processes expired ingestion sessions (2+ members)
- Computes entity overlap from `memory_entities`
- Generates context summaries via LLM, re-embeds members
- Creates CO_TEMPORAL knowledge graph edges
- Cross-links members in Qdrant (`related_to` payload)
- Propagates shared tags across session members
- Tier: Frequent

---

## Recommended Implementation Order

1. **W23 → W24**: Core reading/summarization pipeline
2. **W25 → W26 → W27**: Entity and relationship extraction
3. **W28**: Conflict resolution (LLM debate still TODO)

---

## Success Criteria

- [x] 7 agents registered with Central Controller
- [x] Jobs flow through pipeline correctly
- [x] Entities and facts populated automatically
- [x] Performance metrics recorded by controller (gardener_metrics)
- [x] Typed error hierarchy guides retry behaviour
- [ ] LLM debate system for conflict resolution (W28 - missing feature)

---

## Agent Inventory

| Agent | File | ML Service | Tests | Tier |
|-------|------|------------|-------|------|
| W23 Reader | `reader.agent.ts` | `reader.py` | ✓ | realtime |
| W24 Summarizer | `summarizer.agent.ts` | `summarize.py` | ✓ | frequent |
| W25 Entity | `entity-extraction.agent.ts` | `extract_entities.py` | ✓ | realtime |
| W26 Relationship | `relationship.agent.ts` | `relationships.py` | ✓ | frequent |
| W27 Schema | `schema-alignment.agent.ts` | - | ✓ | periodic |
| W28 Conflict | `conflict-resolution.agent.ts` | `check_contradiction.py` | ✓ | periodic |
| Context-Linker | `context-linker.agent.ts` | - | ✓ | frequent |

---

## Known Issues

1. **W28 Conflict Resolution**: LLM debate system not implemented (uses simple LLM call)
2. **W25 Entity Extraction**: Simplified implementation (47 lines vs 105 lines in spec)
3. **ML Service Dependencies**: All agents depend on `ml-services` being running
4. **No Human Review Interface**: Flagged conflicts have no UI for manual resolution
