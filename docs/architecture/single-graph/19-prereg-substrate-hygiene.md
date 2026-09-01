# Pre-registration 19 — substrate hygiene: duplicate-name tie-break sensitivity + read-path dedup

**Bead:** nmemo-u8j.9 · **Depends on:** nmemo-u8j.1 (shipped fusion read path), nmemo-u8j.2 (eval engine)
**Status:** FROZEN. Append results below the line; do not edit above it.
**Committed before computing:** yes — this file is committed before the retrieval-impact harness is run.
The descriptive substrate counts in §2 are pure DB facts (acceptance criterion 1) computed before
freezing; the gated bars in §6 concern the retrieval-impact **deltas**, which have NOT been computed when
this is frozen.

## 1. Question

The read path embeds the entity **name only** (`entityEmbedTextFor(name, desc, 'name')`), and dedup is
off at write time (the predicate fold stays OFF — lossy, per the keep-list). So entities that share a
`canonical_name` get an **identical name vector** and tie **exactly** under name-vector cosine. The keep
list records the consequence: "every absolute R@10 rides on the index-asc tie-break … deltas are robust,
absolute levels are not." `rankByScore` (core.ts:51) breaks those ties by array index, i.e. entity `id`
order — an arbitrary artifact of ingest.

**Two questions, one decision:**

1. **Is the confirmed R4 fusion lever (FACTNAME − NAME) actually robust to the tie-break, as the keep
   list claims** — or does it depend on index-asc the way absolute levels do?
2. **Should the read path dedup/merge results by `canonical_name`** (a lossy display-level collapse, NOT
   a write-time merge), and what is its retrieval impact (delta on the fusion baseline)?

## 2. Substrate facts (descriptive; DB, computed before freeze — NOT a gated result)

`cognitive_test`, the four retrieval corpora. Two framings of "duplicate": `dup_rate` = extra copies /
total; `pct_shared` = fraction of entities living in a shared-name group (size ≥ 2).

| corpus | entities | distinct names | dup_rate | ents in shared group | pct_shared | shared names | max group |
|---|---|---|---|---|---|---|---|
| arxiv-nlp | 1230 | 1070 | 13.0% | 241 | 19.6% | 81 | 21 (`chatgpt`) |
| arxiv-cv  | 1282 | 1169 |  8.8% | 189 | 14.7% | 76 |  8 (`stable diffusion`) |
| dal-nlp   | 1133 | 1001 | 11.7% | 199 | 17.6% | 67 | 19 (`chatgpt`) |
| dal-cv    | 1262 | 1157 |  8.3% | 179 | 14.2% | 74 |  9 (`segment anything model`) |

Reproduces the keep-list / bead figures ("14–18% duplicate"; `chatgpt` ×19, `large language models` ×12
on dal-nlp). Biggest groups are generic head terms (`chatgpt`, `large language models`, `stable
diffusion`), which are plausibly the same concept — but not guaranteed (e.g. `cnn`), which is exactly why
a write-time merge is refused and only a **read-path** collapse is on the table.

## 3. Substrate & harness

Identical to R4 / candidate-breadth (doc 17): same query pairs, same held-out fact guard (every fact arm
excludes facts sourced from the query document), same cached query/entity vectors, same `cognitive_test`
entities/facts, exact in-process cosine (not a live DB round-trip), the SHIPPED
`services/fusion.reciprocalRankFusion` and `retrieval-eval/core`. Thin config over the eval engine.

- **Primary substrate:** arxiv-nlp + arxiv-cv (the R4-confirmed independent extraction; n≈387 pairs).
- **Secondary substrate:** dal-nlp + dal-cv (n=354 pairs).

## 4. Arms

Two base arms, each rendered under three tie-break policies and one dedup transform.

- **NAME** — full name-vector ranking (baseline).
- **FACTNAME** — the frozen R4 arm: `RRF-60(full name ranking, fact-max over ALL held-out facts)`. The
  integrity anchor.

**Tie-break policies** (vary how equal cosines — and equal fused RRF scores — are ordered):
- **asc** — index ascending (= entity-`id` order). The canonical / frozen policy.
- **desc** — index descending. The adversarial policy the keep list says "voids doc 05's gate".
- **rand** — a single fixed seeded permutation (seed 20260831) applied as the tie-break key; a neutral
  arbitrary order distinct from id-order.

The tie-break is applied consistently to the base name ranking, the fact ranking, and the RRF tie-break.

