# Doc 17 — Concept resolution (embedding + adjudicator): pre-registration

**Status:** PRE-REGISTERED (frozen before any number). Bead nmemo-uhp.19. This tests the
LINCHPIN of the emergent-concept architecture the user and I converged on (docs 15–16 +
[[project-cross-corpus-linker]]): concepts are first-class emergent graph nodes; recall
across corpora is a symbolic traversal once concepts are RESOLVED; and **the embedding path's
real job is that resolution — matching the same meaning expressed in different prose, where
keyword matching fails by construction.** Every prior embedding test (docs 10–14) measured
embeddings where the two sides SHARED vocabulary, so keyword baselines tied them. This is the
first test placed where embeddings are *supposed* to win. Shared discipline: [[verify-empirical-gates]].

## 1. Question

Two stages, mirroring the architecture split:

- **Stage 1 (embedding bridges the gap):** given a pool of concept descriptions where the
  same underlying mechanism is expressed in DIFFERENT prose with LOW shared vocabulary, does
  the production embedding path (Ollama `nomic-embed-text`, 768-dim) recall the same-mechanism
  descriptions — and does it BEAT a keyword/BM25 baseline that should be near-floor because
  there is no shared vocabulary?
- **Stage 2 (adjudicator resolves equivalence):** given two concept descriptions, can a Haiku
  adjudicator decide "same concept?" — CONFIRMING true matches AND REJECTING hard near-misses
  (heap-alloc vs stack-alloc; double-free vs use-after-free) — and does it BEAT a plain
  cosine-similarity threshold classifier?

Each stage must beat the cheaper mechanism beneath it, or that layer earns nothing.

## 2. Corpus (construction frozen)

- **~12 canonical mechanisms** in the memory/lifetime/concurrency domain (e.g.
  dynamic-heap-allocation, stack-automatic-storage, double-free, use-after-free,
  dangling-pointer, ownership-transfer, raw-pointer-arithmetic, deallocation-form-mismatch,
  lock-not-released, weak-ptr-unchecked-lock, RAII-scope-binding, exception-leak-between-acquire-release).
- **3 prose registers per mechanism**, each authored by a SEPARATE BLIND subagent:
  - `normative` — formal standards/rule language ("shall not …");
  - `advisory` — guideline/best-practice language ("prefer …, avoid …");
  - `reference` — descriptive manual/textbook language ("X obtains storage whose …").
  Each authoring subagent is given ONLY its register instruction + the bare mechanism name,
  is NOT shown the other registers, and is NOT told this is a matching/embedding test. No
  hand-alignment by me. => ~36 concept descriptions.
- **Near-miss negative pairs:** each mechanism paired with its closest sibling
  (heap↔stack, double-free↔use-after-free, dangling↔null-deref, lock-not-released↔lock-held-too-long,
  raw-ptr-arithmetic↔array-indexing, …) across registers. Target ~12–15 near-miss pairs.
- **Far negative pairs:** unrelated mechanisms (easy controls, both classifiers should reject).

## 3. Method (frozen)

- **Stage 1:** embed all 36 descriptions. For each description as a query, rank all others by
  cosine; the true matches are the same-mechanism descriptions (2 per query). Compute
  recall@1 / recall@3 (MACRO over queries). Same ranking with **BM25** (k1=1.2, b=0.75, no
  tuning — the canonical baseline from doc-12) over token sets. Report both.
- **Stage 2:** build the pair set = {true-match pairs (same mechanism, cross-register)} ∪
  {near-miss pairs} ∪ {far pairs}. For each pair, the Haiku adjudicator sees ONLY the two
  descriptions (no mechanism labels, no hint) and returns same / different + reasoning.
  Baseline = cosine-threshold: sweep the threshold and report the BEST balanced-accuracy it
  can achieve (steelmanned — best-in-hindsight cut). The adjudicator must beat even that.

## 4. The gap partition (objective, pre-committed) + VOID condition

The claim is "the vector bridges what keywords cannot." So partition the true-match pairs by
an OBJECTIVE, pre-committed rule — no post-hoc subset-picking:

- **GAP pairs** := true-match pairs where **BM25 fails to rank the true match at #1** (BM25
  miss). These have no usable shared vocabulary — this is where the vector must earn its keep.
