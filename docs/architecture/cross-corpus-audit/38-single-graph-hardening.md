# Doc 38 — Single-graph hardening: what a 294-document out-of-domain run revealed

**Status:** AUDIT + hardening backlog. **Date:** 2026-08-28 · **Branch:** `feat/cross-corpus-audit`
**Disposition (user, 2026-08-28):** the **single graph is the design**; `corpus_id` filtering is
sufficient partitioning. The concept super-graph is not pursued as a retrieval mechanism (doc 37).
This document harvests the run for **single-graph** value.

Every number is a direct query against the graph the production epoch pipeline built, or a read of
shipped code, and is independently re-checkable. No bar, no claim, no adversary needed.

---

## 1. Why this run is worth harvesting

It was designed to test cross-corpus concept retrieval (doc 35), and it answered that in the negative
(doc 37). But in doing so it became something the project had never had: **the first out-of-domain
stress test of the core pipeline at scale** — 294 documents through the real `propose → promote` epoch
path, with full logs and a queryable result graph.

The finding is sharper than the experiment it came from:

> **Every structural layer of the pipeline works. Every semantic layer is empty or inert.**

The pipeline reliably produces volume, embeddings, partitioning and referential integrity. It does not
produce descriptions, aliases, provenance, a controlled vocabulary, deduplication, or causality — on
this domain, at this scale.

## 2. The audit

Corpora `arxiv-nlp` + `arxiv-cv`: 294 abstracts → **2,512 entities / 5,714 facts** (~19 facts/paper).

### 2.1 What works

| layer | evidence |
|---|---|
| `corpus_id` partition | **zero** facts have endpoints in different corpora; migration 052's composite FK caught the one real breach (doc 36 §4) |
| entity embeddings | **2,512 / 2,512** populated |
| fact embeddings | **5,714 / 5,714** populated (with `EMBED_DESCRIPTIONS=true`) |
| extraction volume | ~19 facts/paper, branching structure, hubs to degree 98 |
| FK integrity | no orphans; RESTRICT/composite-FK behaviour held throughout |

### 2.2 What is empty or inert

| layer | value | expected |
|---|---|---|
| entities with a `description` | **0** | ~92% (that share of staged proposals carried a summary) |
| `entity_aliases` | **0** | some — alias resolution is a shipped feature |
| `entity_meta` (summaries, centroids) | **0** | populated by the reconcile pass |
| `fact_sources` | **0** | one per fact |
| `memory_entities` | **8** | ~2,512 |
| facts superseded (`expired_at`) | **0** | some |
| `entity_merges` | **0** | non-zero given 19.6% duplicate rows |
| `causal_edges` from this run | **9** (from 147 papers) | non-trivial |
| facts undated | **5,704 / 5,714 (99.8%)** | domain-correct, see §3.4 |

### 2.3 Vocabulary collapse — both layers

| layer | distinct values | used exactly once | most common |
|---|---|---|---|
| `entity_type` | **338** | **160 (47.3%)** | 298 |
| `predicate` | **2,240** | **1,539 (68.7%)** | 124 |

**26.9% of all facts sit on a predicate that appears nowhere else in the graph** — structurally
unusable for any query that generalises over relation type.

## 3. Root causes, in order of value

### 3.1 The ontology is hardcoded to the personal-memory domain (root cause of §2.3)

`fact_predicates` holds **48 canonical predicates**: `works_at`, `reports_to`, `founded`, with
`subject_type: person`, `object_type: company`. CRM relations. **Every row has `usage_count = 0` and
`last_used_at = NULL` — the ontology has never been used, on any run.**

The scientific corpus needed `evaluated_on`, `outperforms`, `uses_technique`, `has_capability`. None
exist in it. So `resolvePredicate` had nothing to match against and every promotion epoch logged
`predicates: reused=0 minted=0 deferred=ALL`. The edge vocabulary then degenerated to free text.

doc 34 §7 had already noticed the entity half without naming the cause: *"entity types are
memory-domain (`project`, `other`), carrying no scientific signal."* **Both layers of the semantic
backbone are domain-locked, with no mechanism to grow or swap per corpus.** This is the highest-value
finding in the document: it will recur on *every* non-personal-memory deployment.

### 3.2 Fragmentation has no cleanup path on the epoch arm

`promotion.ts:313` reuses an entity only on `lower(canonical_name)` **AND an exact `entityType`
match**. With a 338-value free-text type vocabulary, the exact match rarely holds: `chatgpt` exists
**21 times** in one corpus as `LLM`, `llm_model`, `LLM_Model`, `SoftwareTool`, `artifact`, `tool`,
`system` and 14 more. Result: **241 of 1,230 (19.6%)** and **173 of 1,282 (15.3%)** entity rows are
duplicates, and **37% / 26% of facts** touch one.

And `entity_merges = 0` is not coincidence: `detectMergeCandidates` / the barrier reconcile were
deliberately removed from this path (doc 41 §11, "promotion is the single writer"). **So duplicates
accumulate permanently with nothing to collapse them.** Fragmentation is a one-way ratchet on the
epoch arm.

