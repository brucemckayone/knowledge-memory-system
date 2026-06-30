# 38 — Parallel Ingestion

**Status:** Investigation
**Branch:** `feat/parallel-ingestion`
**Date:** 2026-06-01

> Revisits [05 — Temporal Pipeline Redesign](05-temporal-pipeline-redesign.md). Doc 05 diagnosed why parallel ingestion breaks and proposed a two-phase fix; only the serial-FIFO subset shipped. This doc evaluates how to parallelise the expensive agent work *now* without reintroducing the bugs doc 05 catalogued.

---

## 1. Problem

Agent-based ingestion is the throughput bottleneck. Each chunk runs a graph agent (`invokeGraphAgent`, `pipeline.ts:231`) through five phases — ORIENT → EXTRACT → RELATE → CAUSE → VERIFY (doc 07) — which is many sequential LLM tool round-trips: seconds to minutes per chunk. And those runs are **serialised**: `enqueueIngest`/`drainQueue` process one chunk at a time (`pipeline.ts:453`/`:465`), the in-process `writeQueue` serialises every write tool (`causal-agent.ts:1262`).

So **throughput ≈ 1 / agent_runtime**, and N chunks = N sequential runs. Clearing a large corpus means waiting through every agent run end to end.

The goal: run the agent extraction in parallel without reintroducing the bugs that made us serialise in the first place.

> **Measure first.** `timing.graphAgent` is already captured per ingest (`pipeline.ts:238`). Confirm the agent is genuinely >90% of wall-clock before investing in parallelism. Everything below assumes it is.

---

## 2. The consistency bar

Doc 05 §1 catalogued three bug classes that parallel ingestion produced. Any parallel design must clear all three — they are the acceptance bar, not optional polish.

| Bug | What happens | Mechanism |
|-----|--------------|-----------|
| **A — Non-determinism** | Same input → different graph per run | Entity resolution / supersession / merge mutate shared state; whichever async task commits first wins |
| **B — Inverted temporal direction** | The ending supersedes the beginning | If chunk 10 commits before chunk 1, its facts establish first and chunk 1's "supersede" them. `validAt` comes from crude ML hints, not reliable absolute dates, so commit order leaks into temporal order |
| **C — Cascade data loss** | Facts silently vanish, causal events FK-violate | Two chunks create the same entity; merge deletes one; `facts.subject_entity_id ON DELETE CASCADE` wipes facts referencing it |

**Litmus test (doc 05 §1):** *feeding the same document's chunks in reverse order must produce the same knowledge graph.* This is the single best regression test for any design here.

On top of A/B/C, the standing invariants still hold: the audit contract (one history row per mutation, same transaction — doc 12), entity-identity coherence (one referent → one node or an explicit `same_as`), fact dedup/corroboration, and causal integrity (reasoning + source refs, no self-loops).

### What races, and what's already safe

| Hazard | Mitigated today by | Survives parallelism? |
|--------|--------------------|-----------------------|
| Exact-name entity create | `pg_advisory_xact_lock(name,type)` (`entities.ts:98`) | ✅ cross-process safe |
| Fuzzy entity duplicate ("Victor" vs "Victor Frankenstein") | nothing — reconciler cleans up after | ❌ the core quality hazard (Bug A/C feeder) |
| Fact duplicate (same triple) | check-then-insert + in-process `writeQueue` (`facts.ts:174`) | ❌ no DB uniqueness behind it |
| Exclusive-predicate supersession | check-then-supersede, serial | ❌ TOCTOU; Bug B feeder |
| Entity delete vs in-flight write | merge repoints *then* deletes in one tx | ❌ a concurrent writer hits the CASCADE (Bug C) |
| Entity summary write | optimistic lock `expected_summary_updated_at` | ✅ already concurrency-safe |

---

## 3. Shared foundation (common to every option)

