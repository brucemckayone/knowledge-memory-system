# Phase 0 Smoke-Test Findings — Reasoning Agent

**Date:** 2026-04-27
**Branch:** `feat/reasoning-agent`
**Bead:** `nmemo-dey.1` (Phase 0 — Smoke-Test Reasoning Agent)
**Playbook:** `docs/architecture/truth-graph/11-smoke-test-reasoning-agent.md`
**Tester:** Claude Code (Opus 4.7) on behalf of bruce.mckay@hexagon.com

## Headline

The reasoning agent's invocation chain works end-to-end. Patrol mode and query mode both completed against live graph data inside their timeouts, produced coherent markdown reports, and persisted rows to `reasoning_reports`. The agent cited real entities/rules from the graph in its answers.

But the smoke surfaced **five real bugs** that should be fixed before Phase 1 (`nmemo-w4j` is already shipped, so these become Phase 2 prerequisites or Phase 0.2 fixes via `nmemo-dey.2`).

## Environment / Pre-flight

All services up:

| Service | Endpoint | Status |
|---|---|---|
| Platform API | `http://localhost:3001/health` | `{status:"ok", db:true}` |
| ML Service | `http://localhost:8000/health` | phase 6, claude provider, 16 endpoints |
| Postgres + AGE | `localhost:5433` | role `cognitive`, db `cognitive` |
| Qdrant | `http://localhost:6335/collections` | collections: `contexts`, `memories`, `memories_hybrid_search_test` |
| Ollama | `http://localhost:11434/api/tags` | `nomic-embed-text:latest` (137M, F16) |
| Claude CLI | `claude --version` | `2.1.119 (Claude Code)` |

Graph stats at start:
```json
{ "entities": 283, "facts": 910, "causal_events": 926, "causal_edges": 135 }
```
Healthier than the doc's baseline of ~159 / ~290.

## Test Results

### Test 1 — Infrastructure Health: ✅ PASS

All four health endpoints returned 200. Stats exceed doc thresholds (entities>150, facts>250).

### Test 2 — MCP Server Standalone: ✅ PASS (with caveat)

`checkCausalMcpHealth()` (driven via `pnpm vitest run causal-integration.test.ts -t "causal MCP server starts"`) returned `ok=true`, listed **32 tools**, completed in 1.31s. Doc said 25 — gap is the Phase 1 audit-trail tools added since the doc was written (`get_fact_history`, `get_edge_history`, `expire_causal_edge`, `revise_causal_edge`, `restore_fact`, `update_fact_confidence`, `get_reasoning_targets` etc).

Spawn used `npx tsx src/services/causal-mcp.ts` with `shell: true` on Windows (`causal-agent.ts:2006`). No spawn errors.

**Caveat — `/api/mcp-health` is not a real endpoint.** The playbook tells the operator to `curl http://localhost:3001/api/mcp-health` and expect `{ ok, tools }`. That route isn't registered in `platform/src/index.ts`. The function `checkCausalMcpHealth` is exported from `causal-agent.ts:1998` and used only by the integration test. Either add the HTTP wrapper or correct the doc. See **Finding F1** below.

### Test 3 — Reasoning Agent Patrol Mode: ✅ PASS (with bugs)

`POST /api/reason` (no body) returned in **205s** with:
```json
{
  "triggered": true,
  "result": "Perfect! I've completed a comprehensive patrol reasoning pass on the knowledge graph. ...",
  "durationMs": ~205000
}
```

The agent's report claimed to have:
- Identified 3 high-need neighbourhoods (`nmemo-w4j`, `feat/sparse-truth-graph`, `feat/reasoning-agent`)
- Expired one self-referential fact (`94304c20...`, predicate `unblocks`)
- Created one new causal edge with 4 source references
- Updated 3 entity summaries
- Invalidated one stale uncommitted_state fact

DB inspection after run:
- 3 new rows in `reasoning_reports` from a single invocation (timestamps within 22 seconds of each other) — see **Finding F2**.
- Entities referenced have rows in `entity_meta`, but `last_reasoned_at` is still NULL on every row — see **Finding F3**.

### Test 4 — Reasoning Agent Query Mode: ✅ PASS

`POST /api/reason/query` with `{"question":"Which MISRA C++ 2023 rules relate to pointer arithmetic?"}` returned in **134s**.