**Dedup transform (the read-path candidate).** Collapse the ranked list to **one representative per
`canonical_name`, keeping the best-ranked member** (first occurrence). Formally: the universe becomes the
set of `canonical_name` groups; a group is scored by its best member; the ranking is the first-seen order
of group ids. The target and the condensed relevant-set are remapped to their group ids, and scored with
the SAME `strictRankOf` / `condensedRankOf` (core.ts) over group ids. This is the honest evaluation of a
merge/canonicalise read path: finding **any** twin of the target = finding the concept. Applied to both
arms, under asc/desc (dedup × rand omitted — the point is the swing between the two extremes).

**Group-collapse VOID check:** the group count per corpus must equal `distinct_names` in §2 exactly, and
NAME_dedup must lose no target that had a group of size 1.

## 5. Metric & statistics

- **R@10**, both oracles: **strict** and **condensed** (min-3 Tier-A∪Tier-B, per E0/doc 07).
- **Primary oracle = condensed** (decision nmemo-u8j.10). Strict reported alongside; the condensed oracle
  is not arm-neutral (doc 12 §3), so both are always shown.
- **Deltas** (levels ride the tie-break, so the lever is a delta): `FACTNAME − NAME` within each
  tie-break policy; and `arm_dedup − arm` within each policy for the dedup impact.
- **Cluster bootstrap** by pair AND entity AND document (seed 20260831, 10,000 resamples).
- **Descriptive (not gated):** absolute R@10 per arm under each tie-break; the **level swing** =
  max − min of absolute R@10 across {asc, desc, rand}; the count of query pairs whose target ties exactly
  (≥1 other entity at identical name cosine).

## 6. Pre-registered bars & decision rule

- **BAR 1 — the R4 lever is tie-break-robust (the load-bearing keep-list claim).** `FACTNAME − NAME`,
  **condensed** R@10, **byPair** CI lower bound **> 0 under ALL THREE tie-breaks {asc, desc, rand}** on
  the arxiv primary substrate. Strict reported. If it holds ⇒ "deltas robust" is confirmed empirically,
  not just asserted. If the delta **flips sign or loses byPair significance under any tie-break** ⇒ this
  CONTRADICTS a banked claim (keep list + R4) ⇒ **HALT and report** (protocol g), do not push through.
- **BAR 2 — levels ride the tie-break (expected; a characterization, quantify not gate).** Report the
  NAME absolute-R@10 level swing across {asc, desc, rand}. Expectation: non-trivial (> 0.01). This is not
  pass/fail; it quantifies the motivation.
- **READ-PATH DECISION (dedup).** Recommend **adopt read-path dedup** IFF, on the primary substrate,
  BOTH: (a) it **preserves the lever** — `FACTNAME_dedup − NAME_dedup` condensed byPair stays ABOVE 0;
  AND (b) it **materially reduces the level swing** — the NAME_dedup asc-vs-desc absolute-R@10 swing is
  **< half** the NAME (non-dedup) asc-vs-desc swing. Otherwise recommend **no dedup** (report deltas
  only; the read path is unchanged). Either way the decision and its measured impact are recorded — that
  is the acceptance criterion. Report `FACTNAME_dedup − FACTNAME` (group-aware) as the direct impact.

## 7. Kill / VOID conditions

- **VOID (mis-wired):** the index-**asc** NAME and FACTNAME arms do NOT reproduce the frozen R4 numbers
  bit-for-bit on arxiv — NAME strict `0.19121447028423771`, cond `0.24289405684754523`; FACTNAME strict
  `0.26356589147286824`, cond `0.29198966408268734`; `FACTNAME−NAME` strict byPair delta
  `0.07235142118863053`, condensed byPair delta `0.049095607235142114`.
- **VOID (dedup mis-wired):** group count per corpus ≠ `distinct_names` (§2), or NAME_dedup drops a
  target whose group size is 1.
- **Degeneracy guard:** if dedup removes < 1% of list positions (i.e. the substrate has ~no duplicates in
  the retrieved head), the dedup arm is a near-no-op — report and draw no positive conclusion.

## 8. Adversary

Blind adversary before banking: (a) confirm the asc integrity anchor reproduces frozen R4 live; (b)
re-derive at least one tie-break's `FACTNAME − NAME` condensed delta from the raw ranks; (c) verify the
dedup transform truly collapses by `canonical_name` (group count == distinct names) and that the
group-aware oracle is applied consistently to target AND relevant set (no asymmetry that flatters dedup);
(d) confirm the tie-break variants actually change the base ranking order (desc is not silently equal to
asc) and re-derive the NAME level swing; (e) check the spec was frozen before compute and the
condensed-primary choice predates this (nmemo-u8j.10), not picked post-hoc.

---

<!-- RESULTS APPENDED BELOW THIS LINE -->
