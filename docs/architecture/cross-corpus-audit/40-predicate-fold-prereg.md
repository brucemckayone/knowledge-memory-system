# Doc 40 — PRE-REGISTRATION: does the predicate fold actually reduce predicate fragmentation?

**Date:** 2026-08-28 · **Branch:** `feat/cross-corpus-audit`
**Status:** FROZEN. Committed before any result number was computed.
**Basis:** doc 39 §3.1 (the fold is inert), §4 (2,240 distinct predicates / 68.7% hapax),
§6 (the domain-lock claim was my error and is withdrawn), §8 (experiment discipline).

---

## 1. The question

`canonicalizeStagedPredicates` (`platform/src/services/predicate-resolve.ts:128-131`) has never run.
`loadPredicateCandidates` (`:42`) filters `WHERE embedding IS NOT NULL`; `fact_predicates` holds 48
rows (27 canonical, 21 staging) with **zero** embeddings, so the candidate list is empty and the fold
takes its documented graceful-no-op path. Every epoch has logged
`predicates: reused=0 minted=0 deferred=ALL`.

The 294-document out-of-domain run therefore produced **2,240 distinct predicates over 5,714 facts,
68.7% of them used exactly once** — with the deduplicating machinery shipped but switched off.

**The question this experiment answers:** if the fold could see candidates, would it collapse that
vocabulary enough to matter?

**The question it does NOT answer:** whether the merges it makes are *correct*. That is §6 below.

### 1.1 Why this is informative rather than confirmatory

Doc 39 §6 records that the earlier explanation — "the 48 personal/CRM predicates are domain-locked and
that is why arXiv fragmented" — was wrong. The fold never consulted those predicates at all, so their
domain fit is **untested in either direction**. The outcome here is genuinely unknown.

Two mechanisms compete, and they predict opposite results:

- **Seed-reuse.** If arXiv predicates merge onto the 27 personal-domain canonicals, the fold works by
  matching a pre-seeded ontology, and doc 39's "~100 heads cover 75% of edges" sizing is the fix.
- **Mint-and-grow.** `canonicalizeStagedPredicates` pushes every minted predicate back into the live
  candidate list (`predicate-resolve.ts:151`), so the vocabulary grows *during* the run. The fold could
  collapse the tail by matching arXiv predicates against *each other* while never touching a seed.

These are distinguishable and §5.2 measures the split. This matters: mint-and-grow would mean domain
seeding is not required, which contradicts the plan doc 39 §4 sizes.

## 2. Design

**Offline in-memory replay of the real fold over the real run.** Chosen over a live 20-paper re-ingest
for three reasons: `/resolve-predicate` is deterministic and model-free
(`ml-services/app/resolve_predicate.py:1-17` — lemmatize → tense-normalize → enriched-embed →
mean-center → multi-signal score → two thresholds), so the replay carries no LLM noise; the sample is
16x larger (3,963 real fold keys vs ~250 from 20 fresh papers); and it mutates nothing.

**Input.** All facts in `cognitive_test` with `corpus_id IN ('arxiv-nlp','arxiv-cv')`. Because the fold
was inert, `facts.predicate` **is** the raw proposer output — the exact string
`canonicalizeStagedPredicates` would have received.

**Faithfulness.** The replay reproduces the production fold's contract exactly:

- Resolution key is `(predicate, subjectType, objectType)`, cached, resolved once — mirroring `:135-140`.
- `subjectType` / `objectType` are read from `entities.entity_type` of the fact's endpoints, which is
  what staging carried at promote time.
- Candidates start as the rows `loadPredicateCandidates` would return **after** the backfill, i.e. the
  27 `is_canonical = true` rows (`predicate-embeddings.ts:63-70` embeds only those), enriched-embedded
  by `enrichedPredicateText`.
- `decision === 'merge' && canonical` → reuse. Anything else (`distinct`, `ambiguous`) → mint `res.base`
  and **push it into the live candidate list**, so later keys can match it. This is the mint-and-grow
  behaviour and must not be simplified away.
- A thrown call → `deferred`, predicate kept raw.

**Non-destructive.** The candidate list lives in memory. The replay issues **zero writes** — no
`fact_predicates` inserts, no `facts` updates. `cognitive_test` is a shared DB with live substrate in it
(doc 39 §7.13) and this experiment will not touch it.

**Deviations from production, disclosed.** Production resolves keys in staging order within an epoch of
~10 papers; the replay resolves in one continuous pass. Mint order therefore differs in detail. §4
grades on the frozen order and §5.4 reports shuffle sensitivity.

## 3. Frozen baselines

Quoted from doc 39 §4, already committed at `75161e4` **before** this pre-registration, so no bar here
was set against a number produced for it:

| baseline | value |
|---|---|
| facts | 5,714 |
| distinct predicates | **2,240** |
| predicates used exactly once (hapax) | 1,539 = **68.7%** |
| edges on a once-used predicate | 26.9% |
| top-100 predicate heads cover | 75% of edges |

