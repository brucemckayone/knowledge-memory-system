# Integrations layer — canonical design

**Status:** initial fill, 2026-05-26 (bead `nmemo-2yv.110`).
**Discovered from:** Review #12 + cross-feature synthesis (`31-review-cycle-synthesis.md`).

---

## 1. Overview

The Integrations layer is the three platform-side modules that talk to systems outside the Node process. Each one is a boundary; each one has non-trivial cross-cutting design that previously lived only in code comments + Makefile targets:

| Module | File | Talks to | Wire protocol |
|---|---|---|---|
| **ml-client** | `src/services/ml-client.ts` | Python ML services FastAPI | HTTP/JSON over POST |
| **qdrant.ts** | `src/services/qdrant.ts` | Qdrant vector DB | HTTP/JSON via `@qdrant/js-client-rest` |
| **pi-agent-bridge** | `src/services/pi-agent-bridge.ts` | Inbound from Python ML services | HTTP/JSON + SSE over `/run` |

This doc captures the invariants that the May 2026 review cycle revealed were undocumented (port collisions, retry policy rationale, dimension lifecycle, WRITE_TOOLS coupling). New boundaries that join the Integrations layer add a row to §2 + a contract section in §5–§7 in the same PR.

## 2. Process topology + port table

The platform runs on the host alongside ml-services; only Postgres and Qdrant are dockerised (per the project's `feedback_platform_on_host` convention). The processes that come up in `make dev-all`:

| Process | Default port | Long-running | Env var | Started by | Notes |
|---|---|---|---|---|---|
| **Platform** (Hono HTTP) | 3000 | Yes | `PORT` | `npm run dev` / `make dev-all` | The TS app; serves `/api/*` routes. |
| **Pi bridge HTTP** | 3099 | Yes | `PI_BRIDGE_PORT` | `make dev-all` (separate Node process) | In-process tool dispatcher consumed by ml-services' `PiBridgeProvider`. |
| **ml-services FastAPI** | 8000 | Yes | derived from `ML_SERVICES_URL` | `make ml` | Python uvicorn; embedding, extraction, agents. |
| **Postgres + AGE + pgvector** | 5433 | Yes (docker) | `DATABASE_URL` | `make up` | Single canonical store; AGE for graph traversal. |
| **Qdrant** | 6335 | Yes (docker) | `QDRANT_URL` | `make up` | Vector store for raw memory text. |
| **Ollama** | 11434 | Yes (host) | env-implicit | host install | Embeddings via `nomic-embed-text`. |

**Port collisions to watch:** the platform port and the Pi bridge port must differ. Bead `nmemo-2yv.112` removed a long-standing default collision where both defaulted to 3001. Bead `.132`'s startup `validateStartup()` includes a `ports` validator that fails fast if `PORT === PI_BRIDGE_PORT`.

**MCP server** is NOT in this table — `graph-mcp.ts` is spawned per agent invocation by Claude Code (when `LLM_PROVIDER=claude`), not a long-running process. See [doc 30 — MCP transport](30-mcp-transport.md).

## 3. TS→Python→TS round-trip

The agentic loop crosses the boundary at least twice: TS (platform invoke) → Python (ml-services orchestration) → TS (Pi bridge tool dispatch) → back to Python → back to TS. The doc's purpose is to make this legible.

```d2
shape: sequence_diagram

api: "Platform /api/ingest"
pipeline: "pipeline.ts\ningest()"
agent: "causal-agent.ts\ninvokeReasoningAgent"
ml_http: "ml-services FastAPI\n/reasoning-patrol"
provider: "PiBridgeProvider\n(ml-services llm.py)"
bridge_http: "pi-agent-bridge.ts\n/run"
handle: "causal-agent.ts\nhandleToolCall"
db: "Postgres + Qdrant"

api -> pipeline: "POST { text }"
pipeline -> agent: "delta + memoryId"
agent -> ml_http: "POST { source_text, delta, mcp_config_path? }"
ml_http -> provider: "select PiBridgeProvider\n(LLM_PROVIDER=pi)"
provider -> bridge_http: "POST /run\n{ actor, system_prompt, tools }"
bridge_http -> handle: "tool calls in-process\n(no subprocess)"
handle -> db: "queries + writes"
db -> handle: "results"
handle -> bridge_http: "tool result JSON"
bridge_http -> provider: "SSE events\n(tool_call, tool_result, ...)"
provider -> ml_http: "final transcript"
ml_http -> agent: "{ ok, result, ... }"
agent -> pipeline: "patrol summary"
pipeline -> api: "200 { ingestId }"
```

**Two-language consequence:** an agent invocation has the platform process holding HTTP server-side state on TWO different ports simultaneously — port 3000 (the original `/api/ingest` request being held open) and port 3099 (the Pi bridge serving the inbound `/run` from Python). The platform process is BOTH the HTTP origin AND a downstream dependency in the same logical request. Process restart during an in-flight ingest aborts both halves.

## 4. Startup ordering

`make dev-all` brings up the components in this order:

1. **Docker compose** (`make up`) — Postgres + Qdrant. Required by everything downstream.
2. **Pi bridge** — starts the bridge HTTP server on `PI_BRIDGE_PORT`. Must be up before ml-services tries to call it.
3. **ml-services** (`make ml`) — Python FastAPI; `PiBridgeProvider.__init__` does an eager health check against `PI_BRIDGE_URL/health` to fail fast if the bridge is down. (See `ml-services/app/core/llm.py:PiBridgeProvider`.)
4. **Platform** (`npm run dev`) — last. Runs `validateStartup()` (bead `.132`) which probes:
   - Qdrant collection dimension matches `config.EMBED_DIMENSIONS` (wraps `ensureCollections`).
   - ml-services `/health` returns 200.
   - Transport health: when `LLM_PROVIDER=pi`, GET `pi-agent-bridge/health`; when `=claude`, the MCP probe; `zai` skipped.
   - `PORT !== PI_BRIDGE_PORT`.

The rationale for "bridge first, ml-services second, platform last": the bridge has no upstream dependencies and is the simplest component to start; ml-services needs the bridge to handshake; the platform needs both to be functional before it can validate them at startup.

## 5. ml-client.ts contract

The TypeScript side of the platform→Python boundary. Five public functions: `embed`, `extractEntities`, `extractRelationships`, `generateJson`, `health`.

### Endpoint surface

| Function | Endpoint | Body shape | Response |
|---|---|---|---|
| `embed(text, model?)` | `POST /embed` | `{ text, model }` | `{ vector, model, dimensions }` |
| `extractEntities(text, validTypes?, knownEntities?, contextSnippets?)` | `POST /extract-entities` | `{ text, valid_types?, known_entities?, context_snippets? }` | `{ entities[], text_length }` |
| `extractRelationships(content, entities, validPredicates?, knownFacts?, contextSnippets?)` | `POST /extract-relationships` | `{ content, entities, valid_predicates?, known_facts?, context_snippets? }` | `{ relationships[], source_content_hash, used_fallback }` |
| `generateJson(prompt)` | `POST /chat` (with JSON-only system prompt) | `{ message, system_prompt }` | parsed JSON of `response` field (fence-stripped) |
| `health()` | `GET /health` | n/a | `boolean` (caught — never throws) |

Optional params use conditional spread (`...(x ? { snake_case: x } : {})`) so omitted args don't appear in the JSON body at all.

### MlClientError shape

```ts
class MlClientError extends Error {
  readonly endpoint: string;     // e.g. '/embed'
  readonly status: number;       // HTTP status; 0 for network/timeout failures
  readonly detail: string;       // server error body OR 'Request timed out'
}
```

Callers wrap in `try/catch` when failure must not block the surrounding operation (e.g. `nameCandidatePatterns` falls back to `name=NULL`).

### Retry policy

- **Retryable status codes:** 502, 503, 504.
- **Attempts:** 3 (one initial + 2 retries).
- **Backoff:** linear `[500, 1000]ms` between attempts. No jitter (single-client, single-server topology — no thundering-herd concern).
- **No retry on:** non-retryable status codes (4xx, 500, anything not in the set), `DOMException AbortError` (timeout — caller's intent was "give up after N ms"), all errors after the 3rd attempt.
- **Retry on network errors** (fetch rejection): yes, with the same backoff. Treated equivalently to retryable status — transient ISP / process-restart conditions.
- **Why no 429:** ml-services has no rate-limiter; 429 would surface only if the underlying provider (e.g. Claude/Ollama) rate-limits, which the ml-services layer should handle. Tracked separately if it becomes a real issue.

Test coverage: `src/test/services/ml-client.test.ts` (bead `.115`) with fake timers + spy on global `fetch` — hermetic, no ML_SERVICES_URL dependency.

### Timeouts

| Function | Timeout | Reason |
|---|---|---|
| `embed`, `extractEntities`, `extractRelationships` | 600s | LLM extraction can be slow on large texts; this is the absolute backstop. |
| `generateJson` | 60s | Used for small structured-output tasks (pattern naming); fast LLM. |
| `health` | 5s (independent of mlFetch) | Health checks are gates; they need fast failure. |

## 6. qdrant.ts contract

The TypeScript side of the platform→Vector DB boundary. The COLLECTIONS namespace holds collection names; only `memories` exists today.

### Public surface

`ensureCollections`, `storeMemory`, `updateVector`, `searchMemories`, `updatePayload`, `getMemory`, `getMemoryVectors`, `clearMemories`, `checkQdrantHealth`.

### Dimension invariant

The `memories` collection's vector size MUST equal `config.EMBED_DIMENSIONS` (currently 768 for `nomic-embed-text`). `ensureCollections` enforces this:

- If the collection does NOT exist → create at `config.EMBED_DIMENSIONS`.
- If the collection exists with the wrong size → throw a descriptive `Error` naming both sizes + the remediation (revert `EMBED_MODEL` or run `clearMemories()`).

This is the "dimension-drift trap" from review #12/F12. Hitting it at write time (without the check) would silently corrupt vectors. Bead `.121` wired `ensureCollections` into platform startup so the trap fires at boot, not on first write. Bead `.114` added integration test coverage including the dim-mismatch case.

### Why no retry

The Qdrant client (`@qdrant/js-client-rest`) is talking to a single local docker container. Transient failures are a config bug (Qdrant down, port collision, dim mismatch) or a docker restart — none of which retry-and-backoff can recover from cleanly. Throwing on the first failure surfaces the problem immediately; the platform's startup validator (`.132`) catches the dim case; the operator restarts the container for the rest.

This is the deliberate divergence from `ml-client`'s retry policy. ml-services failures are often transient (LLM provider hiccup, network); Qdrant failures are almost always structural.

### Centroid-stability sort

`getMemoryVectors(ids)` returns a `Map<string, number[]>` sorted by id. Qdrant's `retrieve` does NOT guarantee response ordering (segment-internal); floating-point addition is not associative; an unsorted iteration would yield slightly different centroids on each call. `graph-meta`'s entity-centroid computation depends on byte-stable snapshots, so the sort lives at the wrapper boundary. Removing the sort regresses centroid byte-stability — verified by the `.114` integration test (passes three ids in shuffled order, asserts iteration matches sort).

## 7. pi-agent-bridge.ts contract

The TypeScript side of the Python→TS boundary. Long-running HTTP server on `PI_BRIDGE_PORT`. Exposes three endpoints; consumed by ml-services' `PiBridgeProvider`.

### HTTP endpoints

| Endpoint | Method | Purpose | Response |
|---|---|---|---|
| `/health` | GET | Process-liveness probe | `{ status: 'ok', service: 'pi-agent-bridge', tools: number, version }` |
| `/tools` | GET | Tool catalogue | `{ tools: GRAPH_TOOLS[] }` |
| `/run` | POST | Run an agent loop | SSE stream of `tool_call` / `tool_result` / `complete` events |

### Tool-dispatch contract

`/run` accepts an agent spec (system prompt, allowed tools, actor) and runs the agentic loop in-process. Tool calls dispatch through `handleToolCall` in `causal-agent.ts` — the SAME function the MCP server calls. Both transports inherit the same write-tool serialisation, audit context, and error wrapping (see [doc 30 §6](30-mcp-transport.md)).

### Write-tool serialisation

Bead `nmemo-2yv.127` moved the WRITE_TOOLS set + queue out of the bridge and into the shared dispatcher. The bridge now sets `executionMode: 'parallel'` unconditionally; serialisation happens in `handleToolCall` via the module-scoped `writeQueue` promise. Both transports inherit. See doc 30 §6 for the rationale + fail-open semantics.

### Timeout race semantics

When `/run` exceeds its budget, the bridge aborts the underlying Pi `AgentSession` and disposes the resource (bead `.116`). The race shape: `Promise.race([agentPromise, timeoutPromise])` where the timeout branch can abort + dispose. Resource creation hoists out of the agent IIFE so both branches have a reference. The dispose path uses a `timedOut` flag + fire-and-forget abort chain to avoid double-dispose and to keep the response unblocked on cleanup. See `causal-agent.ts:nmemo-2yv.116` for the full pattern.

### Input validation

Currently thin. Bead `nmemo-2yv.117` (halted with PREMISE_DRIFT in May 2026 — needs re-lock) proposes: derive actor whitelist from `Actor` type, clamp timeout, cap `readBody` size.

## 8. Health & observability

The platform exposes a `/health` endpoint that composes per-boundary checks. Bead `nmemo-2yv.111` wired this end-to-end (previously dead code):

```ts
// /health composes (via Promise.all):
//   - checkDatabaseHealth() — Postgres reachable + AGE loaded
//   - ml.health()           — ml-services /health 200
//   - checkQdrantHealth()   — Qdrant getCollections succeeds
// Aggregates to { ok, db, ml, qdrant, durationMs } — 503 on any false.
```

Two distinct probe surfaces:

- **`/health`** (runtime state) — current liveness of each boundary. Operators poll this. False reading on any boundary indicates a runtime regression (a service died, network dropped, etc.).
- **`validateStartup()`** (initial state) — bead `.132`. Runs once at platform boot before `serve()`. Stricter than `/health` (e.g. checks the Qdrant dim against `config.EMBED_DIMENSIONS`, not just liveness). Failures abort boot. Operators see the validation failures in logs, not via HTTP.

Both gates are needed: `/health` catches degradation while running; `validateStartup` catches misconfiguration at boot. Composing one into the other was rejected (bead `.132` Decision section) because a passing `/health` line written yesterday tells you nothing about today's misconfig.

## 9. Cross-references

- [doc 30 — MCP transport](30-mcp-transport.md) — the OTHER transport (`LLM_PROVIDER=claude`); same `handleToolCall`, different boundary mechanism.
- [doc 25 — cross-cluster generator](25-cross-cluster-generator.md) — consumer of `qdrant.ts` (raw source vectors for the causal agent).
- [doc 28 — test data snapshots](28-test-data-snapshots.md) — snapshot infrastructure that depends on `qdrant.ts`'s `clearMemories` + dim invariant.
- Beads `.110` (this doc), `.111` (`/health` compose), `.112` (port collision), `.114` (qdrant test coverage), `.115` (ml-client test coverage), `.116` (timeout race fix), `.121` (Qdrant dim validation at startup), `.127` (write-tool serialisation centralised), `.132` (startup validation framework).
