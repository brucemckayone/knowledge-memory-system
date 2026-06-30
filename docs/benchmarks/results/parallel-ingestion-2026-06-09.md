# Parallel-Ingestion Benchmark — Analysis Report

**Date:** 2026-06-09
**Branch:** `feat/parallel-ingestion`
**Corpora:** corpus10 (10 chunks), corpus20 (20 chunks) — one authored Helix-Robotics narrative
**Arms:** `serial` (baseline FIFO), `epoch` (Approach A: parallel + barrier reconcile), `optimistic` (Approach B: continuous concurrency + concurrent reconcile)
**Models:** Haiku (Claude Code → Anthropic) and GLM-5-turbo (Claude Code → Z.AI)

---

## 1. Executive summary

All six benchmark cells ran and are committed. The headline is **not** which ingestion arm is fastest — it's that **temporal supersession is broken in a consistent, structural way across every arm and both models**, and the cross-run + per-graph review explains *why*.

- **Supersession only works when one logical attribute uses one predicate on one entity.** The moment a predicate sprawls (`job_title`/`has_job_title`/`has_role`), an attribute changes predicate between old and new value (`lives_in`→`relocated_to`→`headquartered_in`), or an entity is duplicated, supersession silently fails and mutually-exclusive facts coexist. This is the root of `nmemo-bsb`.
- **The arms trade peak correctness for order-stability.** Serial scores highest forward but is strongly order-dependent; the parallel-reconcile arms score lower but are order-stable.
- **The two models fail differently.** Haiku resolves entities cleanly but leaves stale/dual facts; GLM-5-turbo gets HQ supersession right but mangles `job_title` values into entity references.
- **Infrastructure is now solid** (3 fixes landed), but the run exposed real operational limits (Z.AI 5-hour quota; the judge's only transport can't reach Anthropic).

**Recommendation:** the next unit of work is the supersession fix — predicate canonicalization into exclusive groups **plus** pre-supersession entity dedup — not more arms. Detail in §7.

---

## 2. The benchmark matrix

| corpus / arm | model | current-state (fwd → rev) | exclusive-group invariant | predicate sprawl | runId |
|---|---|---|---|---|---|
| c10 serial | Haiku | 0.67 → 0.33 | FAIL | none | 2026-06-03T06-34-34 |
| c10 epoch | Haiku | 0.67 → 0.33 | FAIL | none | 2026-06-02T14-16-04 |
| c10 optimistic | Haiku | 0.67 (fwd) | **PASS** | none | 2026-06-02T19-44-28 |
| c20 serial | Haiku | **0.75 → 0.38** | FAIL | none | 2026-06-03T07-41-59 |
| c20 epoch | GLM-5-turbo | 0.38 → 0.38 | FAIL **+ orphans** | none | 2026-06-09T09-02-15 |
| c20 optimistic | Haiku | **0.63 → 0.63** | FAIL | `role_title` (2 preds) | 2026-06-09T11-34-11 |

> The first four manifests record `model=pi`; that's a cosmetic mislabel (the driver defaulted the field) — they were actually **Haiku**. Only the two newest carry the real model. Worth correcting in the harness (record the resolved model, not the provider env).

All arms: **0 duplicate-fact rows, 0 dangling FKs, every causal edge carries reasoning + source refs** (the doc-01 causal invariant holds). The failures are semantic, not structural-integrity.

---

## 3. Quantitative findings (deterministic layer)

**3.1 Supersession fails in 5 of 6 runs.** `singleActivePerExclusiveGroup` (≤1 active fact per subject × exclusive-predicate-group) fails everywhere except c10-optimistic-forward (the smallest, easiest case). This is model-independent (Haiku *and* turbo) and arm-independent — i.e. a **pipeline** defect, not LLM noise.

**3.2 The order-stability tradeoff (clean Haiku comparison, c20 serial vs optimistic).**
- **serial**: 0.75 forward, **0.38 reverse** — high peak correctness, strongly order-*dependent*.
- **optimistic**: 0.63 forward, **0.63 reverse** — lower peak, but **order-stable**.

This is the doc-38 thesis made concrete: serial commits in strict order and its supersession leaks commit-order into truth (feed the document backwards and the graph degrades). The continuous-reconcile arm normalizes toward the same state regardless of input order, buying order-independence at a correctness cost. **Counter-intuitive and important:** the parallel arm is *more* robust to reordering than the serial baseline, not less.

**3.3 Correctness degrades with scale.** c10 forward held ~0.67 across arms; c20 trips the exclusive-group invariant on the *forward* pass too. More supersession chains = more chances to miss.

