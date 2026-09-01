# HANDOVER — 2026-09-01 · branch feat/single-graph-retrieval · HEAD a37b7f2

## Source of truth (read these, in order)
- **Ledger:** `docs/architecture/single-graph/09-experiment-ledger.md` — loop state + the per-experiment
  rows for `.9 .6 .3 .5` added this session (bottom of the "Epic nmemo-u8j" section).
- **Epic:** `nmemo-u8j` — `bd show nmemo-u8j`, `bd ready`. Children `.1`–`.12`.
- **Direction:** `CLAUDE.md` "CURRENT DIRECTION".
- **Prereg/results pattern:** docs 17/18 (candidate-breadth) and this session's 19/20, 21/22, 23/25.
- **Memory:** `memory/project_retrieval_loop.md`, `memory/feedback_verify_empirical_gates.md`,
  `memory/reference_nmemo_silent_data_traps.md`.

## What changed this session (overnight unattended queue — all 4 items handled)
- `8e738a9` + `c874f7d` **`.9` substrate hygiene → BAR 1 PASS, closed.** Duplicate-name rate quantified
  per corpus (8–13% dup_rate; 14–20% of entities in a shared-name group; 67–71% of query targets tie
  exactly). The R4 fusion delta is **tie-break-robust** (condensed byPair ABOVE 0 under asc/desc/rand,
  both corpora). Refined the keep-list: only the STRICT absolute level rides the tie-break (~1.3–1.7%);
  the promotable CONDENSED level is invariant. Read-path dedup NOT adopted (lossy; +0.08 gain is 87%
  oracle-relaxation). Adversary CONFIRMED. (docs 19/20; harness `substrate-hygiene.ts`)
- `c429084` + `26a228a` **`.6` traversal-augmented → NEGATIVE, closed.** Spreading activation over
  `public.facts` fused as a 3rd signal does NOT beat the name⊕fact fusion (arxiv −0.0078 spans 0, dal
  −0.0339 below 0). Redundancy + zero-sum RRF displacement; adversary decay sweep {0.5,0.9,1.0} tops out
  at a TIE (not a suppression bug). Adversary CONFIRMED-NEGATIVE. (docs 21/22; `traversal-augmented.ts`)
- `85e068b` + `a37b7f2` **`.5` embedding upgrade (bge-m3 vs nomic, arxiv A/B) → PRIMARY PASS (condensed,
  DEMONSTRATED), closed.** bge-m3 lifts the fusion +0.0930 condensed R@10 (above 0 on all 3 bootstraps;
  149 vs 113 hits); name signal +0.0724; R4 lever preserved under bge (+0.0698). **Strict spans 0**
  (condensed-oracle-dependent). Adversary CONFIRMED (lift = 72% genuine target-finding / 28% relevant-set
  rescue). Filed **`nmemo-u8j.12`** = the gated production swap. (docs 23/25; `embedding-upgrade.ts`)
- `aa850bf` **`.3` generalization → PRE-REGISTERED ONLY (doc 24), bead left OPEN.** Frozen prereg for the
  new-domain (arXiv q-bio) + sparse-graph stress test + the single staged ingest command. **Ingest NOT
  run** (attended-only).
- Lessons appended to `docs/architecture/truth-graph/33-implementation-lessons.md` for `.9/.6/.5`.

## Loop / epic state (verbatim from the ledger)
- Overnight queue COMPLETE: `.9` PASS, `.6` NEGATIVE, `.5` PASS(condensed), `.3` prereg-only.
- Epic `nmemo-u8j` children: closed `.1 .2 .5 .6 .9 .10 .11`; **`.3` in-progress (prereg done, ingest
  attended-pending)**; open `.4` (reranker), `.7` (Graph C), `.8` (community), **`.12` NEW** (bge swap).
- The one confirmed lever remains name⊕fact fusion (R4, shipped in `.1`); this session added: it is
  tie-break-robust (`.9`), NOT improved by graph traversal (`.6`), and lifted by bge-m3 on the promotable
  oracle (`.5`, swap gated in `.12`).

