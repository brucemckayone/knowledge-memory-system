# Mnemo Project

A dual-graph knowledge system: Graph S (temporal state graph — entities, bi-temporal facts, Apache AGE) paired with Graph C (perpendicular causal graph — causal events, causal edges with LLM reasoning + source traceability, meta-causal patterns).

## CURRENT DIRECTION (2026-08-31) — read this before the historical sections below

**Optimising retrieval and knowledge synthesis on a SINGLE graph.** Deep refinement; learn what works
and what does not.

**Branch:** `feat/single-graph-retrieval`, created from `feat/cross-corpus-audit`. Its real base is
`feat/cognitive-platform-v2` at `4d3c0b8` (2026-06-30) — verified with `git merge-base`, not inherited
from the stale claim below.

**Read in this order:**

1. `single-graph/09-experiment-ledger.md` — **the live loop record**: one row per experiment, the
   convergence-rule state, and the next-step fork. Start here; it points to every result doc.
2. `docs/architecture/single-graph/00-consolidated-keep-list.md` — the keep/park/drop list, the blocker
   list, and the corrections of record. Detail in `single-graph/appendices/` (7 surveys).
3. `single-graph/03-blocker-closeout-findings.md` — **what the blockers actually were once opened, and
   six corrections to the keep list itself.** Read this before trusting a keep-list number.
4. `single-graph/05-results-description-aligned-and-hybrid.md` — the first retrieval result; then `07`
   (E0 oracle), `10` (pool-then-re-rank), `12` (shippable hybrid). Read each result's §-on-what-changed
   and the adversary section before citing any number.
5. `single-graph/{02,04,06,08,11}-prereg-*.md` — frozen pre-registrations. Append results; do not edit.

**Retrieval findings that change what to build (2026-09-01 loop; details in the ledger + docs 07/10/12):**

- **Do NOT put descriptions inside the entity vector for a small-k read path.** n=354: bare-name R@10
  **0.201** vs name+description **0.138** (doc 05). E0 (doc 07) softens this to a **borderline** harm
  under the completed "condensed" oracle (Δ −0.0452, CI upper bound on 0.0), but the direction (name ≥
  name+desc at small k) holds under both oracles.
- **E0 (doc 07): the oracle is NOT the binding constraint.** Completing it with a verbatim-name tier +
  condensed rank moves the arm gap by shift +0.0169 (CI spans 0); most strict misses are genuine, not
  unlabelled. Downstream results report **both** oracles. The condensed oracle is **not arm-neutral** —
  it credits relevance-set (lexical/hybrid) retrieval far more than dense (doc 12 §3).
- **Pool-then-re-rank is a TIE (doc 10).** DESC-pool → NAME-rerank ≈ ARM-NAME; the head/tail asymmetry is
  not exploitable because the only re-ranker that improves the head *is* the head.
- **`nmemo-uhp.18` shippable hybrid is a TIE at the standard config (doc 12).** RRF-60(dense-names,
  BM25-names) − ARM-NAME = +0.0254, CI spans 0. It clears at small K (K=10/30, thin, McNemar p=0.043) —
  a **lead, not a demonstration**; promote only via a fresh pre-registration, not a re-label. Its large
  condensed win (+0.11) is relevance-set retrieval, a **different task**.