### 3.3 Descriptions are discarded, which silently defeats `EMBED_DESCRIPTIONS`

`promotion-plan.ts:534` builds `entitiesToMint` with **`summary: null` hardcoded**, with no comment
justifying it, in a function that otherwise carefully derives the display name. The plan type declares
`summary: string | null`; `applyPromotion` (`promotion.ts:329`) does
`description: e.summary ?? undefined`. It is ready to consume a value that never arrives. 1,430 of
1,558 surviving staged proposals (**92%**) carried a real summary.

**The second-order effect is worse than the missing column.** `promotion.ts:238` embeds
`entityEmbedTextFor(e.name, e.summary, embedMode)`. Both ingests ran with `EMBED_DESCRIPTIONS=true`
and the composite path is correctly wired — but with `e.summary` always null, **every entity vector
embedded the bare name.** The flag was on and had nothing to act on. Any future work depending on
description-aligned vectors is silently a no-op until this is fixed.

### 3.4 Provenance is absent on the epoch path

`fact_sources = 0`, `memory_entities = 8`. The epoch path writes neither. Paper-level attribution for
doc 35 existed only because the harness captured it per batch at ingest time; the pipeline itself
retains no fact→source link. Compounding it, `promote()` does not delete consumed staging but
`cleanupAbandonedStaging()` deletes it within `STAGING_TTL_MS` (default 1 hour), so the recovery chain
that *could* rebuild attribution expires within the hour.

### 3.5 The causal layer does not populate at production batch size

Every batch logged `Causal agent failed: [WinError 206] The filename or extension is too long`. The
epoch scope (~195 promoted facts at `batch=10`) overflows the Windows command-line limit when the ML
service spawns the agent. **147 papers produced 9 causal edges.** Graph C is effectively unpopulated
at the batch sizes the pipeline is actually run at.

### 3.6 Not a defect: 99.8% of facts are undated

The agent set `undated=true` for academic abstracts, which is correct — abstracts carry no event
dates. Consequence: the bi-temporal machinery and supersession (`expired_at = 0`) are **unexercised**
on this domain rather than broken. Worth recording so a future reader does not read `superseded = 0`
as a bug.

### 3.7 Sizing the ontology prize (measured 2026-08-28, zero API cost) — the answer is SEED

Before authoring a migration for §3.1, the open question was whether 2,240 predicates represent ~80
relations badly spelled (seed an ontology) or ~900 genuinely distinct relations (cannot author one,
must cluster). Those need opposite fixes. Measured:

- Lowercase + separator normalisation collapses **nothing** (2,240 to 2,240). These are not spelling
  variants; they are already consistent snake_case.
- De-inflected **head token**: 2,240 to **683** heads, of which **308 are used exactly once** and carry
  negligible edge mass.
- **Fact-mass concentration, the number that decides the fix:**

| ontology size | share of all edges covered |
|---|---|
| top 20 heads | **46.4%** |
| top 50 | **62.3%** |
| top 100 | **75.0%** |
| top 200 | **86.5%** |

**An authorable ontology of 50-100 entries captures the bulk. Seeding is viable; clustering is not
required.**

**Why it exploded, and why head-collapsing is safe rather than lossy.** The `uses` family has 90
variants splitting into exactly two mechanisms:

- **grammatical voice** — `uses` (113), `used_for` (14), `used_in` (5), `is_used_in` (5)
- **object-type qualifiers** — `uses_technique` (91), `uses_component` (30), `uses_architecture` (10),
  `uses_model` (8), `uses_encoder` (6), `uses_metric` (6), `uses_dataset` (5), `uses_technology` (5)

`fact_predicates` **already has `subject_type` and `object_type` columns**. So collapsing
`uses_technique` into predicate `uses` plus `object_type: technique` loses **no** information — it
moves specificity out of a free-text string into the typed column designed to hold it. The same pattern
holds for `enables` (67 variants), `achieves` (59), `requires` (54), `trains` (52), `evaluates` (41).

**Bonus: the two halves of §3.1 inform each other.** Those suffixes (`_technique`, `_dataset`,
`_architecture`, `_encoder`, `_metric`) are the agent stating what **entity type** it had in mind. That
is a free signal for deriving the domain's entity-type vocabulary — exactly what the 338 free-text
`entity_type` values failed to produce. Mine the predicate tails to seed the type list rather than
authoring it blind.

