---
session: 002
date: 2026-09-02
project: nmemo — intent-adaptive retrieval & ingestion redesign (epic nmemo-asf)
status: in-progress
supersedes: 001
---
# Handover 002 — nmemo — Phase 1.1 provenance backbone DONE+committed; Phase 1.2 corpus-scoping started (increment 1 applied, uncommitted)

## Mission / goal
Program `nmemo-asf` (docs 30–35): redesign ingestion pulled by committed query capabilities, benchmark-gated,
with a provenance/lineage backbone. **The user steers deliberately and reviews at every decision point — do
NOT barrel into production changes; converge on findings, check in at forks, run the loop discipline
(pre-register → measure → prove → bank; prove deterministically before spending Claude).** This session:
(1) committed the Phase-2 query-intent set, (2) built + PROVED the entire Phase-1.1 provenance backbone, (3)
started Phase-1.2 corpus-scoping on the live read path.

## Current state — DONE + verified
Branch `feat/single-graph-retrieval`, HEAD **`90b5f4a`**. `cd platform && npx tsc --noEmit` baseline =
**69 errors** (compare, never "fix"); held at 69 through every edit this session (re-verified repeatedly).

**Phase 2 — intent set COMMITTED (bead `nmemo-asf.6` CLOSED):** commit `9542a1d`, doc 34. Final atomic set =
I1 point-lookup, I2 multi-hop, I3 temporal, I4 causal, I5 global; priority **I3>I1>I2>I4>I5**. User added one
framing point (recorded in doc 34): composite reasoning queries (causal trajectory, meta "why-is-X",
causal-chain failure-point, themes-of-cause-over-time) live in the **agent-composition layer over the five
primitives — NOT a sixth substrate**; deferred + flagged untested. Phase 3/4 beads created:
`nmemo-asf.7` (Phase 3 harness, I3/CronQA first, related to `nmemo-9qq`), `nmemo-asf.8` (Phase 4 I3 temporal
experiment, blocked by `.7` + `nmemo-9qq`).

**Phase 1.1 — provenance/lineage backbone DONE + committed (bead `nmemo-asf.2` CLOSED).** Design = doc 35.
Root cause found: the lineage substrate was already BUILT and dead on ONE server-side link —
`facts.source_memory_id` was never set (create_fact trusted the LLM to echo it), which no-op'd
`recordFactSource` (fact_sources empty) and made extract()'s `source_memory_id` re-query return zero rows
(fact_units empty). All 4 steps built + **PROVEN DETERMINISTICALLY** (no Claude, self-cleaning scratch corpus
`_prov_probe`), committed `e330501` (1a/1b/1c) + `90b5f4a` (1d):
- **1a serial** — `create_fact` stamps `source_memory_id` from harness-injected `context.memoryId` (env
  `MNEMO_MEMORY_ID` via getMcpEnv/getMcpConfigPath/invokeGraphAgent). Proof: `prov-probe.ts` (fact_sources +
  fact_units + offset round-trip).
- **1b epoch** — `promote()` derives `source_memory_id = windowPointId(source_id, chunk_index)` from the
  staged fact + writes fact_sources; epoch `store()` passes corpusId so fragments land in-corpus. Proof:
  `promote-probe.ts`.
- **1c fragments** — migration **059** (`source_document` + `fragment`; fragment.id = the deterministic Qdrant
  point id; parent_id = unit→window; char offsets; chunker_name+version), **applied to `cognitive_test`**;
  `store()` populates via `recordFragments`. Proof: `frag-probe.ts` (parent chain, transitive resolve,
  idempotent).
- **1d citation** — `services/provenance.ts::getFactCitation(factId)` joins fact_sources + (fact_units →
  fragment → source_document). Proof: `citation-probe.ts` (fact → source round-trip, offsets, right corpus).
- Point-id helpers extracted to leaf module **`services/point-ids.ts`** (re-exported from pipeline) to avoid a
  pipeline↔promotion import cycle. Follow-ups split to **`nmemo-asf.9`** (entity-mention offsets on the
  link_entity_to_memory tool schema; OPTIONAL full live epoch ingest) — NOT blockers.