## IN-FLIGHT — not yet verified/banked
- **None mid-flight.** All three run experiments (`.9 .6 .5`) passed their blind adversary and are
  committed + closed. No background agent is running (all three adversaries + the embed job completed).
- **`.3` is prereg-only by design** — the next step is the ATTENDED ingest (see Next action), NOT a
  re-run of anything. Do not treat `.3` as failed or mid-flight.
- **Untracked, regenerable (do NOT matter; left untracked per precedent):** all
  `prereg-artifacts/*-results.json`, `*-run.txt`, and **`bge-m3-embed-cache.json`** (the 7975-vector
  1024-dim bge cache — regenerable but slow to rebuild; keep it if disk allows to avoid a re-embed).
- **Pre-existing/unrelated:** `.claude/scheduled_tasks.lock` (M), `viz-arxiv-nlp.png` (??).
- **Open user-decisions:** none forced. Optional: whether/when to run `.3` (attended) and `.12` (the bge
  swap — a real migration).

## Next action
- **`.3` (attended):** acquire ~300 arXiv q-bio abstracts → `corpus-C.json`, add the one-line CORPORA
  entry, run the single staged ingest command in `docs/architecture/single-graph/24-prereg-generalization.md`
  §3, then the eval (§4) + blind adversary (§8). Multi-hour, shared-DB write — supervise it.
- **Alternatives (ranked):** (a) `.12` gated bge-m3 swap (dim 768→1024 migration + full re-embed + HNSW
  rebuild + 2nd-substrate/end-to-end re-measure); (b) `.4` cross-encoder reranker over the fused pool;
  (c) `.7` Graph C baseline; (d) `.8` community summaries (needs a global-query oracle first).

## Active traps (right now)
- **Infra UP:** postgres :5433 (`nmemo-postgres-1`, healthy) + qdrant :6335 (docker, up 8d); ML :8000
  (provider=claude); Ollama :11434 now has **both `nomic-embed-text` and `bge-m3`** (`.5` pulled bge-m3).
- Substrate in `cognitive_test` (retrieval corpora): arxiv-nlp 1230 / arxiv-cv 1282 / dal-nlp 1133 /
  dal-cv 1262 entities; ~2860 active embedded facts per arxiv corpus.
- Standing repo traps: **tsc baseline = 69** (`cd platform && npx tsc --noEmit`; compare, don't "fix");
  `platform/src/index.ts` NUL bytes → `grep -a`; `rawQuery` rewrites snake_case→camelCase result keys
  (alias to explicit camelCase in SQL, as `embedding-upgrade.ts` does for `sourceText`/`objectValue`);
  **measure DELTAS not absolute R@10** (tie-break sensitive; `.9` quantified the strict swing at ~1.5%);
  DB access is `docker exec nmemo-postgres-1 psql -U cognitive -d cognitive_test` (role is `cognitive`,
  NOT `postgres`; `psql` is not on PATH); **NEVER delete / unscoped-write `cognitive_test`**.
- Discipline (do not relitigate): task = find-the-relevant-set, **condensed promotes** (`.10`); every
  result reports both oracles + all 3 bootstraps (seed 20260831); blind adversary before any bank.
- Bash trap seen this session: `cd platform` in successive compound commands STACKS to `platform/platform`
  — use an absolute `cd /c/Users/bruce.mckay/dev/nmemo/platform`.

## Verification checklist for /pickup
- [ ] branch == feat/single-graph-retrieval, HEAD == a37b7f2 (else commits landed — reconcile)
- [ ] infra up (postgres/qdrant/ml/ollama; ollama has nomic + bge-m3)
- [ ] substrate counts match (arxiv/dal above)
- [ ] `bd show nmemo-u8j`: `.1 .2 .5 .6 .9 .10 .11` closed; `.3` in-progress; `.4 .7 .8 .12` open
- [ ] tsc baseline still 69 (`npx tsc --noEmit` from `platform/`) before any code work
- [ ] no background agent assumed — the 3 adversaries + embed job all completed this session
- [ ] `bge-m3-embed-cache.json` present in prereg-artifacts (else `.5`/`.12` re-embed is slow)