- **Every absolute R@10 (doc 05's included) rides on the index-asc tie-break** — 14–18% duplicate
  `canonical_name`s make 250/354 targets tie exactly; index-desc voids doc 05's gate. **Deltas are
  robust; absolute levels are not.**
- **THE ONE CONFIRMED LEVER — build a two-signal read path (doc 16, R4).** After 3 single-substrate ties,
  fusing **dense-over-names ⊕ dense-over-facts** (retrieved-set RRF-60) is the only thing that beats
  name-only. Confirmed on the independent arxiv extraction: strict R@10 fusion − name = **+0.0724, above 0
  on all 3 bootstraps** (the pre-registered DEMONSTRATED bar), both corpora, every k; adversary re-embedded
  the names (30/30 cos 1.0) and reproduced it bit-for-bit. Genuine complementarity (name & fact top-10s
  share 0%; fusion keeps 24 name-only + 20 fact-only + 15 emergent hits). `fact_embedding` (was read by
  nothing) is the second signal. **Caveats:** gain is degree-concentrated (may shrink on sparse graphs);
  independence is extraction-only (same 294 papers), so a new-domain + sparse-graph test is the honest
  pre-ship confirmation; "robust" = byPair/byDoc (entity-cluster CI is the fragile one).
- **META: for a SINGLE retriever the binding constraint is the task/oracle, not the retriever.**
  Single-substrate target-finding is saturated at R@10 ≈ 0.20–0.23 (name/desc/pool/hybrid/fact-max all
  tie); separation comes from FUSING substrates (above) or from changing the task to relevance-set. Untested
  substrates remain: traversal-augmented, Graph C (queue #5–6).
- **Docs 15 and 17's "BM25 beats dense" evidence does not replicate** on this task (BM25 − VEC = −0.0085,
  CI spans zero).

**Decided, do not relitigate:** the single graph is the design; `corpus_id` is sufficient partitioning;
the concept super-graph is NOT a retrieval mechanism (settled across every configuration and oracle);
the iOS surface is stripped (done — its span-attribution pattern lives on in
`platform/src/services/sourced-prose.ts`); LongMemEval is parked; the predicate fold stays OFF.

**Load-bearing facts established 2026-08-31 (details in doc 03):**

- The 294-document substrate lives in **`cognitive_test`**, not `cognitive`.
- **Apache AGE is retired from the read path.** `services/graph.ts` traverses `public.facts` by
  recursive CTE (`traverseFromEntities` is the sanctioned primitive). AGE drifted to 7,250 nodes against
  3,513 entities *and* was missing real edges. The sync triggers remain; nothing reads them.
- **Filtered vector search needs `hnsw.iterative_scan = strict_order`** (migration 058, asserted by
  `startup-validation`). Without it a corpus-scoped search silently returned ZERO rows.
- `facts.source_memory_id` is **NULL on every fact**, and `fact_units` is empty, so graph-anchored
  retrieval returns evidence with no text. Still open.

**Two traps that cost time here, beyond the doc-numbering one below:**

- **`platform/src/index.ts` is invisible to ripgrep.** It contains NUL bytes used deliberately as a
  composite-key delimiter, so grep treats the HTTP entry point as binary and skips it. Use `grep -a`.
- **`rawQuery` (`db/raw.ts`) rewrites every result key snake_case → camelCase.** Reading `row.entity_id`
  returns `undefined` — the query succeeds and the field is silently empty.

**Two traps that have already cost real time:**

1. **Doc numbers collide across trees.** `truth-graph/` has TWO doc 38s and TWO doc 39s, and
   `cross-corpus-audit/` runs a parallel 38–42 series. So "doc 39" has three candidate files and
   "doc 42" has two. Always cite the full path. New work goes under `single-graph/` to stop adding to
   it. (bead `nmemo-jcj`)
2. **Everything below this section is from the March–April 2026 Sparse Truth Graph phase and is
   historical.** The AGE / search_path gotchas and the test-infrastructure notes are still accurate and
   load-bearing. The branch name, the 27-bead plan, and the phase structure are not.

## Branch & State (historical — see CURRENT DIRECTION above)

- **Branch:** `feat/sparse-truth-graph` (created from `feat/cognitive-platform-v1`)
  — **STALE, superseded.** See CURRENT DIRECTION above for the live branch and its verified base. The
  old claim that work descended from `feat/cognitive-platform-v1` is WRONG: the real base is
  `feat/cognitive-platform-v2` at `4d3c0b8` (2026-06-30). That mis-statement caused ~75 commits of
  inherited work (epoch-v2, the predicate machinery, the iOS milestone, cost tracking) to be attributed
  to the wrong branch during the 2026-08-31 survey. **Verify with `git merge-base` before attributing
  anything to a branch.**
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
- **`ag_catalog` must be in the database-level search_path** for `cypher()` to resolve on all connections (including triggers). Both `init-age.sql` and `global-setup.ts` run `ALTER DATABASE ... SET search_path = ag_catalog, public, "$user"` to ensure this. `docker-compose.yml` also sets `shared_preload_libraries='age'` and `session_preload_libraries='age'` for library loading.

## Existing Test Infrastructure

The test setup at `src/test/setup.ts` provides: `testDb`, `createTestEntity()`, `createTestFact()`, `randomEmbedding()`, `normalizeVector()`, `cosineSimilarity()`, `isMLServiceAvailable()`, `deleteFromTables()`. Test generators at `src/test/generators/` provide realistic entity/fact/memory generation. Reuse these — don't create new test infrastructure.