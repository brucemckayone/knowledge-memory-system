# Phase 4: KARMA Agents

> **Goal:** Implement the remaining KARMA agents for autonomous knowledge maintenance.

---

## Phase Status

| Packet | Name | Status | Dependencies |
|--------|------|--------|--------------|
| W22 | Ingestion Agent | 📋 Ready | W21 |
| W23 | Reader Agent | 📋 Ready | W22 |
| W24 | Summarizer Agent | 📋 Ready | W22 |
| W26 | Relationship Extraction Agent | 📋 Ready | W25, W17 |
| W27 | Schema Alignment Agent | 📋 Ready | W17, W26 |
| W29 | Evaluator Agent | 📋 Ready | W28 |

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

### Ingestion Agent (W22)
- Receives raw memories from the message processor
- Chunks long content appropriately
- Queues downstream processing jobs
- Tier: Real-time (immediate)

### Reader Agent (W23)
- Reads and parses stored memories
- Extracts structured content from unstructured text
- Determines content type (note, task, event, etc.)
- Tier: Real-time

### Summarizer Agent (W24)
- Creates concise summaries of memories
- Generates embeddings for semantic search
- Updates context summaries
- Tier: Near-term (within 1 hour)

### Relationship Extraction Agent (W26)
- Extracts relationships between entities as facts
- Identifies predicates (works_at, manages, created, etc.)
- Creates edges in the knowledge graph
- Tier: Near-term

### Schema Alignment Agent (W27)
- Normalizes predicates to ontology
- Merges similar relationship types
- Maintains predicate dictionary
- Tier: Background (daily)

### Evaluator Agent (W29)
- Validates agent outputs for quality
- Tracks agent performance metrics
- Adjusts MAB weights based on outcomes
- Tier: Continuous

---

## Recommended Implementation Order

1. **W22 → W23 → W24**: Core ingestion pipeline
2. **W26 → W27**: Relationship extraction
3. **W29**: Quality evaluation (can be developed in parallel)

---

## Success Criteria

- [ ] All agents registered with Central Controller
- [ ] Jobs flow through pipeline correctly
- [ ] Entities and facts populated automatically
- [ ] Performance metrics tracked
- [ ] MAB scheduling optimizes priorities
