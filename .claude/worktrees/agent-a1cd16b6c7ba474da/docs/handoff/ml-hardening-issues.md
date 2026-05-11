# ML Service Hardening & Outstanding Issues

**Date:** 2026-04-07
**Branch:** `feat/sparse-truth-graph`
**Test:** Frankenstein 10-chunk regression (`platform/src/test/harness/frankenstein.test.ts`)

---

## What Was Done

### Problem

The Frankenstein test fires 10 parallel `ingest()` calls via `Promise.allSettled()` (line 36). Each ingest triggers 3-5+ ML service requests:

| Phase | Endpoint | Count |
|-------|----------|-------|
| store | `/embed` | 10 |
| extract | `/extract-entities` | 10 |
| extract | `/extract-relationships` | 10 |
| ref matching | `/embed` (tier 3) | 10-30 |
| causal | `/causal-reason` | 2-3 triggered |
| **Total** | | **42-63** |

All of these hit the single-worker ML service (`uvicorn`, port 8000) which had a 20-thread pool and no backpressure. Requests piled up, threads saturated, timeouts cascaded. The test failed at 600s (300s timeout x2 retries).

Additionally, `ml-services/app/causal_reason.py:140` called `llm_client.generate()` **synchronously** (no `asyncio.to_thread()`), blocking the event loop entirely for up to 600s.

### Solution: Bounded Work Queues

Replaced the raw `asyncio.to_thread()` pattern with two `ResourcePool` instances — proper producer-consumer queues.

```
Request → pool.submit(fn) → [asyncio.Queue(maxsize=100)] → Worker tasks (N) → asyncio.to_thread(fn) → Future → Response
                                    ↑                            ↑
                               backpressure                 thread allocation
                            (buffer absorbs burst)       (only N concurrent jobs)
```

**New file:** `ml-services/app/core/concurrency.py`

- `ResourcePool` class: bounded `asyncio.Queue`, N long-lived worker coroutines, `asyncio.Future` per request
- `ollama_pool`: 4 workers, buffer=100 (Ollama embedding calls)
- `llm_pool`: 6 workers, buffer=100 (Claude CLI subprocess calls)
- `QueueFullError` → HTTP 503 if buffer overflows (safety valve, never fires under normal load)
- All 14 endpoint files migrated from `await asyncio.to_thread(fn, ...)` to `await pool.submit(fn, ...)`

**Config (env vars):** `ML_OLLAMA_WORKERS`, `ML_OLLAMA_BUFFER`, `ML_LLM_WORKERS`, `ML_LLM_BUFFER`, `ML_THREAD_POOL_SIZE`, `ML_WORKERS`

**Health endpoint** (`GET /health`) now reports pool stats: active, queued, total_pending, workers, buffer_size.

### Result

| Metric | Before | After |
|--------|--------|-------|
| Test duration | 600s (timeout, fail) | 154s (pass) |
| HTTP 503s | N/A (never responded) | 0 |
| `fetch failed` errors | Yes (causal agent) | 0 |
| Quality targets | N/A | All met (0 dupes, 0% mismatch) |

### Files Changed

| File | Change |
|------|--------|
| `ml-services/app/core/concurrency.py` | **NEW** — ResourcePool, QueueFullError, pool singletons |
| `ml-services/app/causal_reason.py` | Bug fix (was blocking event loop) + use llm_pool |
| `ml-services/app/embed.py` | Use ollama_pool |
| `ml-services/app/extract_entities.py` | Use llm_pool |
| `ml-services/app/relationships.py` | Use llm_pool |
| `ml-services/app/classify.py` | Use llm_pool |
| `ml-services/app/summarize.py` | Use llm_pool |
| `ml-services/app/chat.py` | Use llm_pool |
| `ml-services/app/reader.py` | Use llm_pool |
| `ml-services/app/extract_task.py` | Use llm_pool |
| `ml-services/app/extract_task_enhanced.py` | Use llm_pool |
| `ml-services/app/parse_transcript.py` | Use llm_pool |
| `ml-services/app/compare_predicates.py` | Use llm_pool |
| `ml-services/app/check_contradiction.py` | Use llm_pool (3 debate calls inlined) |
| `ml-services/app/main.py` | Health stats + configurable thread pool |
| `ml-services/Dockerfile` | `--workers ${ML_WORKERS:-2}` |
| `docker-compose.yml` | 6 concurrency env vars added |

---

## Outstanding Errors

The Frankenstein test passes but produces these errors in the logs. None are caused by the hardening work.

### Issue 1: Platform Docker Container Crash

