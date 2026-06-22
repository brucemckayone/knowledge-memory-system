# 40 — Epoch Ingestion: Issues & Hardening Roadmap (Approach A)

**Status:** Design — issues catalog for review
**Branch:** `feat/parallel-ingestion`
**Decision:** Adopt **epoch (Approach A)** as the parallel-ingestion strategy. The 2026-06-09 benchmark ([results](../../benchmarks/results/parallel-ingestion-2026-06-09.md)) showed epoch is cheaper, more operationally robust, and produces cleaner graphs than optimistic (Approach B), and that its weaknesses are *deterministic and addressable* rather than inherent. This doc catalogs the gap between the **current `runEpochBatch` code** and a production-grade Approach A (per [38](38-parallel-ingestion.md)), so review can be targeted issue-by-issue.

> Read each issue as a standalone unit: **what the code does today → the gap → evidence → fix direction → why it's addressable**. Priority order; I1–I3 are the headline fixes that close the benchmark's actual failures.

---

## Current code state (what `runEpochBatch` does today)

`pipeline.ts: runEpochBatch` is a **single-epoch** simplification of doc 38's Approach A:

1. **Phase 1 — store all chunks** (`mapWithConcurrency`, bounded by `concurrency`).
2. **Phase 2 — parallel agent extraction** (`mapWithConcurrency` + `withRetry`), agents write the live graph concurrently ("free-for-all writes").
3. **Phase 3 — one barrier reconcile** over touched entities: `filterLiveEntityIds → updateEntityMeta → detectMergeCandidates → maybeTriggerReconciliation`, wrapped in a **warn-only** try/catch.

It relies on **P1** (`uniq_facts_active_triple`) for fact-dedup at write time, and a band-aid (`filterLiveEntityIds`) instead of **P3**. It is **one big epoch** — there is no snapshot isolation, no epoch boundary, and no chunk-order realignment. Those were deferred, not built.

---

## Issues

### I1 — Supersession matches an exact predicate, not the exclusive *group* *(highest leverage)*
**Today:** `createFact` checks `getPredicateInfo(predicate).isExclusive`, then `findSupersedingFacts` expires prior actives with `eq(facts.predicate, predicate)` — an **exact predicate-string match** (`facts.ts:148,412`). A new `job_title` only supersedes an old `job_title`.
**Gap:** the system already knows the *cross-predicate* exclusivity groups — `resolveExclusiveGroup` + `AUGMENTATION_GROUPS` fold `job_title`/`title`/`ceo_of`/`role_at`/`has_role` into one role group (`graph-invariants.ts:35,55`) — but that map is used **only for detection** (the `singleActivePerExclusiveGroup` invariant). `createFact` never consumes it.
**Evidence:** the invariant fails in 5 of 6 benchmark runs; optimistic held `has_job_title=CTO` *and* `has_job_title=engineering lead` *and* `job_title=engineering lead` active at once; Helix carried `lives_in`/`relocated_to`/`headquartered_in` in parallel. The `.10` fix canonicalized a narrow title/HQ set but new sprawl (`has_job_title`, `has_role`) slips past it.
**Fix:** lift `resolveExclusiveGroup` into a shared module and have `findSupersedingFacts` match on the **resolved group** (all member predicates), not the raw string. Deterministic, no LLM, fixes the single biggest failure.

### I2 — No `chunk_index` temporal realignment → order-dependence
**Today:** supersession is purely `valid_at`-based in `createFact`; `chunk_index` is persisted on each memory but never used (`runEpochBatch` NOTE: realignment "is not yet applied").
**Gap:** when the agent extracts a reliable absolute date, supersession is order-independent; when it omits or mis-extracts `valid_at`, **commit order leaks into temporal order** — the doc-05/38 "Bug B".
**Evidence:** litmus fact-F1 0.18–0.38 reverse vs forward; c10 epoch dropped 0.67→0.33 forward-to-reverse. Order matters today.
**Fix:** the deterministic, DB-reactive realign cadence from [38 §3](38-parallel-ingestion.md) — when "all chunks of a source committed", sort that source's facts by `chunk_index` and re-run supersession in narration order. Deterministic; closes the litmus gap at the barrier instead of paying for it continuously (which is optimistic's only real edge — see benchmark report).

### I3 — Entity dedup is post-hoc, LLM-dependent, and incomplete → split identities
**Today:** the barrier calls `detectMergeCandidates` + fires the LLM `reconciliation_agent` (`maybeTriggerReconciliation`). Fuzzy dedup is "irreducibly post-hoc" by design (38 §3) — but the current post-hoc pass misses real duplicates.
**Gap:** supersession (I1) and current-state correctness are *impossible* across split entities, no matter how good the predicate grouping is.
**Evidence:** optimistic produced **three** Elena entities (`Elena`, `Dr. Elena Vasquez`, `Elena Vasquez`) with her facts fragmented across all three; c10 epoch flagged a `works_at` entity-dup. (`nmemo-wyb`.)
**Fix:** a **deterministic pre-supersession merge** at the barrier — normalize name+type, merge obvious variants (title-prefix, first-name-only) *before* the LLM tail and *before* the group-supersession of I1 runs. Reserve the LLM reconciler for genuinely ambiguous cases. Deterministic-first.

