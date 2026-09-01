# HANDOVER — 2026-09-01 · branch feat/single-graph-retrieval · HEAD 590f5ac

## Source of truth (read these, in order)
- **Ledger:** `docs/architecture/single-graph/09-experiment-ledger.md` — loop state + one row per experiment (E0, R1–R4, BH-1).
- **Epic:** `nmemo-u8j` — `bd show nmemo-u8j`, `bd ready`. 10 children (.1–.10) with the measure-first gate in the epic notes.
- **Direction:** `CLAUDE.md` "CURRENT DIRECTION" (updated this session with the confirmed fusion result).
- **Results docs:** `docs/architecture/single-graph/` 07 (E0 oracle), 10 (pool-re-rank), 12 (hybrid), 14 (fact-level), 16 (fusion confirmed). Frozen preregs: 06/08/11/13/15.
- **Memory:** `memory/project_retrieval_loop.md` (this session's durable findings), `memory/nmemo_silent_data_traps.md`.

## What changed this session
- Ran a full pre-register→run→blind-adversary→bank loop. All results banked post-adversary.
- **E0** (`07`): the oracle is not the binding constraint (shift +0.0169, spans 0). Added the condensed oracle; both oracles reported downstream.
- **R1 pool-then-re-rank** (`10`): TIE. **R2 shippable hybrid** (`12`): TIE at K=60. **R3 fact-max** (`14`): TIE — 3rd consecutive primary tie.
- **R4** (`16`, commits `0bb3e0e`/`b3c569e`): **entity+fact FUSION CONFIRMED** on the independent arxiv extraction — strict R@10 +0.0724, above 0 on all three bootstraps; adversary re-embedded and reproduced bit-for-bit.
- **BH-1** bug hunt: signature NULL-embedding bug verified CLOSED; filed `nmemo-r51` (`entity_type_history` dead end-to-end).
- Filed epic **`nmemo-u8j`** (+10 children, dependency-wired) for the improvements + research-backed levers.
- Added `/handover` + `/pickup` skills (`590f5ac`).

## Loop / epic state (verbatim from the ledger)
- Retrieval track **CONCLUDED**: 3 single-substrate primary ties settled saturation (R@10 ≈ 0.20–0.23); the one confirmed lever is cross-substrate **fusion** (dense-names ⊕ dense-facts, RRF).
- Epic `nmemo-u8j` ready beads: **.1** (build fusion path), **.2** (eval harness — blocks .3–.7), **.10** (pin-the-task decision), .8, .9. Blocked behind .2: .3 .4 .5 .6 .7. `.3`↔`.4`,`.3`↔`.5` linked.

## IN-FLIGHT — not yet verified/banked
- **None outstanding.** All 4 adversary reviews (E0/R1+R2 grouped, R3, R4) and the BH-1 sweep completed and are banked; no background agent is mid-flight (a fresh session need not wait for or hunt any subagent result).
- **Uncommitted / untracked (NOT from this session — ignore):** `.claude/scheduled_tasks.lock` (M, env), `viz-arxiv-nlp.png` (untracked). Present at session start; unrelated.
- **Regenerable, gitignored (needed to re-run harnesses without re-embedding):** `docs/architecture/single-graph/prereg-artifacts/embed-cache.json` (114MB), `arxiv-embed-cache.json` (36MB). If absent, the harnesses re-embed via Ollama (minutes).
- **Open user-decisions:** none pending. (Epic scope was answered "file all 9 + measure-first gate"; skills request is done.)

## Next action
- **Start the epic.** Natural first pair: `nmemo-u8j.2` (reusable retrieval-eval harness — the instrument that makes the measure-first gate enforceable) → `nmemo-u8j.1` (ship the proven fusion read path). `nmemo-u8j.10` (pin-the-task decision) is a cheap parallel unblock and gates how .3–.8 score.
- Claim with `bd update nmemo-u8j.2 --claim` (or `.1`), then follow `epic-cycle-implementation` if driving bead-by-bead.
- **Alternatives:** `.3` new-domain/sparse confirmation (needs .2 first); or reopen the loop on an untested substrate (.6 traversal, .7 Graph C).

## Active traps (right now)
- **Infra UP:** postgres :5433 (`nmemo-postgres-1`) + qdrant :6335 (docker), ML :8000 (provider=claude), Ollama :11434 (nomic-embed-text). Substrate in `cognitive_test`: dal-nlp 1133 / dal-cv 1262 / arxiv-nlp 1230 / arxiv-cv 1282 entities.
- Standing repo traps still live: **tsc baseline = 69 errors** (compare, don't "fix"; run `npx tsc` from `platform/`); `platform/src/index.ts` NUL bytes → `grep -a`; `rawQuery` rewrites snake_case→camelCase; **absolute R@10 rides on the index-asc tie-break** (dedup off, ~70% duplicate-name targets) → measure DELTAS; never run an integration suite against `cognitive_test` during an ingest (unscoped DELETEs cost data once).
- Literature levers (.4 reranker, .5 embedding, .8 community) are gated: measure-first on a well-populated graph, blind adversary, before any implementation (epic notes).

## Verification checklist for /pickup
- [ ] branch == feat/single-graph-retrieval, HEAD == 590f5ac (else commits landed since — read them)
- [ ] infra up (postgres/qdrant/ml/ollama) as recorded
- [ ] substrate counts match (dal/arxiv entity counts above)
- [ ] `bd ready` still shows .1/.2/.10 open and unclaimed; nmemo-u8j not restructured
- [ ] embed caches present (else expect a re-embed on first harness run)
- [ ] tsc baseline still 69 before any code work