**And do not run a re-ingest experiment to confirm the ontology helps.** The mechanism is deterministic
code behaviour, and the concept-linking pass in this same run already showed the model reuses a shown
vocabulary heavily (303 existing labels, only 17 new across corpus B's first 100 entities). Validate
the *fix* on ~20 papers as normal engineering verification instead.

### 3.8 Entity-type sizing, and what fragmentation actually costs

**Entity types are MORE concentrated than predicates**, so the type half of §3.1 is the easier half:
338 raw types normalise to 273, and **top 10 cover 57.4%**, **top 25 cover 73.4%**, top 50 cover 82.8%
of all entities. A seeded type vocabulary needs roughly **25-50 entries**.

**A useful negative: predicate fragmentation does NOT bloat the graph.** Of 2,976 distinct
subject-object entity pairs carrying 3,092 active edges, only **103 pairs** carry more than one
predicate, giving **116 redundant edges = 3.8%**. So the 2,240 predicates are spread across genuinely
*different* assertions rather than duplicating the same ones. **The cost of predicate fragmentation is
queryability, not volume** — 26.9% of edges are unusable for any query that generalises over relation
type, but deduplicating them would not meaningfully shrink the graph. Worth stating before anyone
assumes the ontology fix is a data-reduction exercise.

### 3.9 Graph connectivity — the first clearly positive structural finding

Union-find over the active entity→entity edges, per corpus:

| corpus | entities | edges | components | giant component | isolated singletons |
|---|---|---|---|---|---|
| `arxiv-nlp` | 1,230 | 1,548 | 87 | **800 (65.0%)** | 31 (2.5%) |
| `arxiv-cv` | 1,282 | 1,544 | 72 | **942 (73.5%)** | 31 (2.4%) |

**Two thirds to three quarters of each graph is mutually reachable, with only ~2.5% isolated nodes.**
Traversal is not structurally blocked. This is a genuine green light for the `nmemo-5co` Tier 0
"anchor → filter → traverse" design, which had assumed navigability without evidence.

**Counterfactual: what the fragmentation fix (§3.2) buys in connectivity.** Union entities sharing a
canonical name, then recount. Measured in distinct names on both sides so the denominator is identical:

| corpus | giant component as-is | after deduplication | components |
|---|---|---|---|
| `arxiv-nlp` | 66.8% | **85.6%** (+18.8pp) | 87 → 50 |
| `arxiv-cv` | 74.3% | **86.8%** (+12.5pp) | 72 → 47 |

So fixing fragmentation lifts the giant component to ~86% and removes ~40% of components. Note the two
corpora **converge** to ~86% once deduplicated — which suggests ~86% is the natural connectivity
ceiling at this extraction density, and that the gap between them as-is was fragmentation noise rather
than a real difference between the corpora.

## 4. Hardening backlog

| # | item | why it matters | cost |
|---|---|---|---|
| 1 | **Domain-scoped predicate + entity-type ontology** — seed ~100 head relations, route qualifiers into `object_type`, use the existing candidate-promotion columns for the tail | root cause of 68.7% hapax edges and 47.3% hapax types; recurs on every new domain. **Sized in §3.7: top 100 heads cover 75% of edges, so seeding works** | design + migration |
| 2 | **Carry the staged summary into `entitiesToMint`** (`promotion-plan.ts:534`) | restores descriptions AND un-breaks `EMBED_DESCRIPTIONS` | one line + a decision on reuse-path update |
| 3 | **Give the epoch arm a dedup path** — relax reuse to name-with-type-as-attribute, or restore merge detection | fragmentation is currently a one-way ratchet. **Sized in §3.9: deduplication lifts the giant connected component from 66.8%/74.3% to ~86% and removes ~40% of components** | design |
| 4 | **Write `fact_sources` / `memory_entities` on the epoch path** | provenance is a core promise; today it is unrecoverable after an hour | moderate |
| 5 | **Chunk or file-pass the causal agent scope** | Graph C does not populate at production batch size | moderate |
| 6 | **`nmemo-kgy`** — `mlFetch` never retries its own timeout; `predicate-resolve` degrades silently | silent quality loss on the promotion path | small, needs a deadline cap |
| 7 | **`maxPairs` silent truncation** in `recallMultiHopConcepts` | a shipped service silently caps results; warns to stderr only | small |

## 5. What the cross-corpus work leaves behind, positively

- **`corpus_id` partitioning works and is sufficient.** Four unscoped paths were found and fixed
  during this arc; the fifth (`resolve_anchor`'s read path, `c1da213`) was the last. Zero cross-corpus
  facts across 5,714. The composite FK is what caught the one real breach, and without it the graphs
  would have fused silently.
- **The extraction path produces genuinely traversable structure** on a new domain with no tuning:
  ~19 facts/paper, real hubs, real chains.
- **The adversary process earns its cost.** On this run it reproduced every number bit-exactly, cut my
  load-bearing claim, and found a truncation bug that had hidden the actual result. Five of six
  corrections went against the author.
- **A reusable measurement substrate**: 294 attributed documents, two corpora, frozen oracle, and a
  deterministic scoring harness — available for any future single-graph retrieval question without
  new ingest cost.

## 6. Cheapest high-information next experiment (optional)

If one experiment is wanted, it is **not** another retrieval test. Seed a domain-appropriate predicate
and entity-type ontology, re-ingest ~20 papers, and measure whether the hapax rates and duplicate-row
rates collapse. Direct causal test of §3.1 with an obvious metric, on 20 papers rather than 294, and a
fix to the core system rather than a defence of the concept layer.