### I4 — One "big epoch", no snapshot isolation
**Today:** `runEpochBatch` is store-all → extract-all → one barrier. There are no multiple epochs and no snapshot isolation.
**Gap:** [38 §5](38-parallel-ingestion.md) specified snapshot-isolated epochs (agents in epoch K read the clean end-of-K-1 state, never each other's in-flight writes) to remove within-epoch read skew. Today every agent can read another agent's half-written, soon-to-be-reconciled state and make a bad inference off it.
**Fix / decision needed:** either (a) implement real epoch boundaries with snapshot isolation, or (b) accept the single-barrier model and make the deterministic reconcile (I1–I3) strong enough that read-skew doesn't matter. Lean (b) first — it's far simpler and the benchmark suggests the deterministic fixes carry most of the weight.

### I5 — Barrier reconcile is warn-only and LLM-leaning, not delta-scoped deterministic-first
**Today:** the Phase-3 reconcile is wrapped in a try/catch that only `console.warn`s; the actual work leans on the LLM `reconciliation_agent`.
**Gap:** [38 §5](38-parallel-ingestion.md) wanted the barrier "deterministic for the bulk; the ambiguous entity-identity tail filed as `merge_candidates`". A swallowed reconcile failure silently leaves the epoch's dup/sprawl debt in the published graph.
**Fix:** make the barrier do deterministic work first (group-supersession I1, entity merge I3, drop post-merge self-loops, resolve `opposing_object` contradictions using `chunk_index`), surface failures instead of warn-and-continue, and only then hand the residue to the LLM.

### I6 — FK-violation band-aid instead of P3 (redirect tombstone)
**Today:** `filterLiveEntityIds` (`pipeline.ts:508`) drops merged-away entity ids before the reconcile to avoid FK violations from a concurrent merge/delete.
**Gap:** that's a workaround for doc-05 "Bug C" (`nmemo-3bp`: `create_fact` FK violations under parallel ingestion). The real fix is **P3** — a `merged_into` forward-redirect column and switching `facts.subject_entity_id` off `ON DELETE CASCADE` to redirect-or-RESTRICT, so a late write resolves onto the survivor instead of destroying data.
**Fix:** implement P3; retire the band-aid. (For pure single-barrier epoch, P3 is "optional" per 38, but it removes a whole class of silent data loss and is needed the moment reconcile overlaps writes.)

### I7 — Orphan entities survive the barrier
**Today:** nothing prunes entities left with zero active facts after supersession/merge.
**Evidence:** c20 epoch failed the `orphanEntities` invariant (merge tombstones / fully-superseded entities lingering).
**Fix:** a deterministic barrier cleanup — after merge + supersession, drop or flag entities with no active fact and not a fresh arrival.

### I8 — Single barrier = no mid-run correction
**Today:** one barrier at the end; an extraction error committed during Phase 2 survives to the final graph.
**Gap:** optimistic's continuous loop demonstrably self-corrected a bad extraction mid-run (benchmark report §4.3) — epoch's one-shot barrier cannot.
**Fix:** cheapest option is a deterministic post-barrier validator (e.g. re-check exclusivity + obvious value/entity-type mismatches like the turbo `job_title=<company>` bug) rather than paying optimistic's continuous-reconcile tax. Multiple epoch barriers (I4a) would also give correction points.

---

## Roadmap (suggested order)

1. **I1 (group supersession)** + **I3 (deterministic entity dedup)** — together they close the benchmark's headline failures and are pure deterministic wins. Do first.
2. **I2 (`chunk_index` realign)** — closes the order-dependence / litmus gap; the deterministic alternative to optimistic's continuous reconcile.
3. **I5 (deterministic-first barrier)** + **I7 (orphan cleanup)** — make the barrier trustworthy and self-cleaning.
4. **I6 (P3 redirect)** — retire the FK band-aid; required before any reconcile-overlaps-writes evolution.
5. **I4 (snapshot isolation)** + **I8 (mid-run correction)** — only if I1–I3 prove insufficient; likely deferrable.

## Non-goals
- Adopting optimistic's continuous reconcile loop (rejected: cost, operational fragility, entity-dup — see benchmark report).
- Building snapshot isolation (I4a) before the deterministic fixes prove the simpler single-barrier model is the bottleneck.

## References
- [38 — Parallel Ingestion](38-parallel-ingestion.md) (Approach A spec, P1/P2/P3, litmus, Bugs A/B/C)
- [39 — Graph Validity & Quality Harness](39-graph-validity-harness.md)
- [Benchmark report 2026-06-09](../../benchmarks/results/parallel-ingestion-2026-06-09.md) (A-vs-B evidence, the three faces of the supersession failure)
- **Code:** `pipeline.ts` (`runEpochBatch`, `filterLiveEntityIds:508`) · `facts.ts` (`createFact:148`, `findSupersedingFacts:401`) · `graph-invariants.ts` (`resolveExclusiveGroup:55`, `AUGMENTATION_GROUPS:35`) · `predicate-ontology.ts` (`normalizePredicate`, `getPredicateInfo`)
- **Beads:** `nmemo-bsb` (supersession), `nmemo-wyb` (entity dup), `nmemo-3bp` (FK violations / P3)