The answer cited specific rule IDs that exist in the graph (`M5-0-19`, `M5-0-18`, `M5-0-17`, `M5-0-21`, `M4-10-1`, `M4-10-2`) and correctly observed that **MISRA C++ 2023 is not in the graph** — only `:2008` and `AUTOSARC++14`. That's a substantive, graph-grounded answer with no hallucinated rule names.

The agent ended its response with `**Reasoning Report Saved**: acf08192-6c2d-4a52-a14f-3984b8d57ee5`. Report exists in DB.

The bad-C++-file test (`platform/test-bad-code.cpp`) was skipped — the pointer-arithmetic question already exercises query mode end-to-end and the file's not present on this branch.

### Test 5 — Report Retrieval: ✅ PASS (after correcting the doc's SQL)

Doc query uses `jsonb_array_length(entity_ids)` but `entity_ids` is `uuid[]`, not `jsonb`. `cardinality(entity_ids)` is the correct function. See **Finding F4**.

After correction, 5 rows visible from this session:

| id | mode | question (60 chars) | n_entities | n_facts | created_at |
|---|---|---|---|---|---|
| acf08192… | query | Which MISRA C++ 2023 rules relate to pointer arithmetic?  | 0 | 0 | 10:24:05 |
| 781cb46f… | query | Which MISRA C++ 2023 rules relate to pointer arithmetic?  | 1 | 0 | 10:23:56 |
| fc845ea3… | query | Process project management update: closing nmemo-0dx.3…   | 0 | 0 | 10:23:55 |
| a85dcd74… | query | Which MISRA C++ 2023 rules relate to pointer arithmetic?  | 3 | 2 | 10:23:46 |
| fe12252b… | query | Process project management update: closing nmemo-0dx.3…   | 3 | 3 | 10:23:44 |

The `Process project management update` rows weren't issued by the smoke test — they appear to be auto-triggered from beads sync writing to `interactions.jsonl`. See **Finding F5**.

## Findings

### F1 — `/api/mcp-health` documented but not implemented

**Severity:** doc/test mismatch (low)
**Files:** `docs/architecture/truth-graph/11-smoke-test-reasoning-agent.md:124`, `platform/src/index.ts`
**Detail:** Playbook step says `curl http://localhost:3001/api/mcp-health`. No such route. `checkCausalMcpHealth()` exists in `causal-agent.ts:1998` and the integration test exercises it.
**Fix options:**
1. Add a 6-line route in `platform/src/index.ts` that calls `checkCausalMcpHealth()` and returns the result.
2. Drop the curl example, leave only the in-process test.
**Recommendation:** Add the route. Smoke tests benefit from a live HTTP probe of MCP that anyone can `curl` without spinning up vitest.

### F2 — Reasoning agent saves multiple `reasoning_reports` per invocation

**Severity:** medium — clutters retrieval, makes "the report for run X" ambiguous
**Files:** `ml-services/app/reasoning_agent.py` (system prompt), `platform/src/services/causal-agent.ts:644` (tool description)
**Detail:** Patrol mode produced 3 `reasoning_reports` rows from a single `POST /api/reason`. Two had `n_entities=3`, the third `n_entities=0`. Query mode produced 3 rows for the MISRA question (n=3, n=1, n=0).
**Hypothesis:** The system prompt encourages saving a report at the end of each phase (SURVEY → INVESTIGATE → REASON & ACT → REPORT) rather than once at the very end. The `n_entities=0` tail rows look like the agent's final "wrap-up" save with no remaining entity context.
**Fix:** Either (a) tighten the prompt to call `save_reasoning_report` exactly once per pass, or (b) make `save_reasoning_report` idempotent / replacing-by-mode+question.

### F3 — `entity_meta.last_reasoned_at` is never set despite `save_reasoning_report` UPDATE

