# Doc 42 — CARRY-FORWARD INVENTORY: what 214 commits built, and what survives into single-graph optimisation with many graphs per user

**Date:** 2026-08-31 · **Branch:** `feat/cross-corpus-audit` (214 commits over `feat/cognitive-platform-v1`)
**Purpose:** the multi-graph *retrieval* thesis is dropped (doc 37, doc 39 §5). This document takes
inventory of everything the arc actually built and asks a different question of each piece: **does it
serve a system of single, well-optimised graphs — several per user, isolated from each other?**

Tags as doc 39: **[M]** measured · **[C]** read off code · **[I]** inferred · **[U]** untested.

**The headline reframe.** `corpus_id` was built to let two corpora be *compared*. Structurally it is
graph **isolation**, which is what per-user multi-graph and multi-tenant both need. The machinery is
real and tested. But it was built to a comparison threat model — accidental *fusion* — so it is enforced
hard on **writes** and barely on **reads**. For comparison an unscoped read is a wrong answer; for
tenancy it is a data leak. That difference decides most of the work below.

---

## 1. KEEP AS-IS — the isolation substrate

| what | where | status |
|---|---|---|
| `corpus_id` partition key on the instance tables | mig `052_corpus_scoping.sql` | **[M]** 0 of 5,714 facts have cross-corpus endpoints |
| composite `UNIQUE(id, corpus_id)` on entities + composite FKs on `facts` and `merge_candidates` (`MATCH SIMPLE`, so a nullable object endpoint is skipped) | mig 052 §2 | **[M]** actively caught a real breach |
| `corpus_id` immutability trigger (`BEFORE UPDATE`, `reject_corpus_id_change`) | mig 052 §3 | **[M]** closes the bulk-`UPDATE` bypass that would migrate a row between graphs outside `entity_merges` |
| corpus-scoped entity reuse on the production epoch path | `promotion.ts:313-319`, with the comment saying why | **[C]** correct |
| per-graph behaviour knob: `assimilating` / `comparative`, read as data and passed **into** the pure planner so it stays DB-free | mig `055_corpus_policies.sql`, `corpus-policy.ts` | **[C]** good shape |
| acceptance suite: non-fusion, `23503` composite-FK, `23514` immutability, bridge round-trip, hallucinated-endpoint drop, replay idempotency, arbiter escalation | `src/test/cross-corpus.test.ts` | **[M]** 8/8 green |

This is a genuinely good isolation core, and the design decision recorded in mig 052 line 13 is the one
to be deliberate about:

> `fact_predicates` / `entity_types` stay **GLOBAL** (ontology, not instance data) — not scoped.

**That is right for many-graphs-per-user and wrong for multi-tenant.** One user's several graphs *should*
share a vocabulary — that is what makes them comparable and what lets an ontology investment pay off
across them. Two customers must not. If tenancy is ever real, the ontology tables need a tenant key and
the "global" comment becomes a bug. Decide it once, deliberately, rather than discovering it.

## 2. MUST CLOSE — isolation gaps, in severity order

**2.1 `createEntity` dedups globally and ignores `corpus_id`. [C]**
`entities.ts:251-257` matches on `lower(canonical_name)` + `entity_type` with no corpus predicate. The
arc's own workaround is a *second, bespoke* ingest path: `corpus-ingest.ts` exists precisely because
"`createEntity` dedups GLOBALLY — it ignores `corpus_id` — so the same symbol name in two corpora would
collapse onto one entity". So the **default** entity path is not graph-isolated; only the epoch path
(§1) and the cross-corpus path are. With the composite FK in place this surfaces as an ingest **error**
rather than a silent leak — the backstop working as designed — but a system with many graphs per user
would hit it constantly, because the same name recurring across a user's graphs is the normal case, not
the exception.

**2.2 Qdrant has no graph partition at all. [C]**
`qdrant.ts` filters by `stream_id`, never `corpus_id`. `corpus_id` isolation stops at the Postgres
boundary, so semantic search over raw source texts spans every graph in the collection. Compounding it,
doc 39 §3.9: `NODE_ENV=test` does not isolate Qdrant either, and a 294-document run wrote 11,927 points
into the shared `memories` collection. For per-user graphs this is the largest single gap — the vector
store is the one component with no isolation story.

**2.3 Isolation is enforced on writes, not reads — and it is a recurring class, not a one-off. [C][M]**
Roughly 39 services that issue queries, search, or traversal carry no corpus predicate, including
`graph.ts`, `graph-fallback.ts`, `graph-canonical-query.ts`, `graph-canonical-semantic.ts`, `topology.ts`
and `entity-profile.ts`. Doc 39 §2.1 records **five** unscoped corpus paths found and fixed across this
arc, the last being `resolve_anchor`'s *read* path (`c1da213`) — "separation had been enforced on writes
but not on the lookup the agent uses to decide identity." Five found by hand means the sixth exists.
This needs a structural answer, not another audit: a scoped query helper that cannot be bypassed, or
Postgres row-level security keyed on the graph, so a missing predicate fails closed.

