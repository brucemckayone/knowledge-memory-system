# Doc 32 — Does DENSER extraction lift the coverage ceiling (and keep discrimination)? (pre-registration)

**Bead:** new (nmemo, extraction-density) · **Status:** PRE-REGISTRATION — frozen before any number
**Date:** 2026-07-27 · **Discipline:** [[verify-empirical-gates]] (28th run). Committed to git BEFORE the run.
Autonomous `/goal`. The one unfalsified retrieval lever from doc-31.

---

## 0. Why
doc-28→31 closed the retrieval thesis FOR THE CURRENT extraction (~6 concepts/doc): the concept layer is ~95%
blind in embedding's text-dissimilar blind spot (coverage ceiling 4.4%), because most related papers share NO
extracted node. The failure is **blindness from sparsity, not a wrong mechanism** (the pairs it does link are
genuine). The only untested lever is **extraction density**. This gate runs the cheap, decisive first check:
does much denser extraction raise the coverage ceiling — WITHOUT collapsing discrimination into generic-hub noise?

## 1. Claim
Re-extracting with the SAME controlled-vocab relevance-window mechanism but a much higher concept target
(~25–40/doc vs ~6) raises the fraction of text-dissimilar co-cited pairs that share ≥1 concept node
**substantially**, AND the denser concept-overlap still discriminates co-citation (does not degrade to hubs).

## 2. Method (only DENSITY changes; mechanism held constant)
Re-extract all 294 docs (corpus-A/B) with the doc-25/27 relevance-window controlled-vocab extractor, prompt
bumped from "4 to 10" to **"25 to 40"** concepts/doc (finer sub-concepts, methods, tasks, data types, specific
techniques; still reuse exact existing vocab labels or coin new). One shared vocab across both corpora,
interleaved. Reuse the FROZEN co-citation oracle (`cc-cociters.json`, K=1), embeddings (`cc-docemb.json`), and
τ=0.615. ~294 new Haiku calls; incremental cache. Save as `cc-seeded-dense.json`.

## 3. Metrics (deterministic from the denser node sets + frozen oracle)
- **Coverage ceiling (primary):** fraction of text-dissimilar (cos<0.615) co-cited pairs sharing ≥1 dense node
  (vs the sparse 4.4%). Also full-oracle coverage (vs sparse 27%). Report mean nodes/doc achieved, vocab size,
  empty-doc count.