**Severity:** high — breaks patrol cooldown / target rotation
**Files:** `platform/src/services/causal-agent.ts:1615-1620`
**Detail:** Handler:
```ts
if (entityIds.length > 0) {
  await db.execute(sql`
    UPDATE public.entity_meta SET last_reasoned_at = NOW()
    WHERE entity_id = ANY(${entityIds}::uuid[])
  `);
}
```
After this session: `SELECT COUNT(*) FROM entity_meta WHERE last_reasoned_at IS NOT NULL` → **0**. The 3 entity_meta rows for the patrol's referenced entities exist but `last_reasoned_at` is NULL on all of them.
Manual UPDATE with the same SQL inside `psql` updates 3 rows correctly. So either drizzle's array-binding doesn't roundtrip a JS `string[]` as `text[]` for the `::uuid[]` cast, or the UPDATE runs against a different schema (the AGE search_path gotcha — tx-level `search_path = ag_catalog, public, "$user"` could be looking at a shadow table rather than `public.entity_meta`, although the SQL is fully-qualified to `public.entity_meta` so this is unlikely).
**Impact:** `get_reasoning_targets` (`causal-agent.ts:1558`) scores entities by `CASE WHEN em.last_reasoned_at IS NULL THEN 20 …`. With `last_reasoned_at` permanently NULL, every entity scores 20 forever — patrol re-targets the same handful every run, never rotates.
**Fix:** Add a debug log to confirm which branch is the failure (try `db.execute(sql\`SELECT 1\`)`-style sanity check, then a logged copy of the actual UPDATE), or rewrite using drizzle's typed `update` builder (`db.update(entityMeta).set({lastReasonedAt: new Date()}).where(inArray(entityMeta.entityId, entityIds))`).

### F4 — Doc 11's verification SQL doesn't run

**Severity:** doc bug (low)
**Files:** `docs/architecture/truth-graph/11-smoke-test-reasoning-agent.md:198`
**Detail:** Query uses `jsonb_array_length(entity_ids)` but the column is `uuid[]`. Postgres errors: `function jsonb_array_length(uuid[]) does not exist`.
**Fix:** Replace with `cardinality(entity_ids)` (or `array_length(entity_ids, 1)`).

### F5 — Unsolicited reasoning runs from a third party

**Severity:** medium — unaccounted-for compute, ambiguous trigger source
**Detail:** `reasoning_reports` contains rows with question prefix `"Process project management update: closing nmemo-0dx.3 as duplicate of …"`. That text is the close-reason from `bd close nmemo-0dx.3` earlier in the same session. Nothing the smoke-test driver invoked uses that string.
**Hypothesis:** A background ingestion pipeline (probably reading `.beads/interactions.jsonl`) is firing `/api/reason/query` autonomously on every recorded bd interaction. That's expensive and probably unintended.
**Fix:** Identify the trigger (look for callers of `invokeReasoningAgent` or `POST /api/reason/query` in `platform/src` and `ml-services/app`), confirm whether it's wired on purpose, and either gate it behind a flag or scope it.

## Acceptance Criteria Status (`nmemo-dey.1`)

- [x] Findings doc committed → this file
- [x] All 5 tests run without subprocess errors → confirmed
- [x] Patrol mode creates at least one reasoning report → 3 reports created (F2 follow-up)
- [ ] Patrol mode updates `entity_meta.last_reasoned_at` → **fails (F3)**, blocks cooldown
- [x] Query mode answers a MISRA question with specific rule citations from the graph → confirmed (M5-0-19, etc.)
- [x] MCP health returns 25 tools → 32 tools (Phase 1 additions; doc threshold was conservative)
- [x] No tool name mismatches between prompt and implementation → confirmed (20/20 prompt-cited tools exist)

The acceptance criteria say bugs are either fixed here or filed as follow-ups. F3 is the only one that materially degrades behaviour; F1/F4 are doc fixes; F2 and F5 want investigation. All five become children of `nmemo-dey.2`.

## Side-effect: data left in DB

5 `reasoning_reports` rows from this session. Not cleaned up — they're useful as Phase 1 baseline (the doc says: "becomes the Level 4 end-to-end baseline for `TEST-E2E` (`bd show nmemo-klv.7`)").

The patrol's claimed data repairs (1 fact expired, 1 fact invalidated, 1 causal edge created, 3 entity summaries updated) were not independently verified — `entity_meta.last_reasoned_at` regression makes us mildly suspicious of "agent says it did" vs "DB says it did". Worth spot-checking in `nmemo-dey.2`.

## Related commits

- `a45b39a` — adds `get_fact_history` / `get_edge_history` + 4 write tools
- `8d63a4f` — adds `expireCausalEdge` / `reviseCausalEdge`
- `97bce0a` — reasoning agent system prompt: "READ HISTORY BEFORE YOU ACT"

These bring the tool count past the doc's 25-tool baseline.