**2.4 The AGE traversal index has no graph partition, on top of already being untrustworthy. [C][M]**
No `corpus_id` in the graph at all, plus doc 39 §3.5: no DELETE trigger, 2.05x oversized on vertices,
1.76x on edges, and structurally unable to represent fact expiry. Cypher traversal would see every
graph's deleted entities and expired facts as live. Doc 39 §7.10's guidance already stands — use SQL
recursion over `public.facts` — which means AGE is currently a liability carrying an index cost. Either
partition and prune it or retire it.

**2.5 No actor-to-graph binding. [C]**
`ACTOR_TOOL_ALLOWLIST` (`causal-agent.ts`, audited by `actor-tool-allowlist.test.ts`) gates which
**tools** an actor holds — a proposer structurally cannot hold a canonical-write tool, which is
excellent. It does not gate which **graph** an actor may touch. For per-user graphs the allowlist needs a
second axis.

## 3. KEEP — single-graph quality machinery, independent of graph count

This is the largest and healthiest body of work on the branch, and none of it depends on the multi-graph
thesis.

**Ingestion architecture (mig 040-043).** The epoch-v2 propose/promote split: parallel agents write
candidates into staging with no canonical writes, then **one deterministic writer, one transaction**.
Promotion is **[M]** order-independent and replayable (the E8 litmus). This is the single best structural
decision on the branch — it is what makes every experiment above reproducible — and it is the right
shape for any number of graphs. `staging_proposals`, `promotion_actor`, `staging_supersedes_hint`,
`arbiter_verdicts`.

**Deterministic-disposal discipline.** Pure planners separated from appliers throughout —
`promotion-plan.ts` / `promotion.ts`, `causal-promotion-plan.ts` / `causal-promotion.ts`,
`planBridgePromotion` / `applyBridgePromotion`. Agents propose, code disposes. Keep this as a rule.

**Integrity checking.** `graph-invariants.ts` — pure, DB-free, LLM-free invariants over a graph dump
returning the offending rows, built to catch exactly the cross-predicate sprawl the ontology misses
(five coexisting active title facts; `headquartered_in` both boston and austin). Plus
`exclusive-groups.ts` and mig `039_canonical_role_hq_predicates.sql`. This is reusable per-graph health
tooling and it is the kind of thing single-graph optimisation needs more of.

**Escalation instead of silent binding.** `promotion-arbiter.ts` + mig 043. When identity is ambiguous
the planner escalates rather than guessing. Keep.

**Operational resilience.** `ingest-ledger.ts` + `scripts/ingest-resumable.ts` — durable sub-batch
ledger, resumes after a session limit or a reboot without re-ingesting; `session-limit.ts` parses the
reset time instead of retry-looping. `concurrency.ts`. `audit-ledger.ts` / `audit-pass.ts`. Cost
tracking: mig `050_llm_usage.sql`, `usage.ts`, `usage-report.ts`. All of this is unglamorous and all of
it is the reason the 294-document run completed at all.

**Measurement infrastructure.** `benchmark-snapshot.ts` / `benchmark-aggregate.ts` /
`benchmark-report.ts`, `graph-correctness.ts`, `graph-instrumentation.ts`, `graph-review.ts`,
`graph-stats.ts`, `topology.ts`, and the `bench-topology-*` scripts. Keep — single-graph optimisation is
a measurement problem and this is the harness.

**Predicate machinery (mig 045 + 6 modules).** `predicate-resolve.ts`, `predicate-embeddings.ts`,
`predicate-ontology.ts`, `predicate-signature.ts`, and Python `predicate_normalization.py` /
`predicate_scoring.py` / `resolve_predicate.py`. Architecturally sound — deterministic, model-free,
stateless, well-tested. **Do not run it as calibrated** (§5.7, bead `nmemo-4g9`). Keep the machinery,
fix the weights.

## 4. PARK, DO NOT DELETE — built for multi-graph, still the right tool for many-graphs-per-user

**4.1 The `bridge_edges` family (mig 054, 056) + `bridge-promotion.ts`. KEEP — promote it.**
A bridge is a saved, reasoned, sourced connection between two things in **different** graphs, with
`reasoning` and `source_references` NOT NULL, polymorphic endpoints validated by existence at disposal
time (an unresolvable endpoint is dropped, not stored), and **replay-idempotent corroboration** via an
`invocation_id` single-slot token so re-running leaves `corroboration_count` unchanged.

