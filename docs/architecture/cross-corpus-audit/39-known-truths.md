# Doc 39 — KNOWN TRUTHS about this system, and how to operate it best

**Date:** 2026-08-28 · **Branch:** `feat/cross-corpus-audit` (206 commits over `feat/cognitive-platform-v1`)
**Basis:** docs 20–38 of this arc, the `nmemo-213` predicate-ontology work, the epoch-v2 (`nmemo-vpz`)
series, and a 294-document out-of-domain production run with full logs and a queryable result graph.

Every claim is tagged: **[M]** measured directly · **[C]** read off code · **[I]** inferred, plausible
but unverified · **[U]** untested. Nothing here is tagged as established unless it is.

---

## 1. What the system is

Mnemo is a dual-graph knowledge system. **Graph S** = entities + bi-temporal facts (PostgreSQL +
pgvector + Apache AGE). **Graph C** = causal events/edges with mandatory reasoning + source
references. **The single graph is the design; `corpus_id` is the partition mechanism** (decided
2026-08-28 — the concept super-graph is not pursued as a retrieval layer).

The production ingest path is the **epoch arm**: `store()` → `propose()` (parallel Haiku agents write
candidates into staging, no canonical writes) → `promote()` (one deterministic writer, one
transaction). Agents reach the graph through an MCP tool surface. LLM work is Haiku via `claude -p`
through the Python ML service.

## 2. Built and verified working

1. **`corpus_id` partitioning works.** [M] Zero facts have endpoints in different corpora across
   5,714. Migration 052's composite FK `(object_entity_id, corpus_id) → entities(id, corpus_id)`
   actively caught a real breach. **Five unscoped corpus paths were found and fixed across this arc**;
   the last was `resolve_anchor`'s *read* path (`c1da213`) — separation had been enforced on writes but
   not on the lookup the agent uses to decide identity.
2. **Embeddings populate reliably.** [M] 2,512/2,512 entities and 5,714/5,714 facts.
3. **Extraction volume is stable and domain-insensitive.** [M] Median 18 facts/paper in *both* NLP and
   CV, mean 19.5 vs 19.4, only 1 paper of 294 under 5 facts. No silent-failure tail.
4. **The graph is navigable.** [M] Giant connected component covers 65.0% (`arxiv-nlp`) and 73.5%
   (`arxiv-cv`) of entities; only ~2.5% isolated singletons. Traversal is not structurally blocked.
5. **Promotion is order-independent and replayable.** [M] Established by the epoch-v2 E8 litmus.
6. **Attribution can be captured at 100%** [M] — but only if captured *at ingest time* (§4.4).

## 3. Built but INERT or BROKEN — the highest-value list

**3.1 The predicate fold never runs.** [C][M] `canonicalizeStagedPredicates`
(`predicate-resolve.ts:128-131`) calls `loadPredicateCandidates()`, which filters
**`WHERE embedding IS NOT NULL`** (`:42`). `fact_predicates` holds **48 rows with ZERO embeddings**, so
the candidate list is empty and the function takes its documented graceful-no-op path
(`stats.deferred = facts.length`). Every epoch logs `predicates: reused=0 minted=0 deferred=ALL`.
**The entire `nmemo-213` machinery — doc 42, `/resolve-predicate`, the promote-time fold, stale-canonical
demotion — is built, shipped and inert for want of a setup step.**
**Fix: run `platform/scripts/backfill-predicate-embeddings.ts`.** (Bead P0.)

**3.2 Entity descriptions are discarded.** [C][M] `promotion-plan.ts:534` hardcodes `summary: null`
when building `entitiesToMint`, with no comment justifying it. The plan type declares
`summary: string | null` and `applyPromotion` (`promotion.ts:329`) does
`description: e.summary ?? undefined` — ready for a value that never arrives. **All 2,512 entities have
`description` NULL while 92% of staged proposals carried a real summary.**
**Second-order effect is worse:** `promotion.ts:238` embeds
`entityEmbedTextFor(e.name, e.summary, embedMode)`, so with `summary` always null **every entity vector
embeds the bare name — `EMBED_DESCRIPTIONS=true` is silently a no-op.** (Bead P0.)

**3.3 The causal layer does not populate at production batch size.** [M] Every batch fails with
`Causal agent failed: [WinError 206] The filename or extension is too long` — the epoch scope (~195
facts at `batch=10`) overflows the Windows command-line limit when the ML service spawns the agent.
**147 papers produced 9 causal edges.** The failure is non-fatal by design, therefore silent.

**3.4 No provenance on the epoch path.** [M] `fact_sources = 0`, `memory_entities = 8` for 294
documents. The recovery chain (staged `reasoning` = `facts.source_text`) expires within
`STAGING_TTL_MS` (default **1 hour**), so provenance is unrecoverable after that.

