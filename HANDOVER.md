# HANDOVER — 2026-09-01 · branch feat/single-graph-retrieval · HEAD e8764f2

## Source of truth (read these, in order)
- **Ledger:** `docs/architecture/single-graph/09-experiment-ledger.md` — loop state + the new
  "Epic nmemo-u8j — build + prove (post-loop)" section (the `.10` decision + `.1`/`.11` outcomes).
- **Epic:** `nmemo-u8j` — `bd show nmemo-u8j`, `bd ready`. Children `.1`–`.11`.
- **Direction:** `CLAUDE.md` "CURRENT DIRECTION".
- **Prereg/results pattern to copy:** docs 17 (prereg) + 18 (results) — the model for every experiment.
- **Harness:** `platform/src/test/tools/retrieval-eval/` (engine) + `candidate-breadth.ts` (a config that
  reuses it). `services/fusion.ts` = the shipped RRF the eval also measures.
- **Memory:** `memory/project_retrieval_loop.md`, `memory/feedback_verify_empirical_gates.md`,
  `memory/reference_nmemo_silent_data_traps.md`.

## What changed this session
- `0ddd212` `.2` DONE — folded 5 one-off harnesses into one reusable eval engine (bit-for-bit reproduces docs 07/10/12/14/16).
- `1679c7f` `.1` DONE — shipped `recallEntitiesFused` = RRF-60(dense-names, dense-facts); `services/fusion.ts` shared with the eval.
- `.10` DONE (closed, no commit) — DECISION: task = **find-the-relevant-set**, **condensed** oracle promotes (recorded in the ledger + bead).
- `9d05990` + `e8764f2` `.11` DONE — candidate-breadth PASS: shipped default (candidateLimit=50, factLimit=200) preserves the R4 lever, adversary-CONFIRMED bit-for-bit. Caveat banked: dal pass is condensed-oracle-dependent.
- Lessons appended to `docs/architecture/truth-graph/33-implementation-lessons.md` (2026-09-01).

## Loop / epic state (verbatim from the ledger)
- Retrieval loop CONCLUDED at R4; the one confirmed lever (entity+fact fusion) is now BUILT (`.1`) and
  PROVEN to survive production top-N candidate breadth (`.11`).
- Epic `nmemo-u8j`: closed `.1 .2 .10 .11`. Open/ready: `.3 .4 .5 .6 .7 .8 .9` (all unblocked — `.2` closed).

## IN-FLIGHT — not yet verified/banked
- **None mid-flight.** The `.11` blind adversary completed and banked; no background agent is running.
- **Overnight QUEUE (decided this session, not yet started):** run in order, each full-cycle
  (pre-reg commit-before-compute → run on the harness → blind adversary subagent → bank ONLY if it clears
  → halt-and-report on any surprise), score on **condensed** (promotable), report BOTH oracles:
  1. **`.9`** substrate hygiene (duplicate `canonical_name`s) — pure DB analysis, no infra.
  2. **`.6`** traversal-augmented retrieval (vector recall → traverse `public.facts` → re-score) — pure harness.
  3. **`.5`** embedding upgrade — pull **bge-m3** via Ollama, re-embed one corpus, re-measure NAME + fusion vs nomic-embed-text.
  4. **`.3`** generalization — **PRE-REGISTER ONLY** (frozen prereg + a staged one-command ingest); **do NOT ingest** (multi-hour, shared-DB risk — attended only).
- **DEFERRED to attended (NOT overnight):** `.4` cross-encoder reranker (serving not Ollama-native),
  `.7` Graph C baseline (needs a substrate check), `.8` community summaries, and the `.3` ingest itself.
- **Untracked, does not matter:** `prereg-artifacts/candidate-breadth-results.json` (regenerable; banked via doc 18). Pre-existing/unrelated: `.claude/scheduled_tasks.lock` (M), `viz-arxiv-nlp.png` (??).
- **Open user-decisions:** none — the 3 overnight-scope questions are answered (defer .3 ingest; .5 embedding only; auto-bank after adversary).

## Next action
- **Launch the overnight queue** via the goal prompt (see the session's final message / clipboard).
  Start with `/pickup` to verify state, then drive `.9 → .6 → .5 → .3(prereg-only)`.
- Claim: `bd update nmemo-u8j.9 --claim`. Copy doc 17/18 as the prereg/results template.
- Alternative if redirecting: do `.5` first (longest, model download) so it runs while you sleep.

## Active traps (right now)
- **Infra UP:** postgres :5433 (`nmemo-postgres-1`, healthy) + qdrant :6335 (docker); ML :8000 (provider=claude); Ollama :11434 (only `nomic-embed-text` present — **`.5` must `ollama pull bge-m3` first**).
- Substrate in `cognitive_test`: dal-nlp 1133 / dal-cv 1262 / arxiv-nlp 1230 / arxiv-cv 1282 entities.
- Standing repo traps: **tsc baseline = 69** (`cd platform && npx tsc --noEmit`; compare, don't "fix" — and use `--noEmit` or tsc litters `.js`/`.d.ts` under `scripts/`); `platform/src/index.ts` NUL bytes → `grep -a`; `rawQuery` rewrites snake_case→camelCase; **measure DELTAS not absolute R@10** (tie-break sensitive); **NEVER DELETE / unscoped-write `cognitive_test`** (holds the load-bearing substrate — corpus-scoped reads only; this is why `.3` ingest is attended-only).
- Discipline (do not relitigate): task = find-the-relevant-set, **condensed promotes** (`.10`); every result reports both oracles + all 3 bootstraps (pair/entity/doc, seed 20260831); blind adversary before any bank.

## Verification checklist for /pickup
- [ ] branch == feat/single-graph-retrieval, HEAD == e8764f2 (else commits landed — reconcile)
- [ ] infra up (postgres/qdrant/ml/ollama); `bge-m3` pulled before `.5`
- [ ] substrate counts match (dal/arxiv above)
- [ ] `bd ready` shows `.9 .6 .5 .3` open; `.1 .2 .10 .11` closed; `nmemo-u8j` not restructured
- [ ] tsc baseline still 69 (`npx tsc --noEmit` from `platform/`) before any code work
- [ ] no background agent assumed — re-launch any experiment's blind adversary fresh
