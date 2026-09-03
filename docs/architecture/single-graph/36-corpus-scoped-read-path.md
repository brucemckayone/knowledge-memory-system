# 36 — Corpus-scoping the live reasoning read path (nmemo-asf.3, Phase 1.2)

Bead `nmemo-asf.3`. Scope (decided in session 002): the **Postgres reasoning read path only**.
Qdrant search, the ~39 analytics services, and Postgres RLS are explicitly OUT (tracked as follow-ups:
`nmemo-4h3` the deeper fail-closed GUC+RLS project; `nmemo-81k`/`nmemo-mdc`/`nmemo-cki` isolation).

## 1. What was broken

Reads on the live path ignored corpus. A reasoning query against corpus `qbio` could return entities,
facts, neighbours and causal chains from `arxiv-nlp` or `default` — a correctness bug independent of any
retrieval strategy. The only corpus-correct query fn (`recallEntitiesFused`) was unwired (that is
`nmemo-asf.4`).

## 2. What shipped (three increments, one commit)

**Increment 1 (built in session 002):** `corpusId` flows `/api/reason/query` (body `{question, corpusId?}`)
→ `invokeReasoningAgent({corpusId})` → `getMcpConfigPath('reasoning_agent', {corpusId})` sets
`MNEMO_CORPUS_ID` in the per-actor MCP config env (a per-corpus config filename suffix avoids concurrent
clobber) → `resolveContext().corpusId`. So `context.corpusId` reaches the read tools.

**Increment 2:** the reasoning read tools now USE `context.corpusId`. Each helper took an **optional**
`corpusId?: string | null` and applies the filter **only when provided**, so every other caller stays
unscoped exactly as before (no tsc fan-out). Tools wired in `causal-agent.ts::_handleToolCallInner`:

| tool | helper | how scoped |
| --- | --- | --- |
| `query_entity_facts` | `getEntityFacts` (facts.ts) | new `corpusId?`; `AND corpus_id = $x` on all 3 branches (drizzle drops the `undefined` term) |
| `query_entity_neighbours` | `findConnectedEntities` → `traverseFromEntities` (graph.ts) | already accepted `corpusId`; now passed `context.corpusId` |
| `search_similar_entities` | `findSimilarEntities` (entities.ts) | `context.corpusId ?? toolInput.corpus_id`; helper already filters (defaults `'default'`) |
| `get_causal_history` | `getEntityCausalHistory` (causal.ts) | new `corpusId?`; scopes the events query (edges follow the scoped event ids) |
| `trace_causes` | `traceCauses` (causal.ts) | new `corpusId?`; scopes the CTE **base** (`ce.corpus_id`) **and** recursive **parent** (`parent.corpus_id`) so a chain cannot cross corpora. `projectTrajectory` scoped symmetrically (shared `TraceOptions`) |
| `recall_via_graph` | `recallViaGraph` → `expandFromAnchors` → `traverseFromEntities` (graph-fallback.ts) | new `corpusId?` threaded through; seed `findSimilarEntities` scoped too. Its `searchMemoriesByUnit` flat search = Qdrant = OUT OF SCOPE |

`search_memories` / `get_memory_text` are Qdrant — left unchanged (payload carries no `corpus_id`).

**Increment 2b — the prerequisite write-path bug (found during increment 3, fix approved in session 003).**
The fact→causal-event mirror `createCausalEvent` (facts.ts, application code — "not via triggers") never
set `corpus_id`, so serial-arm causal events took the column default `'default'` regardless of the fact's
corpus. Verified on `cognitive_test`:

| `causal_events.corpus_id` | fact's corpus | rows |
| --- | --- | --- |
| qbio | qbio | 6955 (correct) |
| dal-cv | dal-cv | 2565 (correct) |
| dal-nlp | dal-nlp | 1028 (correct) |
| **default** | **arxiv-nlp** | 2863 (mis-stamped) |
| **default** | **arxiv-cv** | 2852 (mis-stamped) |
| **default** | **dal-nlp** | 1584 (mis-stamped) |

The epoch/promotion path stamps correctly; the serial path did not. Without the fix the causal read-scoping
above is inert/wrong on existing data (an `arxiv-nlp` causal query returns zero; a `default` one leaks
arxiv). Fix: `createCausalEvent` now **requires** `corpusId` and stamps it; all three callers (create,
expire, invalidate) pass the fact's corpus (expire/invalidate now select `corpus_id`). **Forward-only** —
the ~7,300 existing mis-stamped rows are backfilled by follow-up **`nmemo-asf.10`** (which must first drop
the `trg_corpus_immutable` BEFORE-UPDATE trigger from migration 052, or the UPDATE is rejected).

**Increment 3 — proof.** `platform/src/test/tools/corpus-isolation-probe.ts` (deterministic, no Claude,
self-cleaning scratch corpora `_iso_probe_a`/`_iso_probe_b`). Seeds a same-named alpha entity with an
**identical embedding** in both corpora (so only the corpus filter — not similarity — can separate them),
a 3-entity `influences` chain per corpus, and a deliberate **cross-corpus poison** causal edge (B's event1
→ A's event2). 20/20 assertions PASS: every scoped helper returns only the requested corpus, refuses the
wrong corpus, and (where supported) returns both under `corpusId=null`; `traceCauses` includes the poison
event under `null` but refuses it under corpus A — proving the parent filter, not the data shape, is what
isolates. Also asserts the mirror now stamps the fact's corpus. tsc held at the 69-error baseline throughout.

## 3. Limits / follow-ups

- **Causal reads are correct only on newly-written data until `nmemo-asf.10` backfills** the existing rows.
- **`findSimilarEntities` has no cross-corpus mode** — it defaults `corpusId` to `'default'`, so an
  unscoped reasoning query against a non-default corpus still under-returns from this one helper. Aligning
  it with the `null = every corpus` convention (as `getEntityFacts`/`traverseFromEntities` use) is a
  separate change.
- **Out of scope, unchanged:** Qdrant corpus predicate, the analytics services, RLS/GUC fail-closed
  (`nmemo-4h3`). This pass gives the read layer `corpusId`, which RLS would need first.
- `recallEntitiesFused` (the proven two-signal fusion) is still unwired — `nmemo-asf.4`.
