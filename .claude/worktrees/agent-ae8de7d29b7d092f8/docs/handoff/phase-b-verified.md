# Continuation Prompt — Phase B Verified, Frankenstein Throughput Fix

## Branch & Context

Branch: `feat/sparse-truth-graph`. Phase B (Graph C Causal Layer) is code-complete and verified — all 29 beads closed, committed at `c275941`. One test fix is uncommitted.

Run `bd prime` then `bd list --all` to see all closed beads. Read `CLAUDE.md` for project conventions.

## What's Verified (this session)

1. **Full causal test suite: 71/71 pass** — schema, events, service writes, queries, agent tools, MCP server, trigger logic, pipeline integration, chains, quality checks. All green.
2. **Pipeline tests: 4/4 pass** (run in isolation)
3. **Entity resolution: 3/3 pass**
4. **Causal-chains B09: 2/2 pass** (run in isolation)
5. **One test fix applied but uncommitted** — `platform/src/test/harness/causal-mcp.test.ts` updated to assert MCP config uses absolute path (matches the production fix from `c275941` where Claude Code ignores `cwd` for MCP server spawning).

## What's Outstanding

### Frankenstein regression timeout (not a code bug)

`platform/src/test/harness/frankenstein.test.ts` times out at 300s (600s with retry). Root cause: 10 parallel `ingest()` calls on line 36-38 saturate the single ML service instance. Each ingest triggers entity extraction + relationship extraction + potentially the causal agent, all hitting port 8000. The ML service health check itself times out during the test.

The error `[causal] agent failed: fetch failed` appears — the causal agent's fetch to `/causal-reason` fails because the ML service is overwhelmed.

This test passed in prior sessions (before Phase B added the causal agent path). The causal trigger fires for Frankenstein text (it contains causal language like "because"), adding extra ML service load per ingest that didn't exist before.

**Options to fix:**
1. **Increase timeout** to 600s (`}, 600_000)` on line 87) — simple but fragile
2. **Serialize the ingests** — change `Promise.allSettled(chunks.map(...))` to a sequential loop. Slower but reliable. The test is checking extraction quality, not concurrency.
3. **Disable causal trigger for this test** — pass an option like `{ skipCausal: true }` to `ingest()`. The Frankenstein test is a Phase A regression test for entity resolution quality, not causal reasoning.
4. **Batch the parallelism** — ingest in groups of 3-4 instead of all 10 at once.

Option 3 is cleanest (separation of concerns). Option 2 is simplest.

### Uncommitted test fix

```
modified: platform/src/test/harness/causal-mcp.test.ts
```

Changes:
- Added `import path from 'node:path'`
- Changed assertion from `args.toContain('src/services/causal-mcp.ts')` (relative) to finding the arg containing `causal-mcp.ts` and asserting `path.isAbsolute()` — matching the production code that uses absolute paths because Claude Code ignores MCP `cwd`.

## Infrastructure Required

- **PostgreSQL** with pgvector + Apache AGE on port 5433 (Docker: `make up`)
- **Qdrant** on port 6335 (Docker: `make up`)
- **Ollama** on port 11434 with nomic-embed-text model (`ollama serve`)
- **Python ML services** on port 8000 (`cd ml-services && make ml`)

## Key Files

- `platform/src/test/harness/frankenstein.test.ts:36-38` — the parallel ingest that saturates ML service
- `platform/src/test/harness/causal-mcp.test.ts:54-57` — the updated absolute path assertion
- `platform/src/pipeline.ts` — `ingest()` function, potential place for `skipCausal` option
- `platform/src/services/causal-trigger.ts` — conditional trigger logic
- `platform/src/services/causal-agent.ts` — MCP config, agent invocation

## Conventions

- No `Co-Authored-By` lines in commits
- Always run concrete acceptance checks before closing beads
- Test helpers in `src/test/setup.ts`: `testDb`, `createTestEntity()`, `createTestFact()`, etc.
- Infrastructure: PostgreSQL+AGE on 5433, Qdrant on 6335, Ollama on 11434, ML services on 8000
