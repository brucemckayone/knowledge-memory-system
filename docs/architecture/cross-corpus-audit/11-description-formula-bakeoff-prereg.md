# Doc 11 — Description-formula bake-off: pre-registration

**Status:** PRE-REGISTERED (frozen before any new description was authored or scored).
Bead nmemo-uhp.15. Follow-up to doc 10 (the recall-lift gate), which held description
*style* fixed and only toggled name vs name+description. This asks the sharper question:
**which description formula matches best** — and whether a better formula rescues the
guidelines the plain formula never surfaced.

Same distrust-the-author discipline as doc 10: blind authoring, one consistent (macro)
lens, and a hostile adversary on the winner before any claim.

## 1. Question

Holding the corpus, oracle labels, embed model, and recall function fixed (doc 10's rig),
which **authored-description formula** maximises cross-corpus recall@5 of the true
code→rule match? Secondary: does any formula rescue the **4/9 guidelines**
(`F.16, C.48, ES.20, ES.75`) that were never recalled@5 under the plain formula?

## 2. Factors

**Code-side formula (4)** — each authored BLIND to the rules (sees only the C++ code +
the general domain "safety-critical C++"), never the target rule set:
- `plain` — the doc-10 baseline: 1-2 sentence prose of what the function does (reused).
- `facets` — a fixed template covering the dimensions standards care about: primary
  operation; data/types touched; memory & pointer behaviour; ownership/lifetime; side
  effects; error handling. No rule names.
- `concepts` — a dense list of salient technical concepts (e.g. reinterpret_cast, pointer
  aliasing, raw new/delete, RAII, narrowing). No rule names.
- `rawcode` — the code text itself, no prose (floor: does prose beat raw code?).

**Rule-side formula (2)** — each authored BLIND to the code corpus (sees only the rule
set), never tuned to the code being matched:
- `oneliner` — the doc-10 one-line paraphrase (reused).
- `richer` — expanded rationale + the typical code shapes that trigger the rule, from
  general knowledge of the guideline. Model-authored (NOT canonical guideline prose) —
  a fair test of "does more rule text help," disclosed as such.

Full grid = 4 × 2 = 8 combinations. Composition per entity is held fixed at the
production form `name\n<formula-text>` (embed-text.ts), so only the formula text varies.

## 3. Blindness controls (the load-bearing discipline)

The denser formulas (`facets`, `concepts`) are the MOST likely to smuggle in leakage —
if they extract concepts by peeking at the rules, a match is circular. Controls:
1. Code formulas authored by a subagent shown ONLY the code + the generic domain, never
   the rule set or labels. Extracting "memory/pointer/cast/lifetime" concepts from code is
   fair (standards ARE about those code concepts); naming or paraphrasing a specific rule
   is not.
2. Rule `richer` text authored by a subagent shown ONLY the rule set, never the code
   corpus or labels — so it cannot be tuned to the code being matched.
3. The adversary (§6) runs the doc-10 leakage battery on the WINNING code formula:
   per-item Jaccard(description, true rule) vs (other rules); scan for rule ids/jargon.

## 4. Method

Reuse doc-10's rig verbatim (`platform/src/test/tools/recall-gate.ts` machinery):
production `entityEmbedTextFor` + `ml.embed` (nomic-embed-text) + `recallCrossCorpusCandidates`,
deterministic conservative rank (ties against the true rule). For each of the 8 combos:
embed both corpora, score recall@k for k∈{1,3,5,8}, both MICRO (per-item, n=29) and MACRO
(per-guideline mean, 9 guidelines). Artifacts + harness committed for reproducibility.

## 5. What "wins" means (frozen)

- **Primary metric: MACRO recall@5** (the honest lens — micro is near-duplicate-inflated;
  doc 10 rule 35). The winning combo = highest macro recall@5.
- **Report ALL 8 combos** — no cherry-picking; the full grid is the result.
- **Floored-rescue: report, per combo, how many of the 4 never-matched guidelines now hit
  @5**, and whether it's a genuine per-item hit or a singleton fluke.
- This is EXPLORATORY (find the best formula), not pass/fail. No formula is "shipped" on
  this alone — see §7.

## 6. Adversary (pre-committed, before any claim)

Blind hostile subagent, given the winning combo's descriptions + scores + harness:
1. Leakage battery on the winning code formula (per §3.3).
2. Is the "win" real, or a construction artifact (opaque IDs, near-dup clusters, singleton
   guidelines swinging the macro mean)?
3. Is the ranking of formulas stable, or within noise of each other (report the spread)?

## 7. Pre-committed caveats / what a winner does + does NOT license

- Still a **constructed-corpus floor**: opaque dotted-ID rule names, checker-decidable
  slice, n=29 / ~9 situations / 4 singleton guidelines. Doc 10 §7 caveats carry.
- **Licenses:** picking the best-of-tested formula as the authoring convention for
  cross-corpus ingestion, and the claim "formula X beats plain by Δ on this corpus."
- **Does NOT license:** a field magnitude, that X is globally optimal (only 4 tested), or
  any adjudication/precision/autonomous-auditor claim.
- **Winner transfers better than absolutes**: the *ranking* of formulas is more likely to
  hold in the field than the absolute recall numbers. Report both; lean on the ranking.

---

# RESULTS (post-run, 2026-07-15)

Produced after §1-7 were frozen (commit `2bfb251`). Harness:
`platform/src/test/tools/recall-bakeoff.ts`; inputs + grid:
`./recall-gate-artifacts/{gate_code_formulas,gate_rules_richer,bakeoff_results}.json`.

## The grid (MACRO recall@5 = primary; micro shown for context)

| code formula | rule formula | macro@5 | micro@5 | floored-rescued/4 |
|---|---|---|---|---|
| concepts | richer   | **0.778** | 0.931 | 2 |
| concepts | oneliner | 0.637 | 0.690 | 2 |
| rawcode  | richer   | 0.600 | 0.793 | 1 |
| facets   | richer   | 0.589 | 0.828 | 1 |
| facets   | oneliner | 0.570 | 0.724 | 1 |
| rawcode  | oneliner | 0.522 | 0.655 | 1 |
| plain    | richer   | 0.459 | 0.483 | 1 |
| plain    | oneliner | 0.422 | 0.586 | 0 |

Naive headline: "concepts+richer wins, +0.356 macro@5 over the plain baseline." The
adversary (agent a2cd88a) **partially voided that reading.**

## The decisive finding: the win is a LEXICAL / FORMAT artifact, not semantic

The adversary re-ran the identical ranking with **pure token-Jaccard, embeddings removed
entirely**:

| combo | embedding macro@5 | **lexical-only macro@5** |
|---|---|---|
| plain / oneliner | 0.422 | **0.085** |
| concepts / oneliner | 0.637 | 0.611 |
| concepts / richer | 0.778 | **0.778** |

Pure keyword overlap **reproduces the winner exactly** (0.778 / 0.931); per-item @5 hit/miss
is 93% determined by shared tokens. The embedding adds essentially nothing on top of the
dense keyword formula — whereas it lifts *plain prose* from 0.085 (lexical) to 0.422 (5×).
So the "concepts wins" result is a dense-keyword-list embedding near keyword-dense rule
text by shared surface vocabulary — **a format effect a plain keyword search would also
get** — not evidence that concept lists are a semantically better *description*.

## What survives (stingy) / what is VOID

- **SURVIVES:** on this constructed corpus, a **dense concept-keyword code description
  beats plain prose** for recall@5 (concepts/* on top in ~99% of guideline bootstrap
  resamples). Real, reproducible — but a **lexical** lever, not a semantic one.
- **VOID — "concepts+richer is the best formula":** the `richer`-over-`oneliner` lift
  (+0.141) is within noise (paired bootstrap P=0.79, n=9); the winner is statistically
  indistinguishable from concepts+oneliner. Macro@5 CI on the winner is [0.444, 1.000].
- **VOID — the semantic-description reading:** the win is fully reproduced with the
  embedding removed; the embedding's genuine semantic contribution shows on prose, not on
  the keyword formula. Confound: `concepts` and `richer` are both LLM-authored in one
  "safety-critical C++" jargon idiom, so they share vocabulary without either seeing the
  other (not leakage — no rule IDs in concepts — but it inflates keyword-vs-keyword).
- **VOID — "rescues 2/4 as evidence for the winner":** F.16 is rescued by *any* dense code
  formula; C.48 is a `richer`-driven singleton; the rescued set is unstable across the
  rule axis.

## Implications for the system (the actually useful takeaway)

1. **Highest absolute recall ≠ best use of the vector index.** Dense keyword descriptions
   top the table, but by lexical overlap the embedding isn't needed for — a keyword/BM25
   search would match it. The vector index earns its keep on **prose** (5× lift over
   lexical), where surface tokens don't align.
2. This points at **hybrid retrieval** (lexical + vector) as the likely real win, and/or
   authoring descriptions that are **information-rich prose** (so the vector adds value)
   rather than keyword lists (where it's just keyword search wearing a vector costume).
3. The doc-10 gate's "descriptions lift recall" conclusion still stands, but this sharpens
   *why*: on opaque-ID corpora a large part of the lift is getting *any* shared vocabulary
   onto both sides — a lexical effect — with a smaller genuine semantic component (visible
   on prose). Do not over-credit the embedding.

## Disposition for nmemo-uhp.15

Bake-off DONE, adversarially verified. Honest answer to "which description does the best
job": **dense concept-keyword descriptions score highest on this corpus, but as a lexical
effect — not proof of a semantically superior description, and the rule-side `richer` axis
is within noise.** Recommendation for a follow-up (not run here): test **hybrid
lexical+vector retrieval** and prose-vs-keyword under a keyword-search control, on a corpus
with less-opaque rule names, before committing an authoring convention. No production
default changes on this alone.