Mnemo already runs **two consistency models**: pessimistic serialisation (the FIFO + `writeQueue`, the bottleneck) layered over an **optimistic reconciliation engine** built to clean up after the fact — `merge_candidates`, the reconciliation agent (doc 35), the gardener (doc 36), optimistic summary locking. Parallelising is really *moving the boundary* between "prevent the race" and "let reconciliation absorb it." These pieces are common to all options below.

### Prerequisites (from code investigation)

- **P1 — Fact-triple uniqueness + upsert.** Today fact dedup is pure check-then-insert (`facts.ts:174`) with **no DB constraint**, and the only related heuristic (`opposing_object`, `contradictions.ts`) catches *different* objects, not identical duplicates. Add a partial unique index on `(subject_entity_id, predicate, object_entity_id/object_value) WHERE expired_at IS NULL` and turn `create_fact` into an `ON CONFLICT` upsert → racing identical facts resolve deterministically (one inserts, one corroborates).
- **P2 — Actionable MCP errors.** The MCP layer returns raw `Error: <message>` strings (`graph-mcp.ts:53-57`). "Retry with the error addressed" needs a small semantic vocabulary (`fact_exists→corroborated`, `entity_merged→use_survivor:<id>`, `exclusive_conflict→supersede_or_reconcile`) plus a retry bound.
- **P3 — Forward-redirect tombstone.** Entities keep only the *reverse* pointer `merged_from[]`; there is no forward `merged_into`. Without it, a write to a just-merged entity hits the `ON DELETE CASCADE` (Bug C). A `merged_into` column (and switching the FK from CASCADE to redirect-or-RESTRICT) lets a late write resolve onto the survivor instead of destroying data.

### Two facts that shape every option

- **Fuzzy entity dedup is irreducibly post-hoc.** Two agents inventing "Victor" and "Victor Frankenstein" can't be stopped at the write — different strings, neither committed. That is structurally the reconciler's job (doc 35), always.
- **Temporal alignment is a deterministic, DB-reactive cadence — not an agent.** Sorting a source's facts by chunk position and re-checking supersession is a pure invariant. Per doc 34 Rule 2 + §4.4, that belongs in a background cadence anchored on a DB event ("all chunks of a source committed"), keyed on a new `chunk_index` (+ `source_id`) on the memory. Note `chunk_index` is *narration order*, distinct from `valid_at` (*occurrence order*); it's the fallback ordering signal when the agent can't extract an absolute date.

---

## 4. Baseline option (prior art): Two-phase extract / commit

Doc 05 §4's design, restated:

```
Phase 1  PARALLEL, expensive:   store(chunk,i) → extractRaw(memoryId)   [ML only, NO graph writes]
Phase 2  SEQUENTIAL, cheap:     sort by position → resolve / merge / supersede / causal events  [deterministic]
Phase 3  CAUSAL AGENT, once:    full graph visible → assert causal edges
```

The agent stops being a writer and becomes a pure extractor; one deterministic sequential committer does all graph mutation in document order.

- **Clears the bar trivially:** no parallel graph mutation at all → A solved (deterministic), B solved (position-sorted commit), C solved (single committer, no concurrent delete).
- **Cost:** the agent loses **interactive read-after-write**. It can't resolve "the stranger" against existing entities mid-run, can't query what it just created, can't ground extraction in live graph state. This is the crux that motivates Approaches A and B — they keep the agent writing interactively and pay with concurrency hazards instead.
- **Status:** the shipped serial FIFO is the degenerate form of this (Phase 2 = the whole agent run, serialised).

---

## 5. Approach A — Epoch / bulk-synchronous

Agents write the live graph in parallel with no coordination for an epoch, then a barrier runs a reconcile pass, then repeat.

**Mechanics:**
- **Snapshot-isolated epochs.** Every agent in epoch K reads the clean state from the end of epoch K-1, never each other's in-flight writes. This removes within-epoch read skew (an agent can't make a bad inference off another's half-written, soon-to-be-reconciled state).
- **Lock writes, not extraction.** During the barrier, agents keep doing the expensive LLM work on the next chunk and buffer their writes, flushing when it lifts — so the expensive part never stalls.
- **Delta-scoped, deterministic-first reconcile.** The barrier only inspects what the epoch touched (`detectMergeCandidates(touchedIds)`, `getCausalDelta(from,to)`). Deterministic for the bulk; the ambiguous entity-identity tail is filed as `merge_candidates` and resolved by independent (parallelisable) reconciliation calls.

