# HANDOVER — 2026-09-02 · branch feat/single-graph-retrieval · HEAD aefbf3f

## Source of truth (read these, in order)
- **Ledger:** `docs/architecture/single-graph/09-experiment-ledger.md` — loop state + per-experiment rows;
  `.3` and `.4` rows added this session (bottom of the "Epic nmemo-u8j" section) + loop-state updated.
- **Epic:** `nmemo-u8j` — `bd show nmemo-u8j`, `bd ready`. Children `.1`–`.12`.
- **Direction:** `CLAUDE.md` "CURRENT DIRECTION".
- **Preregs/results this session:** doc 24 (.3 generalization), docs 26+27 (.4 cross-encoder rerank),
  **doc 28 (feasibility of the 3 remaining levers .7/.8/.12 — no-Claude MEASURE-FIRST; read before deciding)**.
- **Memory:** `memory/project_retrieval_loop.md`, `memory/feedback_verify_empirical_gates.md`.

## What changed this session (two clean experiments, both banked NEGATIVE, both closed)
- `3166925` **`.3` fusion generalization → NEGATIVE, CLOSED.** Built a genuinely disjoint domain: 320 arXiv
  q-bio abstracts → corpus `qbio` (3670 entities / 6955 facts, 0 id-overlap, vocab-disjoint). R4 fusion does
  NOT reproduce in aggregate (strict Δ −0.0106 spans 0) BUT the per-degree lift curve REPLICATES arxiv
  (deg-8+ +0.167 vs +0.158) — a **query-degree MIXTURE effect, not domain-specific**. Fusion is a
  degree-gated lever. Adversary reproduced + reframed (both corrections adopted). Doc 24.
- `d487842`+`84cb476`+`d4aea90`+`b3b32f2` **`.4` cross-encoder rerank → NEGATIVE, CLOSED.** `bge-reranker-v2-m3`,
  local CPU, no Claude. name+facts candidate HURTS (arxiv strict −0.1059 all 3); name-only candidate clears
  the naive bar (arxiv +0.0724, qbio +0.1915 all 3) BUT is a **name-in-query lexical artifact** — ~80% of
  targets are verbatim in the query, a `query.includes(name)` reranker BEATS the CE, R@1 regresses, off-query
  transfer nil. NO shippable reranker; fusion stays the head. Docs 26+27. **I nearly banked the name-only
  result as "first lever since R4" — the blind adversary caught the launder** (logged to
  `feedback_verify_empirical_gates`).
- `aefbf3f` **`.8` community-structure retrieval → real but SCOPED lever (deterministic, no Claude). Bead
  OPEN for LLM follow-up.** Louvain communities (modularity 0.91) + centroid routing. arxiv n=387: strict
  +0.0026 spans 0 (no target-finding gain); **condensed +0.0439 all 3 → helps relevant-set/thematic**.
  Adversary CLEARED it of the `.4` name-in-query artifact (singleton control RRF-60(FACTNAME,NAME) = −0.0181).
  Caveat: un-held-out-edge leak + condensed-only + thin. Docs 28 (feasibility) + 29 (prereg+results).
- New code: `DISABLE_CAUSAL_PASS` env kill switch (config.ts + pipeline.ts; Graph-S-neutral, default off);
  tools `qbio-fusion.ts`, `arxiv-degree.ts`, `rerank-{dump,eval,lexcheck}.ts`, `rerank_score.py`,
  `community-fusion.ts`, `export_communities.py`. tsc = 69 throughout.

## Loop / epic state (verbatim from the ledger)
- Retrieval track: one confirmed lever = two-signal fusion (R4). This session: `.3` bounds it as
  **degree-gated (query-degree-mix-specific, not domain)**; `.4` shows **cross-encoder reranking yields no
  shippable lever** (name-only "win" is a name-in-query artifact a substring test beats).
- **META (load-bearing): this eval's target-finding is ~80% name-presence detection** (papers-as-queries —
  target's name is verbatim in the query). Bounds what "target-finding" means; future retrieval preregs must
  register a `query-contains-name` control + a not-in-query subgroup. Does NOT overturn R4's deltas.
- Epic `nmemo-u8j` children: closed `.1 .2 .3 .4 .5 .6 .9 .10 .11`; **open `.7 .8 .12`** — but `.8` now has
  a banked deterministic-FLOOR result (scoped condensed win), OPEN only for the gated LLM-summary follow-up.

## IN-FLIGHT — not yet verified/banked
- **None mid-flight.** `.3` and `.4` both passed blind adversary and are committed + closed. No background
  agent or scoring job is running (verified: no rerank/ingest python processes alive).