**Phase 1.2 — corpus-scoping (bead `nmemo-asf.3` IN_PROGRESS), scope = "Postgres read path" (user chose).**
Grounded by a read-path survey (findings below). **Increment 1 APPLIED but UNCOMMITTED** (tsc 69, no behavior
change yet): `corpusId` now flows `/api/reason/query` (body `{question, corpusId?}`) → `invokeReasoningAgent`
(new `corpusId?` param) → `getMcpConfigPath('reasoning_agent', {corpusId})` sets `MNEMO_CORPUS_ID` (per-corpus
config filename suffix `.k<corpus>` added to avoid concurrent clobber) → `resolveContext().corpusId`. So
`context.corpusId` is now populated for the reasoning read tools — but **no read tool USES it yet** (that is
increment 2). Uncommitted files: `platform/src/index.ts`, `platform/src/services/causal-agent.ts`,
`platform/src/services/reasoning-agent.ts`.

## RESUME HERE — next stage (do this first)
**Continue `nmemo-asf.3` increment 2: make the reasoning read tools actually USE `context.corpusId`** (scope
decision = Postgres read path only; Qdrant + the ~39 analytics services + RLS are explicitly OUT, tracked as
follow-ups). Then increment 3 (a live isolation test), then commit increments 1+2+3 as one coherent unit and
close `.3`.

Pattern for each helper: add an **optional** `corpusId?: string | null` and apply `AND corpus_id = $x` (or the
entity/fact predicate) **only when provided**, so the many OTHER callers stay unscoped exactly as today (no
tsc fan-out breakage). Then pass `context.corpusId` from the tool dispatch case.

Exact edits in `platform/src/services/causal-agent.ts` `_handleToolCallInner` (switch at :1719) + the helpers:
1. **`query_entity_neighbours`** (:1761) — `findConnectedEntities` (graph.ts) ALREADY accepts
   `corpusId?: string|null`; just add `corpusId: context.corpusId` to the options object. (It forwards to
   `traverseFromEntities`, which applies the filter — verify it does.)
2. **`search_similar_entities`** (:1772) — change `corpusId: toolInput.corpus_id` → `corpusId:
   context.corpusId ?? (toolInput.corpus_id as string | undefined)`. `findSimilarEntities` (entities.ts:362)
   already applies it (defaults 'default' — the context value now wins).
3. **`query_entity_facts`** (:1720) — `getEntityFacts` (facts.ts:847, opts `{asSubject?, asObject?}`) — add
   `corpusId?` to opts + `AND corpus_id = $x` (when provided) to its query; pass `context.corpusId`.
4. **`get_causal_history`** (:1863) — `getEntityCausalHistory` (causal.ts:1070, currently `(entityId)`) — add
   `corpusId?` + scope its SQL; pass `context.corpusId`.
5. **`trace_causes`** (:1892) — `traceCauses` (causal.ts:851) — add `corpusId?` + scope; pass it.
6. **`recall_via_graph`** (:1813) — pass `context.corpusId` to the internal `findSimilarEntities` (:1825) and
   `recallViaGraph` (graph-fallback.ts:453, which calls `traverseFromEntities` at :194 — thread corpusId in).
   The `searchMemoriesByUnit` call here is the **Qdrant path = OUT OF SCOPE** (payload has no corpus_id; leave
   it, note it).
7. `search_memories` (:1788) — Qdrant, OUT OF SCOPE. Leave unchanged.

**Increment 3 — live isolation test** (`.3` acceptance). A tsx tool (pattern: the probes below) that seeds
TWO scratch corpora with a same-named/overlapping entity+fact, then calls each scoped read helper with
`corpusId=A` and asserts it returns ONLY corpus-A rows (no B leak), and with `corpusId=null` returns both.
Deterministic (no Claude) — call the helpers directly, don't go through the LLM. Self-clean both corpora
(remember the causal_events mirror-trigger cleanup, see gotchas). Then `npx tsc` (must stay 69), commit
increments 1+2+3 (`feat(35): corpus-scope the live reasoning read path (nmemo-asf.3)`), `bd close nmemo-asf.3`.

After `.3`: next Phase-1 foundations are `.5` (dedup + predicate normalization) and `.4` (wire
`recallEntitiesFused` as an MCP tool). `.9` follow-ups (entity-mention offsets + optional live ingest) can slot
in whenever a live ingest is being run anyway.

## How to run / verify
- **DB (read/scratch):** `docker exec nmemo-postgres-1 psql -U cognitive -d cognitive_test -tAc "<SQL>"`
  (role `cognitive`, NOT postgres; psql not on PATH). NEVER unscoped-delete `cognitive_test` — it holds the
  294-doc research substrate. All probe scratch work uses `corpus_id='_prov_probe'` (or a `_prov_*` corpus)
  and self-cleans.
- **tsc baseline:** `cd /c/Users/bruce.mckay/dev/nmemo/platform && npx tsc --noEmit 2>&1 | grep -cE 'error TS'`
  → must be **69**.
