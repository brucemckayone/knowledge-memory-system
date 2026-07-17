# Doc 18 — Direction: lean symbolic; the fuzzy layer is a tie-breaker, not the bridge

**Status:** DECISION (2026-07-17, user agreed). Synthesises the doc 10–17 experiment arc and
sets the forward direction for the emergent-concept layer. Concludes the FLOOR-experiment
phase of nmemo-uhp.19.

## The cumulative empirical finding (docs 10–17)

Across seven pre-registered experiments — recall-lift gates, description bake-offs, hybrid
retrieval, the raw-code adjudicator, and the concept-resolution test — one result is stable:

> **Wherever a keyword/lexical baseline was measured, it won or came within a hair of the
> "semantic" method.** The semantic lever — whether the embedding OR an LLM adjudicator — has
> never been shown to robustly beat lexical matching on a leak-controlled test.

Specifically, from doc 17 (the cleanest test of the lever):
- **The embedding is weak here.** It ranked same-mechanism prose *below* a keyword baseline
  (R@1 39% vs 72%), robust across all nomic prefixes. It is NOT the meaning-bridge the
  architecture hoped for — in a dense domain it collapses topically-adjacent concepts.
- **The LLM adjudicator has a modest, real edge** over the honest keyword baseline (+0.17
  balanced accuracy; it separates a handful of genuinely-confusable near-misses keyword
  overlap merges) — but it is n-small, it was measured on an easy author-contrasted corpus,
  and its own errors track lexical overlap. Suggestive of sub-lexical discrimination; not
  established.

(Caveat carried forward: every one of these is a constructed FLOOR — LLM-authored, small n,
my mechanism/rule selection. None is field prevalence. And three times the corpus leaked the
distinguishing signal into the surface text. See [[verify-empirical-gates]] for the full
discipline trail.)

## The decision

1. **Lean on the symbolic graph layer, not on fuzzy matching to carry meaning.** Concepts
   (heap-allocation, ownership-transfer, lock-discipline, …) are first-class EMERGENT nodes;
   an element "exhibits" a concept via a typed edge; cross-corpus recall is a symbolic JOIN
   over shared concept nodes, not a cosine gamble. This is the reliable leg.
2. **Demote the embedding to a helper** — candidate discovery / clustering when merging
   emergent concepts — never the load-bearing meaning-match. The lexical signal is strong and
   should be used first-class, not treated only as a baseline to beat.
3. **Scope the LLM adjudicator to a tie-breaker** on the genuinely-confusable cases (the +0.17
   it earned), plus concept EXTRACTION (labelling raw artifacts with the mechanisms they
   exhibit — the still-untested but most natural LLM job) and concept-equivalence resolution
   at merge time — not autonomous violation judgment.
4. **Stop running synthetic FLOOR experiments on the fuzzy layer.** They keep reproducing the
   same "fuzzy ≈ lexical" finding at real Haiku cost. The lesson is banked.

## What is still owed (deferred, not abandoned)

- **The leak-free settling test** for the LLM discrimination edge: near-misses whose
  distinguishing feature is NOT stated in either sibling's surface text, keyword baseline
  baked in from the start, ideally NOT same-model-authored (shared-prior). Deferred until it
  can be built without me leaking the answer a fourth time (candidate: an independent author,
  or harvested field text).
- **The real code→concept→rule pipeline test** — the actual validation the floors only
  approximate. This is what the emergent-concept layer, once built, must be measured on.
- **Field prevalence** — every claim here is a constructed floor; adoption needs a real-code
  field-prevalence run (the standing owed item since the E1 arc, [[project-cross-corpus-audit]]).

## Immediate next step

Harden the entity-resolution machinery the concept layer will ride on: **nmemo-9vk**
(`mergeEntities` re-points facts before deduping → `uniq_facts_active_triple` rejection).
Concept resolution IS entity resolution applied to concept nodes, so this fix is on the
critical path either way.