**Severity:** Medium (doesn't block tests, blocks Docker platform service)

**Error:**
```
Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/app/src/index.ts'
```

**Where:** `platform-1` container startup. The Dockerfile CMD is `tsx watch src/index.ts` and `package.json` has `"dev": "tsx watch src/index.ts"`, but no `platform/src/index.ts` file exists in the repo.

**Impact:** Platform Docker container doesn't start. Tests run against host services so this doesn't block the Frankenstein test.

**Fix:** Create `platform/src/index.ts` or update Dockerfile/package.json to point to the correct entry file.

### Issue 2: AGE `cypher()` Function Not Found

**Severity:** High (causal graph is non-functional)

**Errors:**
```
WARNING: sync_causal_event_to_graph failed: function cypher(unknown, unknown) does not exist
WARNING: sync_causal_edge_to_graph failed: function cypher(unknown, unknown) does not exist
ERROR:   function cypher(unknown, unknown) does not exist
         STATEMENT: SELECT * FROM cypher('knowledge_graph', $$ MATCH ... $$)
```

**Where:** Three places:
1. **Trigger `sync_causal_event_to_graph`** — fires on INSERT to `causal_events` (defined in `002_causal_graph.sql`)
2. **Trigger `sync_causal_edge_to_graph`** — fires on INSERT to `causal_edges` (defined in `002_causal_graph.sql`)
3. **Direct queries in `platform/src/services/graph.ts`** — `executeCypher()` function, called by the causal agent's MCP tools (`query_entity_neighbours`)

**Root cause:** Apache AGE requires `LOAD 'age'` per PostgreSQL session before `cypher()` is available. The current Docker postgres setup:

- `docker/postgres/init-age.sql` runs `LOAD 'age'` but only during initial container creation
- `docker/postgres/Dockerfile` does **not** set `shared_preload_libraries = 'age'`
- `platform/src/services/graph.ts` does **not** call `LOAD 'age'` before querying
- PL/pgSQL triggers use `EXECUTE` with dynamic SQL containing `cypher()` — this requires the library loaded in the session even if `shared_preload_libraries` is set (see CLAUDE.md AGE gotchas)

**Impact:** The AGE graph is non-functional at runtime:
- Causal events/edges don't sync to the AGE graph (triggers fail silently with WARNING)
- The causal agent can't traverse the knowledge graph via MCP tools (queries return ERROR)
- All relational data in PostgreSQL tables is fine — only the AGE traversal index is broken

**Fix (two parts):**

1. Add `shared_preload_libraries` to the postgres startup in `docker-compose.yml`:
   ```yaml
   postgres:
     command: postgres -c shared_preload_libraries='age'
   ```

2. Add `LOAD 'age'` per-connection in the platform's database module. Either:
   - A connection pool `afterCreate` hook that runs `LOAD 'age'` + sets the search path
   - Or a one-time call at app startup on the connection pool

   This is needed because `EXECUTE` in PL/pgSQL triggers requires the library loaded even with `shared_preload_libraries`.

### Issue 3: Test Cleanup FK Violation

**Severity:** Low-Medium (stale data may accumulate between test runs)

**Error:**
```
ERROR: update or delete on table "facts" violates foreign key constraint "causal_events_fact_id_fkey" on table "causal_events"
STATEMENT: DELETE FROM facts
```

**Where:** `deleteFromTables()` in `platform/src/test/setup.ts:152`, called from the Frankenstein test's `beforeAll` hook.

**Root cause:** The test calls `deleteFromTables('memory_entities', 'entity_aliases', 'facts', 'entity_merges', 'entities')`, but the `orderedTables` array in `deleteFromTables()` (line 154) does not include `causal_edges`, `causal_events`, or `causal_patterns`. These Phase B tables have foreign keys to `facts`, so `DELETE FROM facts` fails.

**Fix:** Add the three causal tables to `orderedTables` in `platform/src/test/setup.ts`, before `facts`:

```typescript
const orderedTables = [
  'memory_chunks',
  'memory_entities',
  'entity_aliases',
  'entity_merges',
  'contradiction_reviews',
  'causal_edges',      // ← add (FK to causal_events)
  'causal_events',     // ← add (FK to facts)
  'causal_patterns',   // ← add
  'facts',
  'entities',
  // ... rest unchanged
];
```

### Issue 4: Duplicate Entity Alias

**Severity:** Low (data is correct, just noisy)

**Error:**
```
ERROR: duplicate key value violates unique constraint "entity_aliases_entity_id_alias_key"
DETAIL: Key (entity_id, alias)=(..., United States) already exists.
```

**Where:** Entity resolution during `extract()`, when inserting aliases for resolved entities.

**Root cause:** Two concurrent ingests resolved the same entity and both tried to insert the same alias. The INSERT doesn't use `ON CONFLICT`.

**Impact:** None — the alias already exists. The error is caught and doesn't crash the ingest. Just log noise.

**Fix:** Add `ON CONFLICT (entity_id, alias) DO NOTHING` to the alias INSERT statement in the entity resolution code.

### Issue 5: LLM JSON Parse Failure

**Severity:** Low (fallback works correctly)

**Error:**
```
LLM relationship extraction failed: JSON parsing failed: Could not parse JSON from response
```

**Where:** `ml-services/app/relationships.py` during `/extract-relationships`. The LLM returned valid JSON followed by trailing text ("That would be ...") which broke the parser.

**Impact:** The endpoint falls back to regex-based `quick_extract()` for that chunk. One chunk gets fewer relationships. Test still passes.

**Fix:** Improve `extract_json()` in `ml-services/app/core/llm.py` to extract the first complete JSON structure from mixed text (find first `[` and its matching `]`).

---

## Priority Order

| # | Issue | Impact | Effort |
|---|-------|--------|--------|
| 1 | AGE `shared_preload_libraries` + per-connection `LOAD` | High — causal graph non-functional | Small |
| 2 | Test cleanup FK order | Medium — stale test data | Trivial |
| 3 | Duplicate alias ON CONFLICT | Low — log noise | Trivial |
| 4 | Platform Docker entry point | Medium — container broken | Small |
| 5 | JSON parse robustness | Low — fallback works | Small |