**This is the only built mechanism for relating two isolated graphs without fusing them**, and "several
graphs per user that stay separate but can be related" is exactly the stated direction. What failed in
doc 37 was bridges as a *retrieval* substrate. Bridges as an explicit, auditable, user-visible link
between two of your graphs were never tested and are a different product claim. **[U]**

**4.2 Element catalogs (mig 053) + `element-catalogs.ts`. KEEP as a pattern.**
Bare rows, never `entities` — "zero fusion surface by construction" — with ids from a pure resolver
(`uuidV5(scheme|corpus|canonical_symbol)`), so they are stable, hand-seedable, and need no DB round
trip. That is a generally useful pattern for any reference data that must never participate in entity
fusion, plus `element_embeddings` as a separate vector table. Reusable well beyond code and rules.

**4.3 `corpus-ingest.ts` — mine it, then delete it.**
It is a workaround for §2.1, but it contains behaviour we want *globally*: it "always embeds
`name\ndescription` regardless of the global `EMBED_DESCRIPTIONS` flag". Doc 39 §3.2 records that the
production epoch path does the **opposite** — `promotion-plan.ts:534` hardcodes `summary: null`, so
every entity vector embeds a bare name and `EMBED_DESCRIPTIONS=true` is silently a no-op. Two paths,
opposite behaviour, and the *workaround* is the one doing it right. Fix the main path
(bead `nmemo-86z` / `nmemo-yq1`), then this file has no reason to exist.

**4.4 Concept layer (mig 057) + `concept-extraction.ts` / `concept-resolution.ts` /
`concept-multihop.ts`. PARK.**
The retrieval thesis is closed **[M]** across docs 28-33 and 37 — sparse and dense extraction,
mechanical and agentic retrieval, every available oracle. Do not re-litigate. Two things worth keeping
on the record: the negative is **bounded** (doc 39 §5.2 — every concept label came from a bare entity
name *because* of §4.3, so the description-aligned variant is **[U]**), and doc 39 §6 notes **[I]** that
if a third of entities are already abstract nouns, a concept layer may be partly redundant with the
entity layer, which would reframe the failure as missing **node typing**. Node typing is a
single-graph-optimisation question and is worth picking up on its own terms.

**4.5 `docs/.../08-future-hierarchical-corpora.md` — read this before designing per-user graphs.**
It already designed the model now being asked for, and its central insight is better than a flat
per-graph flag:

> the assimilate-vs-compare knob is not a per-corpus flag, it is a **per-edge policy on a corpus graph**.
> Your fusion candidate set is the transitive closure of **assimilate** edges (you and your ancestors);
> **compare** edges never contribute fusion candidates, they get bridges instead.

Graphs form a DAG. A chat blends into its branch, a branch into the codebase. `corpus_policies` (§1)
implements the flat version of this — mode per corpus. The per-edge version is the generalisation, and
it makes "many graphs per user for different purposes" a policy question rather than a schema change.
**[U]**, and not v1.

## 5. Experimental findings that constrain the design

Anything a single-graph optimisation plan must not contradict.

**Works — build on these:**

1. **`corpus_id` partitioning works.** **[M]** 0 cross-corpus facts of 5,714; composite FK catches breaches.
2. **Extraction is stable and domain-insensitive.** **[M]** Median 18 facts/paper in *both* NLP and CV,
   mean 19.5 vs 19.4, 1 paper of 294 under 5 facts. No silent-failure tail. Extraction is not the
   bottleneck.
3. **The graph is navigable.** **[M]** Giant component 65.0% / 73.5%, only ~2.5% isolated singletons.
4. **Promotion is order-independent and replayable.** **[M]** E8 litmus.
5. **Embeddings populate reliably.** **[M]** 2,512/2,512 entities, 5,714/5,714 facts.
6. **Deduplication is sized, not guessed.** **[M]** It lifts the giant component from 66.8%/74.3% to
   ~86% and removes ~40% of components; both corpora converge to ~86%, suggesting the ceiling at this
   extraction density.

**Negatives that bound the ambition:**

7. **Dense embedding is the retrieval engine — including inside its own blind spot.** **[M]** Every graph
   arm lost, at every precision@k, on every oracle, in every configuration tested. Do not plan a graph
   retrieval mechanism that has to beat it. Caveat on the record (doc 39 §5.5): the co-citation oracle
   is ~79% cosine-predictable, so part of that result restates the oracle's bias.
8. **The graph representation added nothing over an agent reading the raw text.** **[M]** doc 29's H-B
   control tied at L=2 and lost at L=3. **But it was measured on a factless substrate** — it tested
   "named concept structure vs text", not "traversable entity+fact graph vs text". **[U]** on the real
   substrate, and it is the most important open question on the branch.