**Reconcile job list at the barrier:** entity dedup/merge · standalone fact dedup · exclusivity/contradiction resolution (using `chunk_index`) · causal-event repointing · drop post-merge self-loops · publish the next clean snapshot.

**Clears the bar:** A — reconcile is deterministic and delta-scoped. B — reconcile sorts by `chunk_index` before resolving supersession. C — the reconciler owns all merges at the barrier; with no concurrent writer, P3 is *optional* (deletes never overlap live writes).

**Trigger (doc 34 Rule 2):** the epoch boundary is DB-reactive — e.g. "all in-flight agents checkpointed" or a `derived_freshness`-style counter — not "every N agent runs."

**Pros:** agent unchanged; rides the existing reconciliation engine; clear consistency points; the reverse-order litmus test is easy to run per epoch. **Cons:** barrier is a serial point (cheap if deterministic + delta-scoped, a bottleneck if LLM-heavy); bigger epochs reconnect better but carry more dup debt; needs P1.

---

## 6. Approach B — Continuous optimistic concurrency

Agents write the live graph in parallel continuously; the DB arbitrates; failed writes return actionable errors; the agent retries; the reconciler runs continuously alongside.

**Mechanics:**
- **DB is the arbiter.** "Read before write to confirm" is necessary but not sufficient (TOCTOU). The guarantee comes from the *write* failing atomically against a constraint (P1), the MCP translating that into a semantic error (P2), and the agent retrying against fresh state with a bounded retry count.
- **Concurrent reconcile.** The reconciler runs periodically *while* agents write — which means merges and deletes overlap live writes, so **P3 is mandatory** (a write to a merged entity must redirect to the survivor, not hit the CASCADE).

**Clears the bar:** A — DB constraints + per-entity serialisation make writes deterministic at the row level. B — the separate deterministic temporal-alignment cadence (§3) fixes ordering per source. C — the redirect tombstone (P3) replaces cascade-delete.

