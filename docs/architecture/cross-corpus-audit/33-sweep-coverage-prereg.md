# Doc 33 — Sweep coverage at equal adjudicator budget: is the concept leg worth its cells? (pre-registration)

**Bead:** nmemo-uhp.19 (sweep-coverage leg) · **Status:** PRE-REGISTRATION — frozen before any number
**Date:** 2026-07-28 · **Discipline:** [[verify-empirical-gates]] (29th run on this feature family).
Committed to git BEFORE any metric is computed. Nothing in §5–§9 may change after the first number.

---

## 0. Why this run exists

Every prior recall experiment (docs 10–32) scored **recall@k** — *is the true rule in the top five?*
That is a **search** metric: it presumes a ranked list where rank matters and everything past position
k is discarded.

The shipped system does not search. `runAuditPass` (`platform/src/services/audit-pass.ts:303-388`):

1. Seeds a candidate set = `recallConceptCandidates` **UNIONed** with `recallCrossCorpusCandidates`,
   deduped by cell (lines 307–319).
2. Drains **every** pending cell — one LLM invocation each, promote, stamp a coverage verdict.

Nothing is dropped for ranking fourth instead of second. **Rank order is never consulted**; only
*membership* in the candidate set matters, and **each member costs one adjudicator invocation**. The
bounding knobs are `k` (default 8 per element), `threshold` (default 0.5), `maxCells` (default 2000).

So doc-20 measured a ranking quality the system never reads, and nobody has ever measured the two
quantities it does read. doc-20 also scored the concept and cosine legs as **rival rankings in
isolation**, while the shipped code **combines** them. This run measures the shipped configuration.

## 1. The exact question

> In the shipped sweep configuration, does adding the concept leg to the cosine leg surface true
> (element, rule) pairs the cosine leg **misses**, and does it still win **at equal adjudicator
> budget** — i.e. is the concept leg buying coverage that simply widening cosine would not?

The equal-budget clause is the whole gate. A set union can only *add* candidates, so "the union
covers more" is **true by construction and meaningless**. The only honest question is coverage per
cell spent — the question an operator actually faces: *I have budget for N adjudications, how do I
spend them?*

## 2. What this run does NOT test (scope fences, R8/R11)

- **NOT** adjudicator quality. No LLM runs in the primary measurement. Whether the adjudicator
  correctly rejects wasted cells is a **separate question** (§10), not an optional part of this one.
- **NOT** field prevalence. n=29 on a constructed corpus; the field-prevalence run stays owed
  (standing debt since the E1 arc).
- **NOT** a capability claim about the concept layer. Coverage-at-equal-cells is a **cost-efficiency**
  measurement. A pass licenses "keep the concept leg in the sweep union" and nothing more.
- **NOT** a revisit of doc-20's verdict. doc-20's FAIL on ranking stands, adversary-confirmed.

## 3. Corpus, oracle, and graph (all pre-existing; nothing authored for this run)

The **doc-20 graph, surviving intact in `cognitive_test`** — verified before writing this doc:

| object | count |
|---|---|
| `entities` corpus `cj-code` | 29 |
| `entities` corpus `cj-rules` | 27 |
| `entities` corpus `_concepts` | 104 |
| live `bridge_edges` relation `exhibits` | 97 |
| live `bridge_edges` relation `addresses` | 51 |

These match doc-20 §13 exactly (97 + 51), so the graph under test is the one doc-20 measured and the
adversary audited — **not a re-extraction**. Concept extraction is NOT re-run: this run must not
change the substrate it is measuring.

**Oracle:** `recall-gate-artifacts/gate_code_raw.json` `trueGuideline`, from the doc-10
clang-tidy / CppCoreGuidelines external oracle. Verified structure: 29 elements, **exactly one** true
rule each (no multi-label), all 29 true rule ids present in the 27-rule set, spread over **9**
guidelines: `ES.42`:5, `Type.1`:6, `F.16`:2, `ES.45`:6, `C.12`:1, `C.48`:1, `ES.20`:1, `ES.75`:1,
`ES.30`:6. External, concept-independent, fixed months before the concept layer existed → cannot have
been constructed to favour either leg (R6/R31/R44).

**True-pair set:** the 29 cells `(E, trueGuideline(E))`. Full cross-product = 29 × 27 = **783 cells**.