- **OPEN USER-DECISION (why the session paused):** which of the three remaining items to pursue — the user
  chose **"Pause + brief me"**. All three need a decision:
  - `.12` **bge-m3 production swap** — a REAL, irreversible migration (pgvector dim 768→1024 + full re-embed
    all corpora + HNSW rebuild). Needs explicit consent. Ollama-only (no Claude).
  - `.7` **Graph C causal-layer baseline** — weeks-scale (maps to the benchmarks plan §2.2 Corr2Cause
    reality-check); needs a causal-query oracle + a Claude judge (org spend-cap risk); `causal_edges` has NO
    `corpus_id` (not corpus-partitioned); prerequisite bug `nmemo-umf` (causal pass delta-scoped, capped 200).
  - `.8` **community summaries** — needs a new global-query oracle (doesn't exist); P3; most speculative.
- **Untracked, keep (do NOT delete — slow to regenerate):** `prereg-artifacts/rerank-scores-{arxiv,qbio}{,-name}.json`
  (~5 hr total of CPU cross-encoder scoring), `bge-m3-embed-cache.json`, `qbio-embed-cache.json`. The
  `rerank-pool-*.json` / `*-results-*.json` / `*-run.txt` are fast to regenerate. All untracked per precedent.
- **Pre-existing/unrelated:** `.claude/scheduled_tasks.lock` (M), `viz-arxiv-nlp.png` (??).

## Next action
- **Get the user's pick among the remaining three** (they paused for exactly this). All need a decision
  autonomous work cannot substitute for (irreversible migration / Claude spend against a live org cap):
  - `.8` **LLM-summary follow-up** (the deterministic FLOOR passed, doc 29): does an LLM community *summary*
    beat the name-centroid on the relevant-set task? **The gate the adversary set: use a HELD-OUT community
    assignment (exclude each query paper's edges) + a strict/independent oracle, NOT another condensed run**
    — else the `.4` name-in-query pattern re-enters. Needs Claude (small, ~110 summaries — low spend risk).
    Closest to a real win of the three.
  - `.7` **Graph C baseline**: arxiv has NO causal layer (doc 28); the real test is the benchmarks-epic
    Corr2Cause reality-check (`nmemo-4fd`) — needs a causal oracle + Claude judge + the `nmemo-umf` scoping.
  - `.12` **bge-m3 migration**: needs explicit go-ahead (irreversible: dim 768→1024 + full re-embed + HNSW
    rebuild + second-substrate re-measure before any default flip; `.5`/doc 25 caveats).

## Active traps (right now)
- **Infra UP:** postgres :5433 (`nmemo-postgres-1`, healthy), qdrant :6335, ml :8000 (provider=claude),
  Ollama :11434 with **nomic-embed-text + bge-m3**. Reranker venv (isolated) at
  `…/scratchpad/rerank-venv` with `bge-reranker-v2-m3` cached in `~/.cache/huggingface/hub` (2.2 GB).
- **Substrate (`cognitive_test`):** arxiv-nlp 1230 / arxiv-cv 1282 / dal-nlp 1133 / dal-cv 1262 /
  **qbio 3670 entities, 6955 facts** (all corpus-scoped; NEVER unscoped-write / delete).
- **Org Claude spend cap bit mid-session** (429 on the ingest's `claude -p` extraction; reset once). Any
  Claude-heavy work (`.7`, more ingests) risks re-hitting it. Eval/rerank compute is Ollama/local (safe).
- Standing repo traps: **tsc baseline = 69** (`cd platform && npx tsc --noEmit`; compare, don't "fix");
  `platform/src/index.ts` NUL bytes → `grep -a`; `rawQuery` snake→camel rewrite (alias to camelCase);
  postgres.js `= ANY($arr::uuid[])` fails (cannot cast record→uuid[]) — load per-corpus with a string param;
  **measure DELTAS not absolute R@10** (tie-break sensitive); DB = `docker exec nmemo-postgres-1 psql -U
  cognitive -d cognitive_test` (role `cognitive`, not `postgres`); a backgrounded `cd platform &&` LEAKS into
  the session cwd — use absolute paths.
- Discipline: every result reports both oracles + all 3 bootstraps (seed 20260831); blind adversary before
  any bank; **a met pre-registered bar is necessary not sufficient — register the dumbest baseline + a
  leakage control** (the `.4` lesson).

## Verification checklist for /pickup
- [ ] branch == feat/single-graph-retrieval, HEAD == b3b32f2 (else commits landed — reconcile)
- [ ] infra up (postgres/qdrant/ml/ollama; ollama has nomic + bge-m3)
- [ ] substrate counts match (arxiv/dal/qbio above)
- [ ] `bd show nmemo-u8j`: `.1 .2 .3 .4 .5 .6 .9 .10 .11` closed; `.7 .8 .12` open
- [ ] tsc baseline still 69 (from `platform/`) before any code work
- [ ] no background agent assumed — none was running at handover
- [ ] the scored `rerank-scores-*.json` + embed caches still present (else `.4`/`.5` re-runs are slow)
- [ ] open user-decision resolved: which of `.7 / .8 / .12` to pursue (`.12` needs explicit consent)
