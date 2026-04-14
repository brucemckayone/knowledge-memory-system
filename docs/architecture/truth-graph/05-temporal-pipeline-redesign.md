# 05 — Temporal Pipeline Redesign

**Status:** Investigation  
**Branch:** `feat/sparse-truth-graph`  
**Date:** 2026-04-07

---

## 1. Problem Statement

The current `ingest()` pipeline treats every chunk as an independent unit. When multiple chunks from a single document are ingested in parallel via `Promise.allSettled()`, temporal ordering is lost. This produces three classes of bug:

### Bug A: Non-deterministic graph construction
Entity resolution, fact supersession, and entity merges all mutate shared state. Parallel execution means the order of mutations is determined by which async task commits first — not by document structure. The same input produces different graphs on different runs.

### Bug B: Inverted temporal direction
Frankenstein's text has narrative time. Letter 1 happens before the final chapters. If chunk 10 commits before chunk 1, facts from the ending establish first and facts from the beginning "supersede" them — the temporal direction is backwards. Causal edges inherit this inversion.

### Bug C: Cascade data loss during parallel merges
Entity resolution runs per-chunk in parallel. Two chunks discover "Victor Frankenstein", both create entity rows, then the merge logic deletes one. `facts.subject_entity_id` has `ON DELETE CASCADE`, so facts referencing the deleted entity vanish. Causal events then reference those deleted facts → FK violations.

### Litmus test
**Feeding the same document's chunks in reverse order should produce the same knowledge graph.** The current system fails this test.

---

## 2. Root Cause Analysis

The pipeline currently interleaves two kinds of work:

| Work type | Expensive? | Order-dependent? | Currently |
|-----------|-----------|-------------------|-----------|
| Embedding (store) | Yes (Ollama) | No | Parallel ✓ |
| Entity extraction | Yes (LLM) | No | Parallel ✓ |
| Relationship extraction | Yes (LLM) | No | Parallel ✓ |
| Entity resolution/merge | No (DB queries) | **Yes** | Parallel ✗ |
| Fact creation/supersession | No (DB writes) | **Yes** | Parallel ✗ |
| Causal event creation | No (DB writes) | **Yes** | Parallel ✗ |
| Causal agent reasoning | Yes (LLM) | **Yes** | Per-chunk ✗ |

The expensive work is order-independent. The graph mutations are order-dependent. Mixing them in the same parallel pipeline is the root cause.

---

## 3. What the System Tracks Today

| Stage | Temporal metadata | Gap |
|-------|-------------------|-----|
| Chunk creation | None — plain text, no position | No batch concept |
| `store()` | `created_at` (wall clock) | No chunk position/sequence |
| `ingest()` metadata | `{ source, timestamp? }` | No order field |
| `extract()` facts | `validAt` from ML temporal hints | "past"/"current"/"future" → crude date offsets |
| Entity resolution | `position.start/end` (character offsets) | Within-chunk only, not cross-chunk |
| Fact supersession | `validAt`/`invalidAt` range overlap | Based on text hints, not document order |
| Causal trigger | Fact count, causal language, entity history | No chunk ordering |
| Causal agent | Events, facts, source text | No chunk sequence context |

**Summary:** Zero cross-chunk temporal awareness at any stage.

---

## 4. Proposed Architecture: Two-Phase Pipeline

```
ingestBatch(chunks[], { source, ordered: true })
  │
  ├─ Phase 1: PARALLEL (order-independent, expensive)
  │   for each chunk[i]:
  │     memoryId = store(chunk, { position: i })
  │     raw = extractRaw(memoryId)
  │       ├─ entity mentions + types
  │       ├─ relationships + temporal hints
  │       └─ causal language markers
  │     return { memoryId, position: i, raw }
  │
  ├─ Phase 2: SEQUENTIAL (order-dependent, cheap)
  │   sort results by position
  │   for each result in order:
  │     ├─ resolve entities (sees all prior entities)
  │     ├─ merge duplicates (safe — no parallel mutation)
  │     ├─ create/supersede facts (correct temporal direction)
  │     └─ create causal events
  │
  └─ Phase 3: CAUSAL AGENT (once, full graph visible)
      agent sees complete entity set, full fact chain,
      correct temporal ordering → asserts causal edges
```

### Key changes from current design:
1. **New `ingestBatch()` entry point** — accepts ordered chunk array with batch metadata
2. **`extractRaw()` replaces `extract()`** — does ML work only, returns raw mentions/relationships without touching the graph
3. **Phase 2 graph resolution** — sequential walk in document order, all entity/fact/causal mutations happen here
4. **Causal agent runs once per batch** — not per-chunk, sees full context

### What stays the same:
- Single-chunk `ingest()` still works for one-off inputs (no batch needed)
- ML service endpoints unchanged
- Qdrant storage unchanged
- Graph schema unchanged

---

## 5. Open Questions

### Q1: What defines chunk ordering?
For a single document split into paragraphs, position = array index. But what about:
- Multiple documents ingested together?
- Documents with internal temporal markers (dates, "three weeks later")?
- Re-ingestion of the same document with corrections?

### Q2: Cross-document temporal ordering
User ingests a January article, then a March article, but ingests January second. The system needs source-level temporal metadata beyond chunk position. Is this the caller's responsibility or should the system infer it?

### Q3: How does `extractRaw()` differ from `extract()`?
Current `extract()` does: ML extraction → entity resolution → fact creation → causal events. `extractRaw()` would stop after ML extraction and return structured data without graph mutations. The entity resolution and fact creation move to Phase 2.

### Q4: Does the backwards-document invariant hold?
If chunks are position-sorted in Phase 2, feeding them backwards still sorts correctly (position 0 is position 0 regardless of ingestion order). But if the caller gets positions wrong, the graph is wrong. Is that acceptable?

### Q5: What happens to single-chunk `ingest()`?
It becomes `ingestBatch([chunk], { source })` internally — same code path, batch of one. The causal agent still runs (if triggered) because even a single chunk can have causal significance.

---

## 6. Investigation: Serial Baseline Test

Before designing the batch pipeline, we need a serial baseline to establish what the "correct" graph looks like when temporal ordering is preserved.

**Test:** Ingest the Frankenstein 10 chunks **sequentially, in document order**, and capture:
- Entity count + names
- Fact count + triples
- Causal events + edges
- Any errors

Compare against the parallel test results to quantify the divergence. This tells us exactly what parallelization breaks.

See beads issue for acceptance criteria.

---

## 7. Files Involved

| File | Role | Changes needed |
|------|------|----------------|
| `platform/src/pipeline.ts` | Entry point | Add `ingestBatch()`, add `extractRaw()` |
| `platform/src/services/entities.ts` | Entity resolution | No parallel mutation — called sequentially in Phase 2 |
| `platform/src/services/facts.ts` | Fact creation/supersession | Sequential in Phase 2, `validAt` from chunk position |
| `platform/src/services/causal-agent.ts` | Causal reasoning | Runs once per batch, not per chunk |
| `platform/src/services/causal-trigger.ts` | Trigger logic | Batch-level trigger (total facts, total entities) |
| `platform/src/test/harness/frankenstein.test.ts` | Regression test | Add serial variant |
