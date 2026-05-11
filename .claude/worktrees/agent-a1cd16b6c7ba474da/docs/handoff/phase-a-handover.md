# Phase A Handover — Sparse Truth Graph

**Date:** 2026-04-06
**Branch:** `feat/sparse-truth-graph` (from `feat/cognitive-platform-v1`)
**Status:** Phase A complete. All 19 issues closed. 9/9 tests green. Phase B ready.

---

## What Was Done

Phase A stripped the platform to a minimal Graph S pipeline and proved it works.

### Codebase Strip (A01–A04)
Removed ~150 files of orchestration noise: Telegram bot, KARMA agent framework (15 agents), pg-boss queue, Hono HTTP server, skill framework, message processor, 25+ non-graph service files, 30+ test files. Consolidated 25 incremental migrations into one `001_consolidated.sql`.

**What remains under `platform/src/`:**
- `config.ts` — 7 env vars (DATABASE_URL, QDRANT_URL, ML_SERVICES_URL, EMBED_MODEL, EMBED_DIMENSIONS, ANTHROPIC_API_KEY, NODE_ENV)
- `pipeline.ts` — `store()`, `extract()`, `ingest()` 
- `harness.ts` — CLI entry point
- `services/entities.ts` — entity CRUD + resolution with advisory lock concurrency protection
- `services/facts.ts` — bi-temporal facts with dedup
- `services/predicates.ts` — 46 canonical predicates, ontology normalization
- `services/graph.ts` — Apache AGE Cypher queries
- `services/ml-client.ts` — embed, extractEntities, extractRelationships (600s timeouts)
- `services/qdrant.ts` — memories collection only
- `services/entity-profile.ts`, `services/entity-reclassification.ts` — graph utilities
- `db/` — schema (8 tables), raw query helper, migrations
- `test/harness/` — 3 test files, 9 tests

### Pipeline Implementation (A06–A14)
The `ingest(text)` pipeline:
1. `store()` — UUID, embed via Ollama, write to Qdrant
2. `extract()` — ML entity extraction → specificity filter (anaphoric, confidence <0.5) → entity resolution (3-stage: >0.92 auto-merge, 0.75–0.92 medium, <0.75 new) with context-windowed embedding → relationship extraction with multi-tier matching (exact → substring → embedding → skip) → fact creation with temporal handling (current/past/future) → AGE sync via DB trigger

### Bug Fixes
- **A08:** Entity concurrency — `pg_advisory_xact_lock` + check-before-insert in `createEntity()`
- **A09:** Context-windowed embedding — center on mention position, not document start
- **A12:** Fact dedup — check (subject, predicate, object) before insert, update confidence to MAX
- **nmemo-zl3:** ML service concurrency — `asyncio.to_thread()` on all sync LLM/Ollama calls, ThreadPoolExecutor(20)
- **nmemo-amg:** Extraction prompt — strict entity name constraints, partial name resolution, post-filter

### Test Results (Frankenstein 10-chunk Regression)
| Metric | Baseline (Mar 31) | After Phase A |
|--------|-------------------|---------------|
| Duplicate entities | 15 excess rows | 0 |
| Subject mismatch | 48–69% | 0% |
| Duplicate facts | 1 | 0 |
| Vague entities passing filter | ~15 | 6 filtered out |
| ML service crashes under load | yes | no (async + thread pool) |

---

## Commits (17)

```
9af6ac8 fix: ML service concurrency + extraction prompt constraint
5571195 fix: test infrastructure + timeouts for LLM-backed extraction
7b30752 A10+A15: entity resolution convergence tests + Frankenstein regression
1cad1bc A14: complete ingest() pipeline
1ad820b A13: fact creation with temporal handling + AGE sync
7f5b9e0 A11: relationship extraction with multi-tier entity matching
380ef01 A07: entity extraction + specificity filter in extract()
a99e0e4 A09: entity context-windowed embedding
c6a0f29 A12: fact deduplication
b21b21a A08: entity concurrency protection
742dcc5 A06: implement pipeline store()
5e29464 A05: consolidated migration (001_consolidated.sql)
e4a1524 A04: TypeScript compilation passes
b1f5a02 A03: minimal config + entry points
7cd5dc3 A02: trim services to graph essentials
69b578f A01: delete orchestration directories
e5d992b bd init: initialize beads issue tracking
```

---

## How to Continue — Phase B

### Prerequisites
1. `bd prime` — load beads workflow context
2. `bd ready` — should show B01 as first available
3. Read `docs/architecture/truth-graph/03-graph-c-technical-design.md` — full Phase B design
4. Read `docs/architecture/truth-graph/04-sparse-branch-design.md` section 2 (Phase B pipeline) — causal agent flow

### Infrastructure
All services must be running:
- PostgreSQL + AGE on port 5433: `make up`
- Qdrant on port 6335: `make up`
- Ollama on port 11434 with nomic-embed-text (host)
- Python ML services on port 8000: `cd ml-services && python -m uvicorn app.main:app --host 0.0.0.0 --port 8000`
- **ANTHROPIC_API_KEY** in `.env` (required for Phase B Haiku agent)

### Phase B Issue Chain (10 issues)

```
B01: Causal schema + AGE causal_graph          ← START HERE
  ├→ B02: Causal event creation on fact changes
  └→ B03: Causal service — write functions
       └→ B04: Causal service — read/query functions
            └→ B05: Haiku agent — tool definitions
                 └→ B06: Haiku agent — system prompt + reasoning loop
                      └→ B07: Conditional causal trigger
                           └→ B08: Pipeline causal integration
                                └→ B09: Multi-input causality + reasoning quality
Phase B epic: Phase B: Graph C Causal Layer
```

### Key Design Decisions for Phase B
- **Causal agent uses Haiku** via `@anthropic-ai/sdk` directly from TypeScript (not via Python ML service)
- **Tool-use loop** — agent queries graph, vector store, existing causal chains, then asserts edges
- **7 tools:** query_entity_facts, query_entity_neighbours, search_similar_entities, search_memories, get_memory_text, get_causal_history, create_causal_edge
- **Every causal edge has `reasoning TEXT NOT NULL` and `source_references JSONB NOT NULL`**
- **Conditional trigger:** only runs when (a) entities have existing causal history, OR (b) >N facts created, OR (c) explicit causal language in source text
- **Phase A extraction can run in parallel** but **Phase B causal reasoning must be sequential** (needs consistent graph state)

### Workflow
```
bd ready                    # Should show B01
bd show <id>               # Read acceptance criteria
bd update <id> --claim     # Start work
# implement + write tests
# verify acceptance criteria
# git commit
bd close <id>              # Move to next
```