9. **The predicate fold does not fix fragmentation and is net-harmful as calibrated.** **[M]** doc 41:
   2,240 → 2,157 distinct (3.7%, against a 60% bar); precision 0.43 on the decidable subset with a 28.4%
   indefensible floor. Root cause is arithmetic: at `cos=1, tov=1, cn=0` the score maxes at 0.85 below a
   0.89 threshold, so the weight-0.10 jaro-winkler term is **necessary** for any merge — the scorer is a
   string-edit matcher with a semantic gate. The semantic leg cannot carry a merge at any embedding
   quality or type vocabulary.
10. **`EMBED_DESCRIPTIONS` is silently a no-op** on the main path (§4.3). **[C][M]** All 2,512 entities
    have `description` NULL while 92% of staged proposals carried one. This one flag invalidates the
    scope of findings 7 and 8, and it is a two-line fix.
11. **`confidence` is unusable as a filter.** **[M]** Range 0.6-1.0 but only 4.9% below 0.9 and 8 facts
    below 0.8.
12. **Predicate fragmentation costs queryability, not volume.** **[M]** Only 3.8% of edges are redundant.
    Do not sell the ontology fix as data reduction.
13. **Bi-temporality is unexercised, not broken.** **[M]** 99.8% undated, which is *correct* for
    abstracts. Supersession has never run in anger.

**Broken and known:**

14. Causal layer dies at production batch size — `WinError 206` every batch, 9 edges from 147 papers,
    silent because non-fatal by design. **[M]**
15. No provenance on the epoch path — `fact_sources` 0, `memory_entities` 8 of 294, unrecoverable after
    `STAGING_TTL_MS` (1 hour). **[M]**
16. Entity fragmentation is a one-way ratchet — exact `entity_type` match against 338 free-text types,
    merge detection removed from this path, `entity_merges = 0`. **[M]**

**Method finding, and the most transferable thing here:** across this arc **six** readings were
over-stated **in both directions**, every one caught by a blind adversary rather than by self-review;
doc 41 added two more in a single document. Two of the largest findings — the inert predicate fold and
the discarded descriptions — were features **reporting success while doing nothing**. The pre-register /
frozen-harness / blind-adversary loop (doc 39 §8) is not overhead, it is the only thing that has
reliably worked. Keep it, and keep auditing for silent no-ops specifically.

## 6. Suggested sequence

Cheapest and most load-bearing first. Nothing here needs the multi-graph thesis.

**Tier 0 — two-line fixes that invalidate prior conclusions if left alone**

1. Carry the staged entity summary into `entitiesToMint` (`nmemo-86z` / `nmemo-yq1`). Un-breaks
   `EMBED_DESCRIPTIONS`, which bounds findings 7 and 8 (§5.10) and is the one retrieval lever never
   tested.
2. Split the epoch predicate log line into self-resolved / redirected / minted / deferred
   (`nmemo-3aq`) — a metric that currently reports work it did not do.

**Tier 1 — make isolation fail closed, before there are many graphs to leak between**

3. Corpus-scope `createEntity` (§2.1), then delete `corpus-ingest.ts` as redundant (§4.3).
4. Give Qdrant a graph partition and set `QDRANT_COLLECTION` explicitly everywhere (§2.2).
5. Make unscoped reads structurally impossible — one scoped query helper, or row-level security (§2.3).
   A sixth hand-found unscoped path is not a plan.
6. Decide the ontology-scoping question deliberately: global across a user's graphs, keyed per tenant
   (§1).

**Tier 2 — single-graph quality, in the order the measurements point**

7. Entity deduplication (`nmemo-x4s`, `nmemo-5fa`). Sized at **[M]** ~86% giant component, ~40% fewer
   components — the largest measured quality win available, and upstream of nearly everything.
8. A controlled `entity_type` vocabulary. ~25 types cover 73.4% **[M]**; 338 free-text types are what
   makes reuse fail and what starves `type_pair_overlap`.
9. Predicate scorer recalibration (`nmemo-4g9`) — reweight so the semantic leg can carry a merge, and
   add a negation / polarity / ordinal veto analogous to the inverse guard. Only then run the
   embedding backfill (`nmemo-w2p`, now P2).
10. Provenance at ingest time (`nmemo-ygk`) and the causal-layer batch-size failure (`nmemo-8rm`).
11. Decide AGE's fate — partition and prune, or retire (§2.4, `nmemo-n6k`).

**Tier 3 — the question worth answering before building more graph machinery**

12. Re-run doc 29's H-B control on a substrate that has **facts and descriptions** (§5.8, §5.10). It is
    the only test that tells us whether the graph earns its complexity over an agent reading text. If it
    ties again with descriptions in the vectors, that is decisive and should change the roadmap. If the
    graph wins, every item in Tier 2 has a known payoff. Pre-register it properly.
13. Only then: bridges as an explicit user-facing link between two of a user's graphs (§4.1), and the
    per-edge assimilate/compare DAG (§4.5).