**One data-loading step, disclosed:** `entities.embedding` is NULL for `cj-code`/`cj-rules` (doc-20
wrote its cosine arm to `element_embeddings`, the older .10 substrate). The shipped
`recallCrossCorpusCandidates` reads `entities.embedding`, so it returns zero today. We backfill
`entities.embedding` from `cj-extracted.json` `codeEmbeddings`/`ruleEmbeddings` — **the identical
raw-text 768-dim vectors doc-20's cosine arm used**. This is a load, not a metric choice: it makes the
shipped function run on doc-20's exact vectors, keeping the comparison apples-to-apples. Raw-text (not
authored-description) embeddings are used deliberately, so nothing from the doc-10/13/17 authoring
effect is confounded in; the production-description variant is a separate later question (§10).

## 4. Arms — the shipped functions, called directly (no reimplementation)

All three arms are the shipped code at HEAD, unmodified, against the DB above. No arm is
re-implemented in the harness — that is how proxies crept into docs 28–32 and it is barred here.

- **A. cosine-only** — `recallCrossCorpusCandidates('cj-code','cj-rules',{k,threshold})`.
- **B. concept-only** — `recallConceptCandidates('cj-code','cj-rules')` (no knobs; the JOIN returns
  every pair sharing ≥1 concept node, post-resolution, as the shipped SQL defines it).
- **C. union** — byte-for-byte the seed logic of `runAuditPass` lines 307–319 (concept first, cosine
  overwrites the similarity colour, dedup by `elementRef ruleId`).

## 5. Metrics (frozen; all deterministic set membership — no LLM, nothing to launder)

Lens is **element-level (micro)** throughout, held constant across the primary and every
decomposition (R35). Rationale: coverage is literally "how many of the 29 true pairs did we sweep,"
so the cell/element is the natural unit; and the guideline distribution is so uneven (five singletons
carry 5/9 of a macro average) that macro would be singleton-dominated. Macro-over-9-guidelines is
reported **once**, labelled, for comparability with doc-20 — and used for no decomposition.

- **`coverage`** (primary) = |true pairs present in the arm's candidate set| / 29.
- **`cells`** = |candidate set| (= adjudicator invocations the sweep would cost).
- **`waste`** = 1 − (true pairs in set / cells).
- **`complementarity`** (the load-bearing number) = true pairs in **B but not in A** at shipped
  defaults. This is the set-overlap question doc-20 never asked because it compared rankings.

## 6. The equal-budget control (frozen procedure) — **SUPERSEDED by §13; retained for audit**

1. Run arm C at **shipped defaults** (`k=8`, `threshold=0.5`). Record `cells` = **N** and its coverage.
2. Grid arm A over `k ∈ {1..27}` × `threshold ∈ {0.00, 0.05, …, 0.95}`, recording (cells, coverage)
   for every setting.
3. **Matched setting** = the arm-A setting with `cells ≥ N` and `cells` **minimal** among those
   (cheapest cosine-only configuration that spends at least the union's budget — the comparison is
   deliberately generous to cosine). Tie on `cells` → prefer the **higher** coverage (again generous
   to cosine, so a union win cannot be an artifact of a hobbled baseline).
4. If no arm-A setting reaches N cells even at `k=27, threshold=0` (i.e. cosine cannot spend that
   much), report that fact and compare at cosine's maximum instead, flagging the arm as budget-capped.

Report the full arm-A (cells, coverage) curve so the matched point is auditable and cannot be
cherry-picked.

## 7. Bars — **SUPERSEDED by §13; retained for audit**

The concept leg is **worth its cells in the sweep** iff **both**:

- **(complementarity)** `complementarity ≥ 1` — the concept leg surfaces at least one true pair
  cosine-only misses at shipped defaults. If 0, the leg is strictly dead weight and nothing else
  matters.
- **(equal budget)** `coverage(C @ defaults) − coverage(A @ matched) ≥ +0.103` — i.e. **≥ 3 of 29
  true pairs**. The per-pair quantum is 1/29 = 0.034; a 1–2 pair gap is within singleton noise and is
  **reported as a tie, not a pass** (R39).

**Outcomes:**
- **Both hold** → keep the concept leg in the sweep union; it buys coverage that widening cosine does
  not. Licensed claim is exactly that, on this floor, and nothing about capability.
- **Complementarity ≥ 1 but gap < +0.103** → **TIE**: the leg adds real pairs but widening cosine buys
  the same coverage for the same money. Report as a tie; no adoption claim; the leg stays shipped
  (the union is empty-safe) but is not credited.
- **Complementarity = 0** → **FAIL**: retire the concept leg from the candidate path; its remaining
  value is explanation/provenance, not candidate generation.

## 8. Statistics (R25/R30/R39) — **demoted to secondary by §13; retained for audit**

- **Paired bootstrap over the 29 elements**, 10k resamples, for `coverage(C) − coverage(A @ matched)`.
  Report point estimate **and** 95% CI. **A CI including 0 is a tie, reported as such — including if
  the point estimate flatters the concept leg** (R7/R17/R29 apply in both directions).