- **Run a probe (deterministic, no Claude):** from `platform/`:
  `DATABASE_URL=postgres://cognitive:cognitive@127.0.0.1:5433/cognitive_test ML_SERVICES_URL=http://localhost:8000 QDRANT_URL=http://localhost:6335 QDRANT_COLLECTION=cognitive_test NODE_ENV=test EMBED_MODEL=nomic-embed-text npx tsx src/test/tools/<probe>.ts`
  (prov-probe / frag-probe / promote-probe / citation-probe — all PASS + self-clean).
- **Apply a migration standalone (NOT the full runner — it re-runs all 59 on cognitive_test):**
  `docker exec -i nmemo-postgres-1 psql -U cognitive -d cognitive_test < platform/src/db/migrations/059_provenance_lineage.sql`
- **Beads:** `C:/Users/bruce.mckay/AppData/Local/Programs/bd/bd.exe` — `bd show nmemo-asf`, `bd ready`,
  `bd update <id> --claim`, `bd close <id> --reason "..."`, `bd create <t> --parent nmemo-asf ...`.
- **Infra (all UP, verified):** postgres :5433 (`nmemo-postgres-1`, healthy), qdrant :6335, ml :8000
  (provider=claude), ollama :11434 (has `nomic-embed-text` + `bge-m3`). The full platform HTTP server was NOT
  running this session (not needed — probes call code directly).

## Key locations
- **Design docs (read these):** `docs/architecture/single-graph/` — **35** (provenance backbone design +
  every step's proof), **34** (COMMITTED intent set + the composite-reasoning framing), **33** (Phase 0 graph
  analysis), **32** (program plan), **30** (arch map), **31** (strategy→ingestion matrix). Ledger:
  `09-experiment-ledger.md` (retrieval experiments only — provenance is a build, not logged there).
- **Code shipped this session (committed):** `platform/src/services/causal-agent.ts` (1a fix +
  getMcpConfigPath suffix), `platform/src/pipeline.ts` (recordFragments + point-ids re-export + epoch store
  corpusId), `platform/src/services/promotion.ts` + `promotion-plan.ts` (1b epoch provenance + sourceId
  threading), `platform/src/services/point-ids.ts` (NEW leaf module), `platform/src/services/provenance.ts`
  (NEW, getFactCitation), migration `platform/src/db/migrations/059_provenance_lineage.sql`.
- **Probes (committed, `platform/src/test/tools/`):** `prov-probe.ts`, `frag-probe.ts`, `promote-probe.ts`,
  `citation-probe.ts`. Reuse their structure for the `.3` isolation test.
- **UNCOMMITTED (increment 1 of `.3`):** `platform/src/index.ts`, `platform/src/services/causal-agent.ts`,
  `platform/src/services/reasoning-agent.ts` (see Current state).
- **Beads:** epic `nmemo-asf`; closed `.1 .6 .2`; in-progress `.3`; open `.4 .5 .7 .8 .9`. Benchmarks epic
  `nmemo-bki` (unify with Phase 3; `nmemo-9qq`=CronQA). Read-path bug beads: `nmemo-4h3` (reads unscoped,
  the deeper structural ask), `nmemo-81k`/`nmemo-mdc`/`nmemo-cki` (corpus isolation).

## Architecture / how it works (essentials)
- Single graph in Postgres `cognitive_test`: `entities` (name+desc+embedding 768, corpus-scoped), `facts`
  (typed edges + fact_embedding 768, bi-temporal, inline `source_text`, `source_memory_id`, `corpus_id`),
  Graph C `causal_events`/`causal_edges`. Qdrant holds raw source-text vectors ('memories' collection, window
  + unit points). AGE retired from the read path (`services/graph.ts` recursive CTE over `public.facts`).
- **Lineage (new this session):** `fact_sources` (fact→window, source_text) + `fact_units` (fact→unit point,
  char offsets) + `source_document` + `fragment` (mig 059). fragment.id == the deterministic Qdrant point id
  (`windowPointId(sourceId,chunkIndex)` / `unitPointId(memoryId,i)`, in `services/point-ids.ts`), so Postgres
  lineage and Qdrant never diverge. `getFactCitation(factId)` walks fact → fact_units → fragment → parent →
  source_document.
- **Ingest arms:** serial/optimistic (`store()`→`extract()`, agent creates facts via `create_fact` MCP tool)
  and epoch (`store()` all → `propose()` to staging → `promote()` writes canonical). `store()` now writes
  fragments on BOTH arms. corpusId is honored only on the epoch arm.