One input measurement was taken in this session **before** the bar was set, and is disclosed as such:
distinct `(predicate, subject_type, object_type)` fold keys = **3,963**. It characterises the input's key
space and sizes the run; no bar is set against it.

## 4. Pre-registered primary metric and bar

**Metric:** `distinct_after` = the number of distinct predicate strings after the fold, i.e.
`|{ resolved(k) : k in keys }|` mapped back over all 5,714 facts. Deterministic set arithmetic.

**Graded at the endpoint's default thresholds** (`predicate_scoring.MERGE_THRESHOLD` /
`DISTINCT_THRESHOLD`), on the frozen ordering of §5.4.

| outcome | condition | reading |
|---|---|---|
| **PASS** | `distinct_after` ≤ **900** (≥60% reduction) **AND** hapax rate ≤ **45%** | the fold is the fix; the inert setup step was the whole bug |
| **PARTIAL** | 900 < `distinct_after` ≤ **1,600** (30–60% reduction) | the fold helps but does not solve it; seeded ontology still needed |
| **FAIL** | `distinct_after` > **1,600** (<30% reduction) | the fold is not the fix; doc 39 §4's seeded ontology is the real work |

Both PASS conditions must hold. A large count reduction that leaves the hapax rate near 68.7% would mean
the fold collapsed the head and left the tail — which is the opposite of what queryability needs.

**Ties are ties.** Any figure landing within 25 predicates of a boundary is reported as
boundary-straddling, not resolved in the favourable direction.

## 5. Secondary measures — reported, explicitly NOT graded

**5.1** Reuse / mint / defer counts, over keys and over facts.

**5.2** **Seed-reuse vs mint-and-grow** (the §1.1 discriminator): of all `merge` decisions, the share whose
canonical is one of the 27 original personal-domain seeds, versus one minted during the replay. Reported
as a raw split. This is the measure that decides whether doc 39 §4's seeding plan is needed.

**5.3** Top-100 head coverage after the fold, against the 75% baseline.

**5.4** **Order sensitivity.** Primary order is `facts.created_at, facts.id`. The replay is re-run once on a
seeded shuffle (`seed=40`, algorithm recorded in the harness). Both `distinct_after` values are reported.
If they straddle a bar boundary, the result is reported as order-dependent and **not** graded.

**5.5** **Threshold sensitivity.** Re-run at merge threshold ±0.05. All three reported; only the default is
graded.

**5.6** `type_pair_overlap` signal utility: the share of resolutions where it scored > 0. Prediction, logged
here in advance: **near zero**, because doc 39 §4 records 338 free-text entity types. If that holds, one of
the endpoint's multi-signal legs is dead weight on this corpus.

**5.7** Mint description quality: `mintPredicateCandidate` (`predicate-resolve.ts:60`) passes no
`description`, so `enrichedPredicateText` falls back to the de-underscored label. Every minted candidate is
therefore label-only while the 27 seeds carry real descriptions. Reported as an asymmetry, not scored.

## 6. What this experiment CANNOT establish, and the debt it books

**Merge precision is not measured and is not claimed.** Collapsing 2,240 → 300 *wrongly* is a failure that
looks identical to success on the §4 metric. A PASS here means **"reduction achieved, precision
unadjudicated"** and must be reported in exactly those words.

Booked in advance:

- The harness dumps **50 uniformly sampled merge decisions** (seed recorded) with both predicate strings,
  both type pairs, and the score breakdown, to `predicate-fold-artifacts/merge-sample.json`.
- A **blind adversary** reviews before any claim is banked: fresh context, given this frozen
  pre-registration and the raw artifacts, tasked in **both** directions, and explicitly told to audit the
  harness as hard as the result.
- No automation or ontology-quality claim is made until that adversary rules.

## 7. Harness audit gate

Per doc 39 §8, the harness is audited against this frozen document **before** it is run — on doc 35 three
required metrics were missing or wrong, and finding that after the numbers would have been
indistinguishable from tuning. The audit checks, at minimum:

1. Every metric in §4 and §5 is actually computed and emitted.
2. Minted candidates are pushed into the live candidate list (mint-and-grow is not simplified away).
3. Zero writes are issued.
4. The `distinct_after` count is mapped over all 5,714 facts, not over the 3,963 keys.
5. Exceptions are counted as `deferred`, not silently swallowed as `distinct` — a silent no-op here would
   reproduce the exact class of bug this whole arc keeps finding (doc 39 §8, last bullet).

## 8. Follow-on, out of scope here

A ~20-paper live ingest through the real epoch path, after running
`platform/scripts/backfill-predicate-embeddings.ts` against the live `cognitive` DB. Its purpose is a
**plumbing confirmation** — that the wired path stops logging `deferred=ALL` and matches the replay's
prediction. It is not a second capability test and carries no bar.

## 9. AMENDMENT (pre-run, derived from code, no results computed)

Added while reading the scoring module to build the harness, **before any replay was executed**. It is
recorded here rather than in the results doc because discovering it after a FAIL would be
indistinguishable from post-hoc rationalisation.

`predicate_scoring.py:53-60` fixes the decision as:

```
combined = 0.55*cosine + 0.30*type_pair_overlap + 0.10*jaro_winkler + 0.05*conceptnet
MERGE_THRESHOLD    = 0.89
DISTINCT_THRESHOLD = 0.84
```

`type_pair_overlap` (`:98-108`) is a three-valued step: **1.0** if both `(subject_type, object_type)`
match exactly, **0.5** if one matches, **0.0** otherwise — and an unknown side counts as a miss, not a
wildcard. Therefore the reachable maximum of `combined`, with every other signal saturated at 1.0:

| `type_pair_overlap` | max reachable `combined` | can it reach 0.89? |
|---|---|---|
| 0.0 | 0.70 | **no — arithmetically impossible** |
| 0.5 | 0.85 | **no — arithmetically impossible** |
| 1.0 | 1.00 | yes |

**A score-based merge therefore requires an exact match on BOTH entity types.** Against doc 39 §4's 338
free-text entity types this is the binding constraint on the fold, and it is deterministic arithmetic,
not a prediction.

That leaves exactly two live merge routes:

1. **The exact/alias fast path** (`resolve_predicate.py:116-129`): `normalize_tense` maps the raw
   predicate onto a canonical by tense fold or alias table, returning `score=1.0, exact_match=True`
   without embedding at all. Requires string identity with one of the 27 seeds.
2. **Score merge within an identical type pair**, including onto candidates minted earlier in the run.
   Doc 39 §4 records ~25 entity types covering 73.4% of entities, so common type pairs recur and this
   route is genuinely open.

A prior calibration result already points the same way. `predicate_scoring.py:44-52` records that the
PC6 sweep found "score-reuse barely rises (0.18 → 0.19) — the multi-signal SCORE is NOT the primary
over-minting lever; the alias table (deterministic) and the PC5 propose-time reuse hint are." That was
measured on curated adversarial pairs, not on this corpus, so it does not settle the question — but it
predicts a low reuse rate and it was written down long before this experiment.

**No bar in §4 is changed by this amendment.** It sharpens two things: §5.6 stops being a curiosity and
becomes the direct test of whether the binding constraint binds, and §5.1's split must be broken out by
route (fast-path vs score merge) so a PASS or FAIL can be attributed to a mechanism rather than to the
fold as a black box.

## 10. AMENDMENT 2 (pre-run, derived from the frozen input, no results computed)

The 27 canonical seeds are dumped to `predicate-fold-artifacts/input-seeds.ndjson`. Their
`(subject_type, object_type)` pairs are:

```
person/event  person/place  person/company  person/person  person/concept
company/place
```

Twenty-six of the twenty-seven have `subject_type = 'person'`; the twenty-seventh
(`headquartered_in`) has `company`. **No arXiv fact in the frozen input has `person` or `company` as a
subject type** — the input's types are `language_model`, `research_model`, `methodology`,
`neural_architecture`, `task`, `benchmark`, `capability` and so on.

Combining that with §9: `type_pair_overlap` between any arXiv fold key and any seed can be at most
**0.5** (object-side only, e.g. an arXiv `concept` object against `created`/`skilled_in`/`owns`), and
§9's table shows 0.5 caps `combined` at 0.85, below the 0.89 merge threshold.

**Therefore, deterministically and before the run: no arXiv predicate can score-merge onto any of the 27
seeds.** The only route to a seed is the exact/alias fast path — string identity after tense fold or
alias lookup.

This resolves §1.1's competing mechanisms in advance, on arithmetic rather than measurement:
**seed-reuse is structurally closed except by exact string match; any real reduction must come from
mint-and-grow**, where an arXiv predicate merges onto an arXiv predicate minted earlier in the run and
the two share an identical type pair. Doc 39 §4's ~25 types covering 73.4% of entities means common
arXiv type pairs do recur, so that route is genuinely open and its size is unknown.

**This is a falsifiable pre-run prediction, not a hedge.** If the run reports any score merge onto a
seed, this derivation is wrong and must be reported as wrong. §4's bars are unchanged.

---

## 11. POST-RUN NOTE (this document is otherwise frozen)

Results, adversary review and the correction of record are in **doc 41**. Two items bear on this
document specifically:

- **§10 contains a false premise.** "No arXiv fact in the frozen input has `person` or `company` as a
  subject type" is wrong — five facts have `person` (`associated_with`, `maintains_repository`,
  `associated_with_project`, `authored`, `author_of`). §10's conclusion survives on the reason doc 41 §3
  gives (none of their object types matches any seed's, capping `type_pair_overlap` at 0.5), but the
  premise as written is false. This document is not edited; doc 41 §8 is the erratum of record.
- **§5.3 and §5.7 were not delivered as pre-registered.** §5.3's top-100 *head* coverage was silently
  substituted with full-string coverage in doc 41's first draft (corrected: 80.07% → 80.15%), and §5.7
  was dropped entirely. Both are restored in doc 41 §1 and §7.
- **§6's booked 50-merge uniform sample was the wrong population** — it drew 46 fast-path self-merges and
  4 score merges. Adjudication was only possible because all 1,810 merges were dumped instead. Lesson
  recorded in doc 41 §9.