- Report the quantum (1/29 = 0.034) beside every coverage delta.
- **Effective-n note:** the concept graph came from one Haiku extraction pass (doc-20), so any
  convergence is a shared-prior effect (R33), not independent agreement. State this in the verdict.

## 9. Pre-committed honest priors (so neither outcome gets rationalised after the fact)

- **Plausible FAIL:** doc-20 found only **8 of 29** elements ever get their true rule connected by a
  shared concept node, while cosine reached 0.467 macro@5. If those 8 are a **subset** of cosine's
  hits, `complementarity = 0` and the leg is dead weight. This is a real and arguably likely outcome
  and will be reported as a fail, not explained away.
- **Plausible PASS:** doc-20 §13 recorded `ES.42` where the JOIN hit 0.80 against cosine's 0.20 —
  genuine complementarity exists on at least one guideline. If a few such pairs are cosine-invisible
  at any budget, the union buys them cheaply.
- **Plausible hollow PASS:** the union's extra pairs are ones cosine also gets once widened → caught
  by the §7 equal-budget bar, which is precisely why it exists.
- **Apparent contradiction, pre-empted:** doc-31 found adding the concept leg via **RRF hurt**. RRF is
  *rank fusion* — it reorders and can push true items down. A **set union in a sweep** cannot: coverage
  is monotone in the candidate set. The doc-31 negative does not transfer, and must not be cited
  either as support or as refutation here.

## 10. Explicitly out of scope (separate questions, not optional parts of this one)

- **Adjudicator specificity on wasted cells** — of the cells with no true relation, what fraction does
  the agent correctly stamp `not_applicable`? This is where the specificity replicated across E1
  Leg-2/3/5 and the stage-2 smoke would be measured for the first time at realistic waste ratios
  against an external oracle. It costs one LLM call per cell and answers a **different** question
  (does the adjudicator clean up after the prefilter), so it is scoped out rather than declared
  optional (R32).
- **Production-description embeddings** (`EMBED_DESCRIPTIONS` on) instead of raw text.
- **Convergence-forcing extraction** (the relevance-window shared-vocab extractor from docs 25–27
  ported into `concept-extraction.ts`, whose blind-extract + trigram-0.4 merge is the weak conform
  mechanism doc-20 §13 blamed). Owed since doc-20 §13(d) and doc-18; needs its own pre-registration.

## 11. Stated limits (in the pre-registration, not added afterward)

- **n=29 / 9 guidelines.** Underpowered; a 1–2 pair swing is noise, which is why the bar is 3 pairs.
- **The budget question is partly artificial at this scale.** The full cross-product is only 783 cells
  — cheap enough to just sweep everything. Budget only bites at real scale. What generalises is the
  **ratio** (true pairs per cell spent), not the absolute counts. doc-20's corpus is used anyway
  because it is the only corpus we have with a clean, concept-independent external oracle.
- **Single corpus, single extraction pass, constructed floor.** No transfer claim.
- **Coverage ≠ capability.** The primary metric is cost-efficiency of candidate generation.

## 12. Adversary protocol (R2)

A blind adversary is **owed before any claim is banked**, given this pre-registration, the committed
artifacts, and the raw numbers, tasked to break it in both directions and specifically to check:
(1) is arm A genuinely the shipped function on the same vectors, or was it hobbled (§6 step 3
generosity actually applied)? (2) is the matched-budget point the frozen rule's choice, or
cherry-picked off the curve? (3) is `complementarity` real set-difference against the sealed key?
(4) does the bootstrap CI exclude 0? (5) is the union arm byte-equivalent to `runAuditPass`'s seed
logic? (6) plumbing: 29/27/104 + 97/51 unchanged by the run (n-in == n-out, R40)?

Note on sequencing: the doc-32 adversary was consciously **skipped** by user decision this session,
so doc-32's verdict remains provisional. That does not license skipping this one — but it is recorded
here that the debt exists and is being carried, not silently cleared.

---

## 13. AMENDMENT (2026-07-28, BEFORE any number was computed) — supersedes §6–§7, demotes §8

**Provenance of this amendment, stated plainly:** committed in a separate commit *after* §1–§12 and
*before* any arm was executed. **No arm's cell count, coverage, or complementarity had been computed
or inspected when this was written** — deliberately, because peeking and then amending is exactly the
launder pattern this project has hit five times (R7/R17/R26). Amending a bar before data exists is
legitimate; amending it after is not, and after this commit the bar is closed.

### 13.1 Why the original bar was wrong