- **Live reasoning read path:** `/api/reason[/query]` → `invokeReasoningAgent` → ml-services spawns Claude
  Code with an MCP config → graph MCP tools (`_handleToolCallInner` switch in causal-agent.ts) → DB. The MCP
  transport calls `handleToolCall` with NO context, so `resolveContext()` reads env vars (`MNEMO_*`) written
  into the per-actor config file by `getMcpConfigPath`/`getMcpEnv`. That env carrier is how `corpusId`
  reaches the read tools (increment 1 wired it; increment 2 makes the tools use it).

## Open questions / blockers / needs-human
- No blocker. `.3` scope is DECIDED (Postgres read path). The deeper structural fail-closed fix (session GUC +
  Postgres RLS, `nmemo-4h3`) was explicitly deferred — the survey confirmed there is NO single choke point and
  RLS is a substantial separate project needing corpusId at the read layer first (which `.3` provides).
- OPTIONAL, needs explicit consent (Claude spend / irreversible): the full live epoch ingest (`.9`);
  `nmemo-u8j.12` bge-m3 migration; `nmemo-u8j.7` Graph C baseline. Org Claude spend cap bit in session 001 —
  keep Claude-heavy work minimal; eval/proof compute is local (Ollama, safe).

## Gotchas / constraints / learnings
- **NEVER run the vitest suite against `cognitive_test`** — `src/test/setup.ts`/`global-setup.ts` DROP+RESTORE
  cognitive_test from a snapshot, which would wipe the qbio/arxiv/dal research substrate (the snapshot may
  predate them). Prove via standalone tsx probes instead (the pattern used all session).
- **A DB trigger mirrors every new fact into `causal_events`** (`fact_id` FK, NO ACTION) — the mechanism
  behind doc 33's "7299 causal events over 212 facts" on `default`. Any scratch cleanup that deletes facts
  MUST delete causal_edges (of those events) + fact_history + causal_events BEFORE facts. See any probe's
  `finally` block for the exact order.
- **staging `source_id` is a UUID column** (not text); real ingest sets `sourceId = opts.sourceId ??
  randomUUID()`. `windowPointId(sourceId, chunkIndex)` uses it as a string name.
- **`platform/src/index.ts` has NUL bytes** → ripgrep skips it; use `grep -a` (Bash) or the Read tool. Its
  normal-code lines edit fine with the Edit tool.
- **`rawQuery` (db/raw.ts) camelCases result keys** but does NOT parse/rewrite SQL. Raw `db.execute(sql\`…\`)`
  returns snake_case keys (that's what the probes read).
- **`store()` corpusId is forward-only** — existing 294-doc rows have NO fragments/lineage; a backfill is a
  separate one-shot (noted in doc 35 §4, out of scope).
- **Migration runner re-runs ALL files every time (no journal, idempotent-by-design)** — DO NOT run it against
  cognitive_test to apply one migration; apply the single file via psql (see How to run).
- **Bash cwd persists + drifts** — `git` commands ran from repo root left cwd there; `npx tsx src/...` then
  failed (looked under repo-root/src). Always `cd /c/Users/bruce.mckay/dev/nmemo/platform && …` for tsx/tsc.
- **Commit only when the user asks** (they authorized the Phase-1.1 commits; increment 1 of `.3` is
  deliberately left uncommitted for the next session to bundle with increment 2).
- **Empirical discipline (memory `feedback_verify_empirical_gates`):** prove deterministically before spending
  Claude; a passed check needs the dumb baseline + leakage control; size leaks before banking.

## Read-order of other docs
1. `docs/architecture/single-graph/35-provenance-lineage-backbone-design.md` — the whole Phase-1.1 design +
   each step's proof + the §7 decision (option A) + scope notes. START HERE for continuing `.3` context (§4/§5).
2. `bd show nmemo-asf.3` — the live bead (acceptance + notes); `bd show nmemo-asf` — the epic + child status.
3. `docs/architecture/single-graph/34-query-intent-set-proposal.md` — committed intents + priority + the
   composite-reasoning framing (what Phase 3/4 build against).
4. `docs/architecture/single-graph/33-graph-structure-analysis.md` — Phase 0 data facts (corpus health,
   dead layers, tie-break caveat).
5. `docs/architecture/single-graph/30-retrieval-architecture-map.md` — current-state read path (the proven
   `recallEntitiesFused` fusion is still UNWIRED — that's `.4`).
6. CLAUDE.md "CURRENT DIRECTION" — standing project context (predates nmemo-asf; the program supersedes the
   retrieval-loop framing).
7. `memory/feedback_verify_empirical_gates.md` + `memory/project_retrieval_loop.md` — discipline + prior-loop
   summary.
```