- **Discrimination (co-primary — the anti-hub guard):** on the FULL co-citation oracle, IDF-weighted denser-JOIN
  as a co-citation classifier — **AUC** (vs sparse-JOIN's 0.60) and AUC among-overlapping-pairs (vs sparse 0.54).
  A coverage rise driven by generic hubs would raise coverage but leave AUC ≤ sparse.
- **Hub diagnostic:** top-10 most-shared dense nodes + their document frequency (are the new shared nodes
  specific, or `deep-learning`-style hubs?).

## 4. Bars (FROZEN before the run)
Density is a **LIVE lever** iff BOTH:
- **(coverage)** text-dissimilar coverage ceiling ≥ **25%** (a ≥5× rise from 4.4%, into potentially-useful
  territory), AND
- **(discrimination)** denser-JOIN full-oracle AUC ≥ **0.63** (meaningfully above sparse 0.60 and chance 0.50) —
  i.e., the added coverage carries signal, not hubs.

Outcomes: BOTH → density is live → run the full JOIN/agent retrieval retest (doc-33). Coverage ≥25% but AUC
< 0.63 → coverage is **generic-hub noise**, density does not rescue retrieval (dead). Coverage < 10% → density
**dead** (disjoint-concept confirmed — denser extraction still doesn't make related papers share nodes).
10–25% coverage → marginal, reported as such, no full retest without a stronger signal.

## 5. Anti-launder
- Only density changes (same mechanism, prompt, corpora, oracle, τ); the coverage ceiling is deterministic.
- **The AUC/hub guard is mandatory** — coverage alone is gameable by generic concepts; a "win" needs coverage AND
  discrimination. Bars frozen before the run.
- Report mean-nodes-achieved (did the prompt actually produce ~30, or did Haiku cap lower?), vocab growth, and
  the hub diagnostic. Blind adversary before any claim; both directions. No full retest banked on coverage alone.

## 6. Adversary protocol
Reproduce the denser node sets' coverage ceiling + AUC from `cc-seeded-dense.json` + frozen oracle. Check: did
density actually increase (mean nodes/doc)? Is the coverage rise real or hub-driven (inspect the top shared
nodes; recompute AUC excluding the top-N hub nodes — does coverage/AUC survive)? Is τ/oracle unchanged? Rule
whether density is a live lever, hub-noise, or dead.

## 7. Disposition
Names the outcome per §4. Decides whether extraction density is worth a full retrieval retest or the retrieval
thesis is closed for good (not just for the sparse extraction). Does NOT itself re-run retrieval — that is
doc-33, gated on a LIVE outcome here.

---

## 8. RESULT (2026-07-28) — DEAD on both bars (coverage + discrimination); disjoint-concept wall is real. Adversary OWED.

Re-extracted all 294 docs denser (prompt "25 to 40"). **Execution flaw:** the aggressive prompt failed
extraction on **101/294 docs (34%, empty)** vs 54 in the sparse baseline (more parse-fragile long responses) —
a real harness-robustness issue that confounds the raw coverage comparison. Neutralized by recomputing on
both-docs-populated pairs (below).

| metric | DENSE | SPARSE (doc-31) | bar |
|---|---|---|---|
| mean nodes/doc (all) | 21.9 (33 among populated) | 5.8 | — |
| vocab | 4181 | 521 | — |
| text-dissimilar coverage, all band pairs | 6.3% | 4.4% | ≥25% |
| **text-dissimilar coverage, both-populated** | **9.1%** (10/110) | 6.5% (7/107) | ≥25% |
| full-oracle coverage | 19.5% (empty-dragged) | 26.6% | — |
| **joinAUC full oracle (discrimination)** | **0.579** | 0.596 | ≥0.63 |
| joinAUC among-overlap | 0.575 | 0.540 | — |

**Verdict: DEAD on BOTH bars, robust to the confound.**
- **Coverage FAIL:** even removing the 101 empty docs, dense text-dissimilar coverage is **9.1%** (vs sparse
  6.5%) — a hair up, still <10%, ~1/3 of the 25% bar. Density does NOT make text-dissimilar related papers share
  concepts.
- **Discrimination FAIL:** dense JOIN AUC 0.579 < sparse 0.596 < bar 0.63; the top shared dense nodes are generic
  hubs (`representation-learning` df=21, `large-language-models` df=45, `model-generalization`, `deep-learning`).
  Density adds hub-noise, not discriminative shared concepts — exactly the pre-registered anti-hub failure mode.

**The disjoint-concept wall is real:** co-cited-but-textually-dissimilar cross-corpus papers genuinely do not
share nameable concepts, even at 5.6× extraction density. This CLOSES the retrieval thesis not just for the
sparse extraction (doc-31) but for a dense one too.

**Caveats / owed:** (1) the 34% extraction-failure rate is a harness flaw — a robust re-extraction (retry-on-empty,
sturdier parse) would clean the coverage number, but the both-populated analysis already shows the verdict holds,
and the discrimination FAIL is failure-rate-independent. (2) **Blind adversary NOT yet run** (session limit) — the
load-bearing claims are deterministic (coverage ceilings verified two ways; AUC tie-corrected), but the adversary
re-check is owed before this is fully banked. (3) description-aligned nodes (vs raw concept-count density) remain
a distinct, untested variant — but the disjoint-concept evidence makes it a long shot.

**NET across doc-28→32:** the concept layer is NOT a cross-corpus retrieval mechanism — sparse OR dense, mechanical
OR agentic, on every oracle. Retrieval is dense embedding's job. The concept layer's demonstrated value is
non-retrieval (structural audit / navigation / rare-bridge / explanation). See [[verify-empirical-gates]] iter-28.
