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

_(pending)_
