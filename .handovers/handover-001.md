---
session: 001
date: 2026-09-02
project: nmemo — single-graph retrieval → intent-adaptive retrieval & ingestion redesign
status: in-progress
supersedes: none
---
# Handover 001 — nmemo — retrieval loop CLOSED, new program (nmemo-asf) stood up, PAUSED on one human decision

## Mission / goal
Two arcs this session, on branch `feat/single-graph-retrieval`:
1. **Finish the single-graph retrieval loop** (epic `nmemo-u8j`): test the remaining research-backed
   retrieval levers with the project's discipline (pre-register → measure → blind adversary → bank).
2. **A long design dialogue that reframed the direction** (the user's own framing): retrieval is not
   single-shot; different **query intents** need different strategies; the MCP tool surface should be the
   *product* driven by an external agent (routing = the client model + skills, not a built classifier);
   **ingestion must be co-designed with, and pulled by, the query capabilities**; every change is
   **benchmark-gated**; and there must be a **provenance/lineage backbone** (every fragment reconstructable
   to source, every entity/edge linked to the fragment that proves it). This became a new program + epic
   **`nmemo-asf`** with a full plan (docs 30–34).

**The user is deliberately steering and reviewing** — do not barrel into production-code changes; converge on
findings and check in at decision points.

## Current state — DONE + verified
Branch `feat/single-graph-retrieval`, HEAD **`12efa5b`**. Working tree clean except intentionally-untracked
regenerable artifacts (see Key locations). `cd platform && npx tsc --noEmit` baseline = **69 errors** (compare,
never "fix"); held at 69 through every code edit this session (verified repeatedly).

**Epic `nmemo-u8j` (retrieval loop) — all runnable experiments banked NEGATIVE + closed:**
- `.3` q-bio generalization → NEGATIVE. Built a genuinely disjoint 320-doc arXiv q-bio corpus
  (`corpus_id='qbio'`, 3670 entities/6955 facts). Fusion's aggregate win vanished (strict Δ −0.0106, spans 0)
  but the *per-degree lift curve replicated arxiv* → it's a **query-degree mixture effect, not domain-
  specific**; fusion is a **degree-gated lever**. Doc 24. Double-adversary-verified. CLOSED.
- `.4` cross-encoder rerank → NEGATIVE. name+facts candidate HURTS (−0.106); name-only *clears the naive bar*
  (+0.0724) **but is a name-in-query lexical artifact** — ~80% of targets appear verbatim in the query, a
  `query.includes(name)` reranker beats the 568M model. Docs 26/27. Two adversaries; I nearly banked it as a
  win and the adversary caught the launder. CLOSED.
- `.8` community-structure retrieval → NEGATIVE. Deterministic Louvain-centroid routing *looked* like a
  scoped condensed win (+0.0439); I banked it, then **sized the leak** (held-out community assignment
  excluding each query doc's edges) and the sign FLIPPED to −0.062. The whole "win" was an un-held-out-edge
  leak. Doc 29 + CORRECTION. CLOSED. **Self-corrected in-session.**
- `.7` (Graph C baseline) + `.12` (bge-m3 migration) remain OPEN — gated (Claude spend / irreversible
  migration); NOT part of the new arc. Feasibility recorded in doc 28.
- Infra artifact built: `DISABLE_CAUSAL_PASS` env kill switch (config.ts + pipeline.ts; Graph-S-neutral,
  default off) — made Graph-S-only ingests ~2.5× cheaper.

**Epic `nmemo-asf` (the NEW program) — stood up; Phase 0 done, Phase 2 mid-flight:**
- `.1` Phase 0 graph-structure analysis → **CLOSED/banked** = doc 33 (read-only, DB-verified + spot-checked).
- `.6` Phase 2 query-intent enumeration → **IN_PROGRESS**. Proposal written = doc 34 (5 intents, benchmark-
  mapped, `nmemo-bki` reconciled, recommended priority, labelled a proxy). **Awaiting the user's product-fit
  check** — the one reserved human decision.
- `.2` (provenance backbone), `.3` (live corpus scoping), `.4` (wire fusion as MCP tool), `.5` (dedup +
  predicate normalization), `.7` (per-intent benchmark harness) — all OPEN, not started.

## RESUME HERE — next stage (do this first)
**The program is PAUSED on exactly one thing: the user's Phase 2 product-fit answer.** Bead `nmemo-asf.6`.

1. **Re-surface the two product-fit questions from doc 34** (§"The one question for the human"):
   (a) Do the five proposed intents — **I1 point-lookup, I2 multi-hop, I3 temporal, I4 causal, I5 global** —
   match what the system is *for* (anything missing / not actually a goal)? (b) Is the recommended priority
   **I3 → I1 → I2 → I4 → I5** right, or is the product more about reasoning (causal/multi-hop) or synthesis
   (global), which reorders the work? Do NOT re-derive the set — it's in doc 34; just get the answer.
2. **On the answer:** commit the intent set — update doc 34 status from PROPOSAL to COMMITTED with the final
   set + priority, then complete/close `nmemo-asf.6`. (If the user says "go with your recommendation," commit
   as proposed: set = I1–I5, priority I3>I1>I2>I4>I5.)
3. **Create Phase 3 + Phase 4 children** against the top-priority intent. Default (if I3 temporal is #1):
   `nmemo-asf.7` Phase 3 = wire the **CronQA** benchmark + a flat-vector baseline (the bi-temporal substrate
   already exists — `valid_at`/`invalid_at`/`expired_at` on Graph S facts — and has never been evaluated for
   retrieval, so this is the cheapest high-information win); then a Phase-4 child = a pre-registered temporal-
   retrieval experiment gated on CronQA. Unify with epic `nmemo-bki` (it already scoped CronQA/LongMemEval/
   LOCOMO/Corr2Cause/GraphRAG-Bench) rather than duplicating.
4. **Then the Phase 1 foundations (production code — do deliberately, these touch ingest + live read path):**
   - `.2` provenance/lineage backbone — **narrowed by doc 33**: inline `facts.source_text` already exists
     (100%), so the task is NOT text recovery; it is to build the *lineage* — `fragment{id, source_document_id,
     parent_id, char offsets, chunker version}` + `entity/edge → proof_fragment_ids[]` transitively to source.
     Highest-leverage foundation (also unblocks correct held-out eval).
   - `.3` corpus scoping on the live path (nmemo-4h3/-81k): thread `corpusId` through Qdrant search,
     `findSimilarEntities` (stop pinning to `'default'`), `traverseFromEntities`, `handleBatch`.
   - `.5` dedup / canonicalization — **include predicate normalization** (doc 33: `is_instance_of` vs
     `instance_of`; 67–75% hapax predicates), not just entity dup-names.
   - `.4` wire the corpus-correct `recallEntitiesFused` (the one PROVEN lever) as an MCP tool — it currently
     has NO live caller (doc 30).

Everything runs under the loop discipline (pre-register → measure → blind adversary → bank; size leaks don't
just state them; halt-and-surface on surprise). Use `/epic-cycle-implementation` + `/loop` to drive it.

## How to run / verify
- **DB (read):** `docker exec nmemo-postgres-1 psql -U cognitive -d cognitive_test -tAc "<SQL>"` (role
  `cognitive`, NOT postgres; `psql` not on PATH). NEVER unscoped-write / delete `cognitive_test`.
- **tsc baseline:** `cd /c/Users/bruce.mckay/dev/nmemo/platform && npx tsc --noEmit 2>&1 | grep -cE 'error TS'`
  → must be **69**.
- **Beads:** `C:/Users/bruce.mckay/AppData/Local/Programs/bd/bd.exe` — `bd show nmemo-asf`, `bd ready`,
  `bd update <id> --claim`, `bd close <id> --reason "..."`, `bd create <title> --parent nmemo-asf ...`.
- **Retrieval eval harness** (if re-running any experiment): `cd platform && DATABASE_URL=postgres://cognitive:cognitive@127.0.0.1:5433/cognitive_test ML_SERVICES_URL=http://localhost:8000 QDRANT_URL=http://localhost:6335 QDRANT_COLLECTION=cognitive_test NODE_ENV=test npx tsx src/test/tools/<tool>.ts`. Wiring anchor: arxiv FACTNAME strict R@10 must reproduce `0.26356589147286824` (n=387).
- **Infra (all UP, verified this session):** postgres :5433 (`nmemo-postgres-1`, healthy, up 9d), qdrant :6335,
  ml :8000 (provider=claude), ollama :11434 (has `nomic-embed-text` + `bge-m3`).

## Key locations
- **Program plan + docs (read these):** `docs/architecture/single-graph/` — **32** (program plan + epic list),
  **30** (arch map: 2 retrieval systems, one live-agent-MCP + one experiment-only), **31** (strategy→ingestion
  matrix, literature-grounded), **33** (Phase 0 graph analysis), **34** (Phase 2 intent proposal). Retrieval-
  loop results: docs 24 (.3), 26/27 (.4), 28 (feasibility), 29 (.8). Ledger: **`09-experiment-ledger.md`**.
- **Beads:** epics `nmemo-asf` (new program), `nmemo-u8j` (retrieval loop, mostly closed), `nmemo-bki`
  (benchmarks — becomes this program's Phase-3 harness work), `nmemo-4fd` (Corr2Cause, under bki).
- **Tools written this session** (`platform/src/test/tools/`): `qbio-fusion.ts`, `arxiv-degree.ts`,
  `rerank-{dump,eval,lexcheck}.ts` + `rerank_score.py`, `community-fusion.ts` (has `--heldout`),
  `export_communities.py`, `heldout_communities.py`.
- **q-bio corpus (committed):** `docs/architecture/cross-corpus-audit/convergence-artifacts/corpus-C.json`
  (320 abstracts); ledger/attribution `multihop-artifacts/{ingest-ledger,attribution}-qbio.json`.
- **Untracked + regenerable (do NOT delete, slow to rebuild):** `docs/architecture/single-graph/prereg-
  artifacts/` — `bge-m3-embed-cache.json`, `qbio-embed-cache.json`, `arxiv-embed-cache.json`, `embed-cache.json`
  (frozen doc-05), all `rerank-*.json`/`community-*.json`/`heldout-communities-*.json`, `*-results.json`.
- **SESSION-TRANSIENT (will be GONE next session):** the reranker venv at
  `…/scratchpad/rerank-venv` (torch+sentence-transformers). The **bge-reranker-v2-m3 model (2.2GB) persists**
  in `~/.cache/huggingface/hub`; only the venv needs recreating if a cross-encoder is ever needed again
  (rerank work is closed, so unlikely).
- **No background tasks/agents running** at handover (all subagents completed; nothing to re-launch).

## Architecture / how it works (essentials)
- Single knowledge graph in Postgres `cognitive_test`: `entities` (name+desc+`embedding` 768, corpus-scoped),
  `facts` (typed edges + `fact_embedding` 768, bi-temporal `valid_at`/`invalid_at`/`expired_at`, inline
  `source_text`), Graph C `causal_events`/`causal_edges` (mandatory reasoning+source_references). Qdrant holds
  raw source-text vectors (`memories` collection, window+unit points). AGE is **retired** from the read path
  (`services/graph.ts` traverses `public.facts` via recursive CTE, `traverseFromEntities`).
- **The live read path is already agent-driven over MCP** (`graph-mcp.ts` / `GRAPH_TOOLS`; `/api/reason[/query]`
  → reasoning agent → tools). **But the one PROVEN lever (`recallEntitiesFused` two-signal fusion) is NOT
  wired**, and live corpus-scoping is broken. That gap = the new program's Phase 1. (Full detail: doc 30.)
- **Proven:** two-signal fusion `RRF-60(dense-names, dense-facts)` (+0.0724 strict R@10, R4). bge-m3 embedder
  lifts it (+0.093 condensed, `.5`/doc 25 — pending as `.12`). **Everything else tested is negative *on the
  fact-finding task*** — and the literature (doc 31) agrees those levers only pay on their own query types.

## Open questions / blockers / needs-human
- **BLOCKER (the only one): the Phase 2 product-fit answer** (doc 34 / bead `.6`) — the two questions in
  RESUME HERE step 1. Nothing downstream (Phase 3/4 children, which Phase 1 work matters) is decided until the
  user answers. This is a *product-purpose* judgment reserved for the human; the model already proposed the set.
- Reserved/optional decisions (not blocking this arc): `.12` bge-m3 migration (irreversible — needs explicit
  consent); `.7` Graph C baseline (Claude-spend-heavy, belongs to `nmemo-bki`).

## Gotchas / constraints / learnings
- **The repo-root `HANDOVER.md` is now STALE** — it describes the `nmemo-u8j` end-state (HEAD f8d56d0, remaining
  .7/.12) and predates the whole nmemo-asf program. THIS file (`.handovers/handover-001.md`) is the current
  truth for the new arc. (Consider refreshing repo-root HANDOVER.md to point at nmemo-asf, or rely on this.)
- **Empirical discipline is load-bearing** (`memory/feedback_verify_empirical_gates.md`): this session had
  **two laundered "wins" caught by blind adversaries** (name-only rerank; community "scoped win") and one
  **self-correction** (the .8 held-out leak). Rules banked: a passed pre-registered bar is necessary not
  sufficient (register the dumb baseline + a leakage control); **SIZE a known leak before banking, don't just
  state it**; any structure signal built from data that includes the query item is leak-prone — hold the query
  item out of the STRUCTURE, not just the scored signal.
- **doc-33 corrections to earlier docs:** (a) arxiv corpora have **ZERO entity descriptions** (dal/qbio ~99%)
  — reframes arxiv-vs-dal; EMBED_DESCRIPTIONS untestable on arxiv; description-path work → dal/qbio. (b)
  Inline `facts.source_text` **IS 100% present** — rerankers are NOT text-starved (corrects docs 30/31); the
  gap is normalized *lineage*. (c) provenance tables `source_memory_id`/`fact_sources`/`fact_units` **and
  `entity_meta` are all 0 rows** DB-wide. (d) predicate vocab is near-free-text (67–75% hapax). (e) Graph C
  exists only on **dal-cv (521 edges)** + default; arxiv=0, qbio=0.7%. (f) `default` corpus is synthetic —
  exclude. (g) qbio is the sparsest real corpus (mean degree 2.91).
- **Substrate guidance (data-grounded):** description-path → dal/qbio; causal → dal-cv; sparse-graph stress →
  qbio; tie-break caveat (dup canonical_name 15–20%) holds on arxiv/dal → **measure DELTAS, not absolute R@10**.
- **Code traps:** `platform/src/index.ts` has NUL bytes → ripgrep skips it, use `grep -a`. `rawQuery`
  (`db/raw.ts`) rewrites result keys snake→camel (alias to camelCase in SQL). postgres.js `= ANY($arr::uuid[])`
  fails ("cannot cast record to uuid[]") — load per-corpus with a string param instead. A backgrounded
  `cd platform && …` LEAKS into the session cwd — use absolute paths. Foreground `sleep` is blocked — use
  run_in_background or a Monitor until-loop.
- **Org Claude spend cap bit mid-session** (429 on the ingest's `claude -p` extraction; reset once). Any
  Claude-heavy work (more ingests, causal pass, LLM community summaries, LLM judges) risks re-hitting it. Eval
  compute is Ollama/local (safe).
- **Design principles settled (do not relitigate):** MCP tools are the product / agents are clients / routing
  = client model + skills (not a built classifier); ingestion is pulled by query capability; foundations
  (provenance, scoping, dedup, wire-fusion) are query-agnostic and come first; descriptions live on the
  summary/keyed path NOT the small-k entity vector; the intent set is a model-proposed PROXY (the human role
  is a product-fit check, not authoring — this was a correction the user pushed for, doc 34).

## Read-order of other docs
1. `docs/architecture/single-graph/32-intent-adaptive-retrieval-program.md` — the program plan + phases + epic.
2. `docs/architecture/single-graph/34-query-intent-set-proposal.md` — the proposal awaiting the product-fit
   answer (the RESUME-HERE decision).
3. `docs/architecture/single-graph/33-graph-structure-analysis.md` — Phase 0 findings that reshaped the plan.
4. `docs/architecture/single-graph/30-retrieval-architecture-map.md` — verified current-state (2 systems;
   proven-fusion-unwired; broken scoping).
5. `docs/architecture/single-graph/31-retrieval-strategy-ingestion-matrix.md` — the literature-grounded menu.
6. `docs/architecture/single-graph/09-experiment-ledger.md` — the full loop record (nmemo-u8j rows).
7. `memory/feedback_verify_empirical_gates.md` + `memory/project_retrieval_loop.md` — discipline + loop summary.
8. CLAUDE.md "CURRENT DIRECTION" — the standing project context (note: predates nmemo-asf).