The §6 matched-budget point can be **decided by an artifact rather than by the question**.
`recallConceptCandidates` returns every pair sharing ≥1 concept, so if any concepts are hubs the JOIN
may return a large slice of the 783 cells. That sets N large; arm A matched to a large N runs at
k≈27 / threshold≈0, i.e. essentially the **full cross-product, which covers 29/29 trivially** → the
union loses by construction. At only 783 total cells, "sweep everything" is always affordable and
always wins on coverage, so a single matched-budget comparison **degenerates on this corpus**. §11
recorded that as a generalisation caveat; it is in fact capable of deciding the primary bar, which
makes it a design flaw, not a caveat.

Second flaw: a 3-of-29 gap bootstrapped over binary per-element outcomes will almost certainly produce
a CI touching 0, so §7+§8 as written would report "tie" nearly regardless of outcome. A gate that
cannot clear its own bar is not a gate.

### 13.2 The replacement: a cost/coverage frontier (deterministic)

Both legs are put on a **cost/coverage plane** and compared as curves, not at one point. This is
immune to the sweep-everything degeneracy and — decisively for this project — it is **deterministic
set arithmetic, not inference**. The claims that have survived adversaries here (doc-31's coverage
ceiling) were deterministic; the ones that got cut were interpretive.

Frozen definitions:

- **Arm A curve:** for every `(k, threshold)` in `k ∈ {1..27} × threshold ∈ {0.00, 0.05, …, 0.95}`,
  the point `(cells, coverage)`.
- **`A_frontier_at(c)`** = max coverage over all arm-A settings with `cells ≤ c`. (The upper-left
  staircase: the best cosine-only can do for a budget of `c` cells or fewer.)
- **Dominance:** an arm with point `(cells_X, coverage_X)` **sits above cosine's frontier** iff
  `coverage_X > A_frontier_at(cells_X)` — it covers more true pairs than *any* cosine-only setting
  costing the same or less.
- Computed and reported for **both** arm B (concept-only) and arm C (the shipped union at defaults).
- The full arm-A grid is published so the frontier is independently re-derivable and no point can be
  cherry-picked.

### 13.3 Primary bars (frozen, both deterministic)

The concept leg **earns its cells in the sweep** iff **both**:

1. **Complementarity** — `complementarity ≥ 1`: the concept leg surfaces at least one true pair that
   cosine-only at shipped defaults misses. **The specific element ids are reported**, not just the
   count. If 0, the leg is strictly dead weight and nothing else matters.
2. **Frontier dominance** — `coverage(C) > A_frontier_at(cells_C)`: the shipped union covers more true
   pairs than any cosine-only configuration costing the same or fewer cells.

**Grading of the magnitude** (deterministic, so a strict win is a *fact* even at one pair; the grade
governs how far it may be generalised, not whether it happened):

- **≥3 pairs above the frontier** → clear win on this floor.
- **1–2 pairs above** → real but singleton-fragile dominance. Reported as *"dominates by N pairs,
  fragile to corpus idiosyncrasy, no transfer claim."* Not upgraded to a clear win.
- **0 or below** → fail.

### 13.4 Secondary (reported, NOT gating)

The entire §6 matched-budget procedure and the §8 paired bootstrap still run and are reported —
demoted to illustration. Their CI will likely include 0; that is expected and is **not** evidence
against a deterministic frontier result, nor may a favourable bootstrap be cited as support for one.

### 13.5 Narrowed disposition (closes an over-read I left open)

This measures the concept leg **with the conform mechanism doc-20 §13 already blamed** — blind
per-element extraction (`buildConceptExtractionPrompt` shows the extractor no existing vocabulary)
followed by `resolveConcepts` merging on `pg_trgm similarity > 0.4` over names plus a Haiku judge.
That is why `reinterpret-cast` never met `unsafe-cast`.

Therefore a FAIL here licenses **only**: *"the concept leg **as currently conformed** does not earn its
cells as a candidate generator on this corpus."* It does **not** license "concept-JOIN is a poor
candidate generator" or "the concept layer is dead" — the conform mechanism is a known-broken
confound, and the convergence-forcing variant (relevance-window shared-vocabulary extraction, docs
25–27, owed since doc-20 §13(d)) remains a live, unrun question either way.

A PASS licenses keeping the leg in the sweep union on this floor, and nothing about capability.

### 13.6 Unchanged by this amendment

§1 (question), §2 (scope fences), §3 (corpus/oracle/graph + the disclosed embedding backfill),
§4 (arms = shipped functions, no reimplementation), §5 (metric definitions and the element-level
lens), §9 (honest priors, including the doc-31/RRF non-transfer), §10 (out of scope), §11 (limits),
§12 (adversary protocol).