- **SHARED-VOCAB pairs** := the rest (BM25 already matches; the vector is expected to add
  nothing, and that's fine).

Also report raw mean Jaccard/BM25 overlap on true pairs for transparency.

**VOID condition:** if there are **fewer than 6 GAP pairs**, the corpus failed to isolate a
vocabulary gap (the blind authors converged on shared vocabulary) → the Stage-1 embedding
claim is **VOID** (not pass, not fail — the docs 15–16 leak in a new guise: no gap to bridge).
Report it and rebuild; do not rescue by relabelling.

## 5. What "pass" means (frozen — bars set BEFORE any number)

- **Stage 1 PASS iff BOTH:** (1) embedding **recall@1 on the GAP subset ≥ 0.70** — the vector
  matches pairs keywords miss; (2) embedding recall@1 (full set) − BM25 recall@1 (full set)
  **≥ +0.30** — the lift is real in aggregate too. (The gap-subset number is primary; the
  aggregate margin guards against a vector that only works where BM25 already did.) Report
  @3 and the SHARED-VOCAB subset alongside.
- **Stage 2 PASS iff BOTH:** (1) adjudicator balanced-accuracy − best cosine-threshold
  balanced-accuracy **≥ +0.10**; (2) adjudicator **near-miss specificity ≥ 0.70** (rejecting
  close-but-different is the load-bearing capability; far-negative specificity reported
  separately and expected easy for both).
- **Report:** all confusion matrices, both baselines, GAP vs SHARED-VOCAB and near-miss vs far
  decompositions, per-mechanism breakdown. No tuning to pass. n is small — report it as a
  floor, with CIs.

## 6. Adversary (pre-committed, before any claim)

Blind hostile, BOTH directions: (1) is the gap fake / did the blind authors nonetheless
converge on shared vocabulary I should have caught (re-measure overlap independently); (2)
are the "near-misses" genuinely near, or easy far-negatives dressed up (a trivial near-miss
set inflates Stage-2 specificity); (3) is the embedding margin real or within the n-small CI;
(4) is "adjudicator beats cosine-threshold" real, or an artifact of a few pairs / a threshold
I under-tuned; (5) **LLM-author/LLM-adjudicate shared-prior inflation** — the same model family
wrote the prose and judges equivalence; does that make matching artificially easy (probe with
the near-miss rejections, which shared priors do NOT trivially explain); (6) construction-
validity / floor creep.

## 7. Pre-committed caveats

- **FLOOR:** LLM-authored prose (not harvested field text), my mechanism selection, small n,
  single embedding model, ~50/50 by construction. Magnitudes do not transfer.
- **A pass licenses ONLY:** "on this floor, the embedding path resolves same-meaning/
  different-prose concepts that a keyword baseline cannot, and a Haiku adjudicator resolves
  concept-equivalence — including rejecting hard near-misses — beating a cosine threshold."
  NOT field concept-resolution, NOT the full code→concept→rule pipeline (raw code is not in
  this test), NOT autonomous audit.
- **A FAIL / VOID is a legitimate and informative outcome.** Report it and its cause.

---

# RESULTS (post-run — appended after §1–7 are frozen + committed)

**Run:** 12 mechanisms × 3 blind-authored registers = 36 descriptions (frozen
`concept-authored.json`); 66 adjudication pairs (36 true / 18 near-miss / 12 far).
Harness `concept-resolution.ts`; robustness `concept-embed-sensitivity.ts` +
`concept-stage2-lexbaseline.ts`. Blind adversary `ab247…` run before this section.
**Outcome: Stage 1 FAIL (robust); Stage 2 passed the pre-reg bar but the bar's baseline
was a strawman — against the HONEST keyword baseline the adjudicator shows a MODEST real
edge, not the strong capability I first read. Net: neither over-reading is licensed.**

## Numbers

**Stage 1 — embedding vs BM25 recall (concept resolution across prose):**
| prefix | embedding R@1 | R@3 | BM25 R@1 | gap n | emb R@1 on gap |
|---|---|---|---|---|---|
| raw (pre-registered) | 39% | 69% | 72% | 10–11 | 27–30% |
| search_document: | 44% | 72% | 72% | 10 | 30% |
| clustering: | 33% | 75% | 72% | 10 | 20% |

Bars: gap R@1 ≥ 70% → **fail** (27%); full-set margin ≥ +0.30 → **fail** (embedding is
*below* BM25). Not void (≥ 6 gap pairs). **STAGE 1 = FAIL, robust to nomic prefix** — the
repo's own note (`ml-client.ts`) warns raw-embed degrades recall (a side-test 0.38→0.75
under prefix), so the prefix sensitivity run was the pre-committed anti-launder check; it
moved R@1 only 39%→44% (search_document) and *down* to 33% (clustering), nowhere near 72%.
So the FAIL is NOT a raw-embed artifact.

**Stage 2 — adjudicator vs baselines:**
| classifier | BA | recall | near-miss spec |
|---|---|---|---|
| adjudicator (Haiku) | 0.956 | 94% (34/36) | 94% (17/18) |
| Jaccard keyword, best-in-hindsight threshold (HONEST baseline, post-hoc) | 0.783 | 83% | 72% |
| cosine threshold, best-in-hindsight (pre-registered baseline) | 0.736 | — | 33% |

