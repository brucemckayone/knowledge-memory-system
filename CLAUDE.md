# Sparse Truth Graph Implementation - Mnemo Project

I'm implementing the Sparse Truth Graph branch for the Mnemo project. This is a dual-graph knowledge system: Graph S (temporal state graph — entities, bi-temporal facts, Apache AGE) paired with Graph C (perpendicular causal graph — causal events, causal edges with LLM reasoning + source traceability, meta-causal patterns).

## Branch & State

- **Branch:** `feat/sparse-truth-graph` (created from `feat/cognitive-platform-v1`)
- **Beads tool path:** `C:/Users/bruce.mckay/AppData/Local/Programs/bd/bd.exe`
- **Run `bd prime` first** to load workflow context
- **Run `bd ready`** to see available work items
- **Run `bd show <id>`** to see full issue details with acceptance criteria

There are **27 beads issues** tracking all work:
- 2 epics (Phase A: Graph S Hardening, Phase B: Graph C Causal Layer)
- 15 Phase A issues (strip codebase, build pipeline, fix entity resolution bugs, fix relationship matching, fix fact dedup, Frankenstein regression)
- 1 Phase Gate (GATE: blocks all Phase B until Graph S is proven solid)
- 9 Phase B issues (causal schema, causal events, causal service, Haiku tool-use agent with 7 tools, conditional trigger, pipeline integration, multi-input causality verification)

Dependencies enforce build order. `bd ready` shows what's unblocked. **Start with the first ready item.**

## Architecture Documents (READ THESE FIRST)

All design decisions, schemas, pipeline details, tool definitions, and acceptance criteria are documented in:

```
docs/architecture/truth-graph/
├── README.md                        ← Start here. Reading order + key decisions.
├── 00-position-paper.md             ← The "why" — research-grounded dual-graph proposal
├── 01-dual-graph-architecture.md    ← The "how" — Graph S + Graph C conceptual design
├── 02-graph-s-hardening.md          ← The "fix now" — entity dedup, relationship matching, fact dedup
├── 03-graph-c-technical-design.md   ← The "build next" — causal schema, Haiku agent, query interface
└── 04-sparse-branch-design.md       ← The "implementation" — file inventory, pipeline code, phases
```

**Critical:** Read `04-sparse-branch-design.md` in full before writing any code. It has:
- Exact file inventory (what to keep, delete, create)
- The `ingest()` / `store()` / `extract()` pipeline design with detailed step-by-step implementation
- The Haiku causal agent's 7 tool definitions, system prompt, `create_causal_edge` input schema
- Conditional trigger logic (when the causal agent runs vs skips)
- Config, migration, and test strategy

Also read `02-graph-s-hardening.md` — it maps every bug from the Frankenstein test (docs/handoff/truth-graph-findings.md) to a specific fix with file paths and code references.

## Key Technical Decisions

1. **Pipeline is synchronous.** `ingest(text)` = `store()` → `extract()` → `[conditional] causal agent` → return. No queue, no agents, no pg-boss. Direct function calls.
2. **Store inline, extract lazy.** `store(text)` embeds + writes to Qdrant immediately. `extract(memoryId)` runs entity/relationship/fact extraction. `ingest()` does both. `extract()` is also callable standalone for re-processing.
3. **Qdrant stays.** The causal agent needs semantic search over raw source texts. pgvector handles entity/fact similarity. Qdrant handles source text search.
4. **ML services stay** (Python FastAPI on port 8000). Entity/relationship extraction goes through the existing ML service. Embeddings via Ollama (nomic-embed-text, 768-dim).
5. **Causal reasoning uses Claude Code** invoked via `-p` flag. The 7 causal tools are exposed as an MCP server (`services/causal-mcp.ts`). Claude Code connects to the MCP server, queries the graph, vector store, and existing causal chains, then asserts edges with detailed reasoning + source references. No vendor-specific SDK — the MCP interface is model-agnostic.
6. **Causal agent is conditional.** Only runs when: (a) entities have existing causal history, OR (b) >N facts created, OR (c) explicit causal language in source text.
7. **Every causal edge has `reasoning TEXT NOT NULL` and `source_references JSONB NOT NULL`.** Non-negotiable — full traceability.
8. **Single consolidated migration** (001_consolidated.sql) — 7 Graph S tables + AGE. Phase B adds 002_causal_graph.sql with 3 more tables.
9. **Graph S first, then Graph C.** Phase A must pass Frankenstein regression before any Phase B work starts.

## Workflow

1. `bd ready` → pick an issue
2. `bd update <id> --claim` → mark in progress
3. Read the acceptance criteria: `bd show <id>`
4. Implement + write tests that encode the acceptance criteria
5. Verify: run the tests, check the criteria
6. `bd close <id>` → move to next
7. When Phase A is done: close the GATE issue, which unblocks Phase B

## Infrastructure Required

- **PostgreSQL** with pgvector + Apache AGE on port 5433 (Docker: `make up`)
- **Qdrant** on port 6335 (Docker: `make up`)
- **Ollama** on port 11434 with nomic-embed-text model (host)
- **Python ML services** on port 8000 (`cd ml-services && make ml`)
- **Claude Code** CLI available on PATH (Phase B — causal reasoning agent)

## AGE / search_path Gotchas

`001_consolidated.sql` sets `SET search_path = ag_catalog, public, "$user"` at the **session level**. This persists across migration files. Consequences:

- **New migration DDL must use explicit `public.` schema qualifiers** on all CREATE TABLE, CREATE INDEX, REFERENCES, and trigger statements. Without it, objects land in `ag_catalog` (the first schema in the path) and FK references to `public.facts`/`public.entities` fail cross-schema. See `002_causal_graph.sql` for the pattern.
- **Do NOT change the session search_path** in new migrations. The existing Graph S triggers (`sync_entity_to_graph`, `trigger_sync_fact`) and AGE's `cypher()` function depend on `ag_catalog` being in the session path.
- **AGE edge properties don't persist via SET** in this version. `MERGE (a)-[r:REL]->(b) SET r.prop = value` creates the edge but silently drops the SET. Node properties work fine. The AGE graph is a traversal index — canonical data lives in PostgreSQL tables.
- **`LOAD 'age'` is required per-session** for PL/pgSQL trigger functions to resolve `cypher()` inside EXECUTE. `shared_preload_libraries` handles standard SQL but not dynamic EXECUTE. The 002 migration includes `LOAD 'age'`; tests must also call `LOAD 'age'` on their connection before testing AGE triggers.

## Existing Test Infrastructure

The test setup at `src/test/setup.ts` provides: `testDb`, `createTestEntity()`, `createTestFact()`, `randomEmbedding()`, `normalizeVector()`, `cosineSimilarity()`, `isMLServiceAvailable()`, `deleteFromTables()`. Test generators at `src/test/generators/` provide realistic entity/fact/memory generation. Reuse these — don't create new test infrastructure.