**3.4 Litmus F1 (semantic fwd-vs-reverse) is low everywhere** (fact F1 0.18–0.29). The reverse-order graph genuinely differs from forward — the regression signal doc 38 wanted, and the same bug class that makes naive parallel ingestion dangerous.

---

## 4. Qualitative review — dimension D (LLM-as-judge)

> **How this was run.** The harness judge (`reviewGraph`, doc 39 §2.D) routes through the Pi bridge, which on this host exposes **only `zai/*` models** — `provider=anthropic` returns "Model not found", and Z.AI was rate-limited. So the judge as-configured (`anthropic/claude-opus-4-8`) could not execute via its normal path (itself a finding — see §6). The review below was therefore performed directly by **Opus 4.8 at high reasoning — the exact model the harness judge is configured to use** — reading each arm's rich graph (active + expired facts, causal edges with reasoning, contradictions) against the source narrative. Verdicts use the harness's own categories.

### 4.1 serial / Haiku — verdict: ISSUES
- **current_state (good):** Elena's title supersedes correctly — only `job_title = Chief Technology Officer` is active; junior/senior/engineering-lead are all expired. This is what *working* supersession looks like, and it's why serial scores highest (0.75).
- **current_state (fail) — dual HQ:** `Helix :: lives_in :: Austin (2022)` **and** `Helix :: lives_in :: Boston (2019)` are both active. HQ moved to Austin; Boston should be expired. (A *different* Boston `lives_in` row was expired, so the supersession fired on the wrong row.)
- **faithfulness (fail) — flat error:** `Ohio :: lives_in :: Texas` is simply false. Also `Brightway Stores :: lives_in :: Ohio` (a company "lives_in" a place) — `lives_in` is overloaded for HQ, geographic containment, *and* a hallucinated state-in-state link.
- **supersession (stale):** Marcus Chen `left Helix (2021)` yet `works_at Helix (2019)` is still active.
- **causal_justification (strong):** 19 edges, well-grounded in source ("driven by the success of the Atlas pilot", "Because of the new funding…"). One inferred-not-stated edge (Atlas-v2 status "following standard product lifecycle patterns").

### 4.2 epoch / GLM-5-turbo — verdict: FAIL
- **current_state (good):** HQ supersession is *correct* here — `lives_in Austin` active, `headquartered_in Boston` expired. Better than serial on this axis.
- **faithfulness (severe) — value/entity confusion:** `Elena :: job_title :: Helix Robotics [company]` and `Daniel Okoro :: job_title :: Helix Robotics [company]` — the title slot holds a *company entity reference* instead of the title string ("Chief Technology Officer", "VP of Product"). Elena's actual CTO title is absent. **This is why epoch scores 0.38 — a turbo extraction-quality failure, independent of supersession.**
- **predicate_consistency:** Helix location split across `headquartered_in` *and* `lives_in`; 3 duplicate expired `headquartered_in Boston` rows (dedup miss on the expired side).
- **orphanEntities invariant FAIL:** an entity left with no active fact.
- **causal_justification (strong):** 20 well-reasoned edges.

### 4.3 optimistic / Haiku — verdict: FAIL
- **entity resolution (severe) — three Elenas:** `Dr. Elena Vasquez`, `Elena`, and `Elena Vasquez` are three separate entities. Elena's facts are fragmented across all three (senior engineer on one, perception-lead on another, CTO + engineering-lead on the third). The continuous reconciler never merged them — this is `nmemo-wyb` at its worst, and it *causes* much of the supersession failure (you can't supersede across split identities).
- **supersession + predicate sprawl:** on `Elena Vasquez`, both `has_job_title = CTO` and `has_job_title = engineering lead` are active, *and* a parallel `job_title = engineering lead`. Marcus's role appears under `has_role`, `has_job_title`, **and** `job_title`. HQ under `lives_in Boston`, `relocated_to Austin`, `headquartered_in Austin`. Three predicates, one logical attribute, every time — supersession can't fire across them.
- **highlight — the reconciler self-corrected:** one expired fact reads *"Incorrect extraction. Source states Priya championed the feature 'multi-robot coordination', not Project Atlas itself. Superseded by correct fact … higher confidence."* The continuous-reconcile loop caught and fixed a genuine extraction error — a real strength of Approach B that the other arms didn't show.
- **causal_justification (strong):** 13 edges, well-grounded.