**Trigger (doc 34 Rule 2):** reconcile and temporal-alignment cadences anchor on DB state (new entities since last run; a source's chunks complete).

**Pros:** highest parallelism (no barrier, no idle agents); agent keeps interactive writes. **Cons:** needs all three prerequisites (P1+P2+P3) and the FK change off CASCADE; retry loops add latency and need careful bounding; no clean global consistency point (harder to reason about / test); dup debt must be measured against reconcile throughput.

---

## 7. Cross-analysis

Columns: **Two-phase** (baseline, doc 05) · **A Epoch** · **B Continuous**.

| Dimension | Two-phase (baseline) | A — Epoch | B — Continuous |
|-----------|----------------------|-----------|----------------|
| Parallelism ceiling | Phase-1 extraction only; commit is serial | High — agents parallel; periodic barrier | Highest — no barrier |
| Agent interactivity (read-after-write) | ❌ lost (pure extractor) | ✅ within epoch (own writes) | ✅ full, live |
| Determinism (Bug A) | Sequential commit | Deterministic barrier reconcile | DB constraints + per-entity serialisation |
| Temporal direction (Bug B) | Position-sorted commit | Sort by `chunk_index` in reconcile | Separate deterministic alignment cadence |
| Cascade loss (Bug C) | No concurrent delete | No concurrent delete (P3 optional) | **P3 mandatory** (redirect, not CASCADE) |
| Fuzzy entity dedup | In sequential commit | Reconciler (post-hoc) | Reconciler (post-hoc) |
| Code changes | New `extractRaw` + Phase-2 committer; agent loses write tools | P1; epoch scheduler; barrier reconcile; snapshot read | P1 + P2 + P3; FK off CASCADE; retry loop; concurrent reconcile |
| Agent-contract change | **Large** (no more writing) | **None** | Small (must handle write-rejection + retry) |
| Reconcile cadence (Rule 2 fit) | n/a (inline) | DB-reactive epoch boundary | DB-reactive counters |
| Failure / recovery | Phase-2 is one transaction-ish flow | Barrier is a clean checkpoint | Hardest — partial state, in-flight retries |
| Convergence risk | None (no dup debt) | Dup debt per epoch, cleared at barrier | Dup debt vs reconcile throughput — must measure |
| Reason-about / test | Easiest | Easy (discrete epochs + litmus per epoch) | Hardest (continuous, no global checkpoint) |

**The real fork:** Two-phase vs {A,B} is "does extraction quality *need* the agent to read its own writes mid-run?" If no → two-phase is simplest and safest. If yes → A or B. Between A and B: A trades a periodic serial barrier for far simpler reasoning and no agent change; B trades more machinery (P1+P2+P3) and harder reasoning for maximum throughput and no barrier.

---

## 8. Open questions / decision gates

1. **Time breakdown** — confirm the agent is >90% of wall-clock (`timing.graphAgent`). If not, parallelism is the wrong lever.
2. **Does extraction need interactivity?** The two-phase-vs-A/B decision rides on this. Run extraction with and without live graph access on the same chunks; compare entity/fact/edge quality. (Largely a measurement, partly a judgement.)
3. **Dup-rate vs reconcile-throughput** — the stability question for A and B. If dup debt accumulates faster than reconcile clears it, the graph degrades. Instrument both.
4. **Connectivity vs serial baseline** — edge density / clustering coefficient of a parallel-built graph vs a serial-built one (the doc 05 §6 serial baseline). Tells us if parallel isolation costs us cross-chunk links.
5. **AGE under concurrent writers** — the `cypher()` MERGE triggers contend under parallel writes (fails open, so correctness-safe but a throughput/log risk). Measure.

---

## 9. Recommendation

**Prototype Approach A (epoch) first.** It is the smallest step that tests the whole thesis: the agent is unchanged, it rides the reconciliation engine that already exists, epochs give clean consistency checkpoints, and the reverse-order litmus test (doc 05) drops straight in per epoch. B is the natural evolution if the barrier tax proves too high; two-phase is the fallback if measurement (#2) shows interactive extraction isn't worth its cost.

**Do P1 regardless.** The fact-triple unique constraint + upsert is correct under *any* concurrency and cheap — it should land before any parallel writers do.

**Settle the temporal question empirically.** Doc 05's bugs B/C confirm out-of-order commits caused real damage; the fix in every option above is "preserve `chunk_index` and resolve supersession in that order." The litmus test proves whether a given design actually achieves it — run it on a real batch before trusting the design.

---

## 10. References

- **Docs:** [05 temporal pipeline](05-temporal-pipeline-redesign.md) (bugs A/B/C, two-phase, litmus test) · [07 graph-agent workflow](07-graph-agent-workflow.md) (5 phases) · [12 audit trail](12-audit-trail-foundation.md) · [32 compute-trigger registry](32-compute-trigger-registry.md) · [34 architectural principles](34-architectural-principles.md) (Rule 2 cadence anchoring) · [35 reconciliation agent](35-reconciliation-agent.md) · [36 gardener agent](36-gardener-agent.md).
- **Code:** `pipeline.ts` (`store:166`, `extract:196`, `ingest:415`, `enqueueIngest:453`, `drainQueue:465`, `timing.graphAgent:238`) · `facts.ts` (`createFact:128`, dedup `:174`, causal-event `:322`) · `entities.ts` (`resolveEntity:223`, advisory lock `:98`, `mergeEntities:560`, delete source `:917`) · `causal.ts` (`createCausalEdge:141`, `cascadeFactExpiry:524`) · `causal-agent.ts` (`GRAPH_TOOLS:83`, `writeQueue:1262`) · `graph-mcp.ts` (raw error surface `:53-57`).
- **Commit:** `540a866` — shipped the serial FIFO ("fixes the temporal-ordering issue when many memories land at once").