**3.5 The AGE traversal index cannot be trusted.** [C][M] Both sync triggers are
`AFTER INSERT OR UPDATE`; **there is no DELETE trigger**. AGE holds 6,973 vertices against 3,406
entities (2.05x) and 5,534 edges against 3,148 active entity→entity facts (1.76x). Compounding it,
CLAUDE.md already documents that **AGE edge properties do not persist via `SET`**, so fact expiry
cannot be represented on an edge either. **Cypher traversal sees deleted entities and expired facts as
live. The only expiry-correct traversal path in the codebase is SQL recursion over `public.facts`** (as
used by `concept-multihop.ts`). Magnitude is inflated by test churn in the shared test DB; the
mechanism is structural.

**3.6 No dedup path on the epoch arm.** [C][M] `promotion.ts:313` reuses an entity only on
`lower(canonical_name)` **AND an exact `entityType` match**. With 338 free-text types the match rarely
holds — `chatgpt` exists **21 times** as `LLM`, `llm_model`, `SoftwareTool`, `artifact`, `tool`… And
`detectMergeCandidates` was deliberately removed from this path (doc 41 §11). `entity_merges = 0`.
**Fragmentation is a one-way ratchet.**

**3.7 Also empty:** `entity_aliases` 0, `entity_meta` 0 (summaries + centroids), supersession 0.