### 4.4 Judge synthesis
The deterministic invariant says "supersession fails" uniformly; the review shows **three different reasons** behind that one number:
1. **Right predicate, wrong row** (serial dual-HQ) — supersession fired but on the wrong fact.
2. **Predicate sprawl** (optimistic `job_title`/`has_job_title`/`has_role`) — supersession can't even see the conflict.
3. **Split identity** (optimistic's 3 Elenas) — conflicting facts live on different entities.
Plus a model-specific extraction bug (turbo's `job_title = company`). Causal reasoning quality is uniformly **good** across all arms — that part of the pipeline is working.

---

## 5. What was fixed this cycle

| commit | fix |
|---|---|
| `cb015dd` | `runSerialBatch` now retries ml-services 503 backpressure (the serial baseline was the *only* arm without retry — an unfair-baseline artifact). |
| `80d203c` | compare driver exits cleanly + prints the failing-arm body instead of crashing with `UV_HANDLE_CLOSING` (nmemo-1tc). This made every later failure legible. |
| `bc379fa` | bounded retry on transient agent `rc=1` (flaky spawn) + per-run `--concurrency` knob for the parallel arms. |

Plus the model switch: the pipeline can run on **GLM via Z.AI** by pointing `claude -p` at `ANTHROPIC_BASE_URL=https://api.z.ai/api/anthropic` (no code change; Claude Code stays the agent runtime, GLM does the inference).

---

## 6. Infrastructure learnings (operational)

- **Z.AI GLM coding plan has a 5-hour rolling usage limit** (`429 code 1308`). Heavy benchmark runs exhaust it; failed calls surface as *hangs* because Claude Code silently retries the 429 against the disabled client timeout. Plan around the window or upgrade.
- **The Pi bridge is Z.AI-only.** It cannot reach Anthropic (`provider=anthropic` → "Model not found"). So the doc-39 judge's default (`anthropic/claude-opus-4-8`) has **no working transport** here — the judge has likely never actually executed. Fix options: add an Anthropic provider to the bridge, or give `reviewGraph` an ml-services/direct invoke path.
- **Per-call subprocess spawns collide at high concurrency** (turbo, concurrency 3): one `rc=1` with 0 tokens = a Claude-Code/MCP spawn that died at startup. The bounded retry now absorbs these; lower concurrency reduces them. The Pi in-process bridge would remove them entirely.
- **Anthropic Haiku is fast** (~78s/chunk vs turbo ~205s) and ran every arm cleanly once its own limit reset.

---

## 7. Recommendations / next work

1. **Fix supersession (`nmemo-bsb`) — the priority.** Two parts, both required:
   a. **Predicate canonicalization into exclusive groups** so `job_title`/`has_job_title`/`has_role`/`title` all map to one `role_title` group, and `lives_in`/`relocated_to`/`headquartered_in` map to one `org_hq` group, *before* the supersession check. (The .10 fix did this for some predicates; the runs show it must be broader and must hold on the optimistic path.)
   b. **Entity dedup before supersession** — fuzzy-merge `Elena`/`Dr. Elena Vasquez`/`Elena Vasquez` so conflicting facts land on one node. Supersession across split identities is impossible.
2. **`nmemo-wyb` (fuzzy entity dup)** is confirmed severe on the optimistic path (3 Elenas) — fold into (1b).
3. **Turbo extraction quality** — the `job_title = <company entity>` confusion is a GLM-5-turbo-specific failure; if turbo is kept, the extraction prompt needs to constrain title slots to value strings.
4. **Harness fixes:** record the resolved model (not the provider env) in the manifest; give the judge a working transport (§6).
5. **For a clean same-model corpus20 comparison:** re-run epoch on Haiku (it's the lone turbo arm; its 0.38 confounds *arm* with *model*).

---

## 8. Caveats (read the numbers with these)

- **corpus20 is mixed-model** — epoch is GLM-5-turbo, serial/optimistic are Haiku. epoch's 0.38 is *not* cleanly comparable to the Haiku arms (extraction-quality vs arm effect are confounded). The clean comparison is c20 serial-vs-optimistic (both Haiku) in §3.2.
- **Dimension D was judged by Opus 4.8 directly, not via the harness's `reviewGraph` path** (which couldn't reach a model — §6). Same model the harness wants; different plumbing.
- **N is small** — one authored corpus, one repeat per cell. Treat scores as directional, the failure-mode analysis (§4) as the durable signal.

---

## 9. Appendix — committed artifacts

Snapshots under `platform/benchmark-results/runs/<runId>/` (`manifest.json` + `metrics.json` + `report.md` tracked; `*.rich.json`/`*.canonical.json` gitignored but on disk). Trend in `platform/benchmark-results/history.jsonl`. Fix commits: `cb015dd`, `80d203c`, `bc379fa`. Snapshot commits: `8daa8e3`, `4789e28`, `5cf954f`, `ca3c5ec`.