Pre-registered bars (vs cosine): adjudicator BA − cosine BA = +0.219 ≥ +0.10 → pass;
near-miss spec 94% ≥ 0.70 → pass. **STAGE 2 = PASS against the pre-reg bar.**

## Blind adversary (`ab247…`) — verdict + my independent follow-up

The adversary attacked both claims in both directions; I verified its load-bearing points
and ran the two settling checks it demanded.

1. **Stage 1 FAIL — SOUND but do not over-generalize.** The adversary flagged the nomic
   prefix confound hard (cited the repo's 0.38→0.75 note) and said "quarantine until the
   prefix run returns." It returned: FAIL is robust (above). Licensed: "on this floor the
   embedding (any nomic prefix) ranks same-mechanism prose below keyword matching." NOT
   "embeddings are intrinsically the weak leg" (n small, LLM-authored, one domain). On the
   gap subset BM25 is 0% by construction and embedding recovers only 27% — weak, not "keyword
   dominates the gap."

2. **Stage 2 — the adversary CORRECTLY cut my strong reading; my follow-up baseline then
   corrected the adversary's over-pessimism.** Three cuts, all verified:
   - **Authoring leak in the near-miss siblings.** The blind authors baked the distinction
     into the surface text (heap "must explicitly return" vs stack "automatically cleaned
     up"). 13/18 near-miss pairs have Jaccard < 0.06 → mostly keyword-separable. Same
     docs-15/16 leak, third channel.
   - **The adjudicator's 2 errors are purely lexical:** it split a TRUE pair at Jaccard
     0.043/0.059 (deallocation-form-mismatch adv↔ref; null-deref adv↔ref) and merged the one
     FALSE pair at Jaccard 0.200 (form-mismatch↔wrong-allocator-family) — the single
     genuinely-overlapping near-miss defeated it. Lexically fragile at the margin.
   - **The pre-reg baseline was a STRAWMAN** — cosine on the prefix-crippled embeddings
     (Stage-1's loser); the Stage-1 WINNER (keyword) was never entered. The adversary
     predicted a keyword baseline would tie the adjudicator.
   - **I built the missing keyword baseline** (`concept-stage2-lexbaseline.ts`, Jaccard,
     best-in-hindsight threshold — generous to the baseline). Result: adjudicator BA 0.956
     vs Jaccard 0.783 = **+0.172**, dominating on BOTH recall (94% vs 83%) and specificity
     (97% vs 73%), correctly rejecting ~4 confusable near-misses (Jaccard 0.08–0.12) the
     keyword method merges. So the adjudicator does NOT merely tie lexical matching — there
     is a small, real sub-lexical signal. The adversary's "not demonstrably beyond lexical"
     was slightly too pessimistic (it couldn't run the baseline).

## What this run licenses (tight, resisting launder in BOTH directions)

> On this 36-description LLM-authored floor, the embedding path (any nomic prefix) ranked
> same-mechanism prose BELOW a keyword baseline (Stage-1 FAIL, robust). A Haiku adjudicator
> beat the honest best-in-hindsight keyword baseline by +0.17 balanced accuracy — dominating
> both recall and specificity and separating a handful of confusable near-misses keyword
> overlap merges — a MODEST, real sub-lexical discrimination signal. But the near-miss set is
> mostly author-contrasted (easy), the adjudicator's only errors are lexical, and n is small
> — so the run SUGGESTS the LLM discriminates slightly beyond surface tokens; it does NOT
> establish concept-resolution capability, and it does NOT show embeddings resolve meaning.

BARRED: ✗ "the LLM resolves concept equivalence / reasons about meaning" (over-read — modest,
easy corpus, lexical failures); ✗ "the adjudicator is no better than lexical matching"
(under-read — it beats the honest keyword baseline by +0.17); ✗ "embeddings are the weak
leg" (over-generalized from one floor); ✗ any transfer past this floor.

## Disposition

- **10th launder-catch on this family** (both directions in one run — I over-read Stage 2 as
  strong capability AND was on track to over-read Stage 1 as "embeddings weak"; the adversary
  cut the first and quarantined the second, my two follow-up runs settled both).
- **Third corpus-construction leak** (authored descriptions → code comments → near-miss prose).
  The recurring root cause is mine: I keep letting the distinguishing signal into the surface
  text. **Owed settling experiment:** a near-miss corpus where the distinguishing feature is
  NOT stated in either sibling's text (force the judge to infer the mechanism from behaviour,
  not read a planted contrast), with the keyword baseline baked in from the start (rule 42),
  and ideally not same-model-authored (shared-prior). Until then: SUGGESTIVE, not established.
- **Architecture read:** the LLM-discrimination lever has a small real signal beyond
  keyword/geometry (justifies the next test); the embedding leg is weak here; the strong test
  is owed. Phase A plumbing unblocked; no capability claim; `nmemo-uhp.6` stays open.