**3.8 `maxPairs` silently truncates.** [C] `recallMultiHopConcepts` defaults `maxPairs = 100_000` and
warns only to stderr. This corrupted a real measurement (86.4% of 2-hop pairs dropped, hiding the
run's actual headline).

**3.9 `NODE_ENV=test` does not isolate Qdrant.** [C][M] `qdrant.ts:25` resolves
`process.env.QDRANT_COLLECTION ?? 'memories'`; isolation depends on the test *setup* exporting
`memories_test`, which standalone harness scripts do not. The 294-doc run wrote into the shared
`memories` collection (11,927 points) while `memories_test` sits at 0.

## 4. Measured graph quality (the 294-document run)

| property | value |
|---|---|
| predicates | **2,240 distinct**, 1,539 used once (**68.7% hapax**); 26.9% of edges on a once-used predicate |
| entity types | **338 distinct**, 160 used once (47.3%) |
| duplicate entity rows | 19.6% (`arxiv-nlp`) / 15.3% (`arxiv-cv`); 37% / 26% of facts touch one |
| inverse duplication | 96 reciprocal pairs = **6.2% of edges are one relationship counted twice** |
| entity/concept conflation | **33.1% of entity names are abstract nouns** (-ing/-tion/-ment/-ity); 6.3% are 4+ words and read as topics, not entities; at least one malformed name with an unbalanced paren |
| confidence | min 0.6, max 1.0, but only 4.9% below 0.9 and 8 facts below 0.8 — **weak ranking signal, unusable as a filter** |
| degree | mean 3.51, **median 2**, p90 9, p99 20, max 89, zero of degree 0 |
| undated facts | 99.8% — **correct** for abstracts, so bi-temporality and supersession are *unexercised*, not broken |

**Both major fixes are sized, not guessed:** [M]
- ~**100** predicate heads cover **75%** of edges (top 50 → 62.3%, top 200 → 86.5%); ~**25** entity
  types cover **73.4%**. So a seeded ontology is viable; clustering is not required.
- Deduplication lifts the giant component from 66.8%/74.3% to **~86%** and removes ~40% of components.
  Both corpora converge to ~86%, suggesting that is the ceiling at this extraction density.
- **A useful negative:** predicate fragmentation does **not** bloat the graph — only 3.8% of edges are
  redundant. Its cost is *queryability*, not volume. Do not sell the ontology fix as data reduction.

## 5. Settled negatives — precisely scoped

**5.1 The concept layer is not a cross-corpus retrieval mechanism, in any configuration tested.** [M]
Docs 28–33 covered sparse and dense extraction, mechanical and agentic retrieval, and every available
oracle. doc 37 then tested the real multi-hop design on a substrate with genuine facts and 170 both-sided
pivots (against doc 34's audited 4 of 104) and it **failed**: at equal cells single-hop *beats*
multi-hop (0.6589/0.4938 vs 0.7424/0.5313); operating-point precision falls **8.50% → 5.96% → 5.37%**
against a 4.99% base rate; dense embedding is **~2x** every concept arm at every precision@k; and the
2-hop arm proposes **88.5% of the entire pair space at 1.08x chance**.

**5.2 But that negative is bounded.** [M] Every concept label in that substrate came from a **bare
entity name**, because §3.2 discards descriptions. "You never gave it descriptions" is a **correct**
rejoinder. The description-aligned variant is **[U]**.

**5.3 The graph representation adds nothing over the agent reading text** [M] — doc 29's H-B control
(same agent, same pool, structure vs raw abstract) tied at L=2 and STRUCT *lost* at L=3, and the null is
oracle-independent because both arms eat the same oracle noise. **But it was measured on a factless
substrate** (doc 34 §3), so it tested "named concept structure vs text", not "traversable entity+fact
graph vs text". **[U]** on the real substrate.

**5.4 Dense embedding is the retrieval engine**, including inside its own blind spot [M] (doc 31:
concept layer ~95% blind on low-cosine co-cited pairs, coverage ceiling 4.4%).

**5.5 Oracle caveat that limits 5.1 and 5.4:** co-citation is ~79% cosine-predictable (doc 30), and arm
E's AUC of 0.7943 is numerically indistinguishable from that figure — so "embedding beats the concept
layer" partly restates "the oracle is embedding-aligned". The de-circularised within-slice comparison
separates **nothing** (S0 0.6126 / M1 0.6179 / E 0.6171, all CIs spanning zero).

## 6. Open and untested

- **[U]** Whether the predicate fold works once embeddings are backfilled (§3.1). Now a genuinely
  informative experiment — outcome unknown.
- **[U]** Whether the 48 personal/CRM predicates suit other domains. Never exercised, because the fold
  deferred everything. **This was previously asserted as the root cause and that was wrong.**
- **[U]** Description-aligned nodes — the one retrieval lever never tested.
- **[U]** Node typing (things vs topics). **[I]** If a third of entities are already abstractions, a
  concept layer above them may be partly *redundant with the entity layer*, which would reframe doc 37's
  failure as missing node typing rather than as concept-linking being wrong.
- **[U]** The fragmentation counterfactual — what a *merged* graph actually does (41% of S0's and 29% of
  M1's hard-slice coverage rides on duplicated entities).
- **[U]** Agent-over-graph on a substrate that has facts.

## 7. How to operate it best — practical checklist

**Before any ingest**
1. **Run `platform/scripts/backfill-predicate-embeddings.ts`** or predicate canonicalisation is a
   silent no-op (§3.1).
2. **Set `QDRANT_COLLECTION` explicitly** — `NODE_ENV=test` does not isolate Qdrant (§3.9).
3. `NODE_ENV=test` **skips dotenv**, so `QDRANT_URL` and `ML_SERVICES_URL` must be passed explicitly or
   they fall back to wrong ports.
4. Raise **`STAGING_TTL_MS`** if you need provenance — the default 1 hour garbage-collects it (§3.4).
5. `EMBED_DESCRIPTIONS=true` currently does nothing for entity vectors until §3.2 is fixed.

**During**
6. **Never pipe `tsx` through `grep`** — `&&` then reads grep's exit code, which once launched a second
   ingest after the first had failed.
7. `runEpochBatch` returns **one aggregated result per epoch**, so `batch=10` gives batch-level, not
   paper-level, attribution. Capture attribution **per batch at ingest time**.
8. Session/spend limits surface as HTTP 429 wrapped in a 500. They are **not** retryable and fail fast
   by design; ledger-based harnesses resume cleanly.
9. Editing a watched `platform/src/*.ts` mid-run hot-reloads the server and kills the held batch.

**Querying / traversal**
10. **Use SQL recursion over `public.facts`, not AGE Cypher** (§3.5).
11. Do not use `confidence` as a filter threshold (§4).
12. Expect hub domination in any PageRank-style ranking — median degree is 2, max 89 (§4).

**Testing against a shared DB**
13. **Check what a suite's cleanup deletes unscoped before running it.** Two suites have destroyed the
    doc-20 concept substrate with an unscoped `DELETE FROM bridge_edges`. **The loss is silent:**
    `multihop-identity-check.ts` then prints `0 pairs / 0 pairs / PASS`, a vacuous pass. A genuine
    anchor is 10/10 with zero set difference. `rebuild-doc20-bridges.ts` restores it.
14. `cognitive_test` is never truncated, so debris accumulates against common fixture names.

**Infrastructure**
15. Docker gives Postgres **5433** and Qdrant **6335**. Ollama and the ML service run on the **host** and
    **die between sessions**. ML service: `PYTHONIOENCODING=utf-8 LLM_PROVIDER=claude
    ./.venv/Scripts/uvicorn.exe app.main:app --host 0.0.0.0 --port 8000 --http h11`.

## 8. The meta-truth: how to run experiments here

This arc records **six** instances of a favourable-or-unfavourable reading being over-stated, **in both
directions**, every one caught by a blind adversary rather than by self-review. The most recent: a
published "discrimination down" headline whose CI spanned zero and flipped under two sensitivities.

Non-negotiables, learned the hard way:
- **Pre-register the metric and pass/fail bar, and commit to git, before computing any number.**
- **A blind adversary reviews before any claim is banked** — fresh context, given the pre-registration
  and raw artifacts, tasked in *both* directions, and explicitly told to audit any harness changes the
  author made as hard as the result.
- **Report ties as ties.** A CI touching zero is not a win *or* a loss.
- **Prefer deterministic set arithmetic over interpretation** — the interpretive claims are the ones
  that get cut.
- **Audit the harness against the frozen pre-registration before running it.** On doc 35, three of its
  required metrics were missing or wrong (bar 3 unimplemented, so the run could not be graded at all;
  the frontier metric absent; arm E scoring a missing embedding as a perfect 1.0). All were found
  pre-numbers; after the numbers, fixing them would have been indistinguishable from tuning.
- **Watch for silent no-ops.** Two of this arc's biggest findings — the inert predicate fold and the
  discarded descriptions — were features that reported success while doing nothing.
- **Outstanding adversary debts: doc 32 (skipped by user decision) and doc 33.**
