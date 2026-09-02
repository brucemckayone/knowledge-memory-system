# Pre-registration 27 — NAME-ONLY cross-encoder reranking of the fusion pool (confirming the doc-26 lead)

**Bead:** nmemo-u8j.4 · **Depends on:** nmemo-u8j.1 (fusion), nmemo-u8j.2 (eval engine), doc 26 (the lead)
**Status:** FROZEN. Append results below the line; do not edit above it.
**Committed before computing:** yes.

## 1. Why this exists

Doc 26 (prereg-26) tested cross-encoder reranking with a `name + ≤10 held-out fact-sentence` candidate and
found it NEGATIVE (arxiv strict R@10 −0.1059, below 0 all three; qbio tie). But an **exploratory, NOT
pre-registered** name-only slice (n=60 arxiv, seed 20260901) showed the opposite for a bare-name candidate:
RERANK 21/60 = 0.350 vs FACTNAME 13/60 = 0.217 (**+0.133**), while name+facts tied fusion on that same slice.
The candidate representation was decisive — the fact-blob misled the reranker. **That +0.133 is a LEAD, not a
result** (n=60, single point estimate, no bootstrap, not pre-registered). This prereg confirms-or-kills it at
full scale under the same discipline as every other loop result.

## 2. Design (identical to prereg-26 EXCEPT the candidate)

- Same pool: top-**K=50** of the shipped fusion `FACTNAME = RRF-60(dense-names, dense-facts)`, index-asc.
- **candidate_text = the bare entity `canonical_name` ONLY** (no fact sentences). This is the sole change
  from prereg-26. `rerank-dump.ts --candidate=name`.
- Same model `BAAI/bge-reranker-v2-m3`, same query = title+abstract, same two-stage TS→Python→TS pipeline,
  same frozen `retrieval-eval` metric/oracle/bootstrap engine.
- **Substrate:** PRIMARY = arxiv (arxiv-nlp + arxiv-cv, **full n=387** — not the 60-slice). SECONDARY = qbio
  (n=94).
- **Arms:** `FACTNAME` (fusion baseline), `RERANK_name` (cross-encoder over the K=50 pool, name-only cand).

## 3. Metric, statistics, ceiling

- **R@10**, both oracles. **PRIMARY = RERANK_name − FACTNAME, strict R@10.**
- Cluster bootstrap by pair AND entity AND document (seed 20260831, 10,000 resamples).
- Report the pool-recall ceiling (FACTNAME R@50) — unchanged from doc 26 (50.9% arxiv / 57.4% qbio), since
  the pool is identical; only the reranking of it changes.

## 4. Pre-registered bar & decision rule

- **PRIMARY (DEMONSTRATED):** `RERANK_name − FACTNAME`, **strict** R@10, **> 0 on ALL THREE bootstraps**
  (pair/entity/doc) on **arxiv (n=387)** ⇒ a name-only cross-encoder reranker beats the fusion — the FIRST
  lever to beat the fusion since R4. Condensed reported alongside. This would justify a gated production
  reranker (a SEPARATE step).
- **Decision:**
  - strict clears all three on arxiv ⇒ DEMONSTRATED; the doc-26 lead is real; file the gated build.
  - strict positive but not all-three (or condensed-only) ⇒ a lead that did not clear at full scale; report
    honestly, do NOT ship (the doc-12 hybrid precedent).
  - strict ≤ 0 / spans 0 ⇒ the n=60 slice did not hold; the doc-26 negative stands for name-only too; banked.

## 5. Kill / VOID

- **VOID (wiring):** arxiv FACTNAME must reproduce R4 (strict 0.26356589147286824, n=387) in the dump — else
  the harness drifted.
- **VOID (pool mismatch):** the name-only pool must be the SAME K=50 fusion pool as doc 26 (same
  factnameStrictRank per pair, same ceiling) — only pool[].text differs. Verify the ceiling == 50.9% arxiv.
- **Underpowered:** guards the qbio secondary (n=94 > 30 fine; the n=60 slice is explicitly NOT the test).

## 6. Adversary (before banking)

Blind adversary: (a) wiring anchor; (b) confirm the pool is identical to doc 26 (ceiling, factname ranks) and
only the candidate text changed to name-only; (c) re-derive RERANK_name − FACTNAME as integer hits;
(d) confirm the cross-encoder saw ONLY the name (no fact text leaked into candidate_text); (e) confirm the
full n=387 was used (not the 60-slice); (f) spec froze before the full-scale numbers; (g) attack the
direction — is a positive real, or a pool/oracle/tie-break artifact; is a negative genuine or underpowered.

---

<!-- RESULTS APPENDED BELOW THIS LINE -->

## RESULTS (2026-09-02) — clears the pre-registered bar, but it is a NAME-IN-QUERY LEXICAL ARTIFACT, not a lever

**Outcome:** the name-only cross-encoder rerank clears the frozen PRIMARY bar (strict R@10 > 0 on all three
bootstraps, both substrates) — **but the pre-registered bar was BLIND to a name-in-query artifact.** ~80% of
targets appear verbatim in the query abstract, and a trivial `query.includes(canonical_name)` reranker BEATS
the cross-encoder. The cross-encoder is NOT the lever; it does not improve target-specific ranking (R@1
regresses) and does not transfer to queries that lack the target's name. Blind adversary ruled (b);
reproduced independently here via `rerank-lexcheck.ts`. **Do NOT ship a cross-encoder; do NOT call this "the
first lever to beat the fusion."**

### The headline numbers (real, reproduced bit-exact, pool identical to doc 26)
| substrate | n | FACTNAME strict R@10 | RERANK_name strict R@10 | Δ strict (all 3 bootstraps) | Δ condensed |
|---|---|---|---|---|---|
| arxiv | 387 | 0.2636 | 0.3359 | +0.0724 ABOVE 0 [pair .031–.116] | +0.1525 ABOVE 0 |
| qbio  | 94  | 0.3511 | 0.5426 | +0.1915 ABOVE 0 [pair .106–.277] | +0.1915 ABOVE 0 |
Hits: arxiv 102→130 (+28); qbio 33→51 (+18). Candidate genuinely name-only (max 110 chars, 0 fact-sentences).

### Why it is an ARTIFACT, not a lever (`rerank-lexcheck.ts`, reproduced independently)
1. **Name-in-query rate is ~80%.** The target's canonical_name appears verbatim (normalized substring) in the
   query title+abstract for **313/387 = 80.9%** (arxiv) / **74/94 = 78.7%** (qbio). Intrinsic to the task
   (the query paper is one of the ≥2 papers the target was extracted from) — not a data leak, but it means
   the task is largely "surface the name already present in the query."
2. **A trivial substring reranker BEATS the cross-encoder** (same K=50 pool, same fusion tie-break):
   | arm | arxiv strict R@10 (Δ) | qbio strict R@10 (Δ) |
   |---|---|---|
   | FACTNAME (fusion) | 0.2636 | 0.3511 |
   | RERANK (bge cross-encoder) | 0.3359 (+0.0724, +28) | 0.5426 (+0.1915, +18) |
   | **LEX (`query.includes(name)`)** | **0.3824 (+0.1189, +46; CI [.083,.155])** | **0.5638 (+0.2128, +20; CI [.128,.298])** |
   LEX captures **164%** (arxiv) / **111%** (qbio) of the cross-encoder's strict gain. The 568M cross-encoder
   at ~18–22 s/query adds nothing over — is worse than — a `contains()` test.
3. **R@1 REGRESSES:** arxiv RERANK 0.062 < FACTNAME 0.070; qbio 0.064 < 0.128. The reranker does NOT improve
   target-specific ranking; it floats the whole name-present cluster mid-pool (condensed R@1 ~doubles), so the
   target rides into the top-10 but not to #1.
4. **strict << condensed** because the condensed oracle forgives Tier-B (verbatim-name) matches — exactly what
   a name-matcher floats up — so condensed over-credits it. Even the strict win is dominated by the lexical
   signal.
5. **No non-lexical transfer.** On the not-in-query subgroup (target name absent from the query, the only
   within-experiment proxy for real retrieval): arxiv RERANK **+5/74** (thin, not significant), qbio **+0/20**
   (zero); LEX is **−7/74** off-query (actively hurts). The cross-encoder edges LEX only off-query and only on
   arxiv by a thin, unbootstrapped +5 — not enough to claim a capability.
6. **Tie-break:** ~19% of cross-encoder scores tie within a pool, so the fusion-order tie-break is load-
   bearing; sign is robust (reversed tie-break still +0.0465 arxiv) but magnitude is partly tie-break.

### Adversary (§6) — all mechanics PASS; ruling (b) = real but a name-in-query artifact
Checks 1–6 PASS: wiring anchor bit-for-bit (FACTNAME 0.2636 = R4; regenerated pool bit-identical to the
scored pool, 0/387 mismatches), eval reproduced bit-exact, pool identical to doc 26 (0 mismatches on target/
ranks/pool-order/relevant), candidate genuinely name-only, full n=387/94, froze first (`git show d4aea90`
adds only the prereg + tools, no result JSON). Check 7/8: the win is a name-in-query lexical artifact that a
substring test captures better, with no demonstrated target-specific (R@1 down) or non-lexical-transfer
value. The prereg's own bar was met, but it never registered a name-in-query control, so the gate was blind
to the artifact — a lesson for future rerank preregs (register a lexical-baseline + not-in-query control arm).

### Disposition
**NET for nmemo-u8j.4: cross-encoder reranking yields NO shippable retrieval lever.** doc 26 (name+facts)
hurt; doc 27 (name-only) clears the naive bar but is a name-in-query lexical artifact a `contains()` beats.
The two-signal fusion stays the head. Do NOT build a cross-encoder reranker. **Meta-diagnostic worth
carrying:** ~80% of this eval's targets appear verbatim in the query — the target-finding task is largely
name-presence detection (a papers-as-queries limitation affecting the whole loop, not just this arm); the
LEX result shows the fusion under-promotes exact name matches, but exploiting that would not transfer to
real (non-document) queries. Any future pool reranker needs a fresh prereg that registers `query-contains-
name` as a control and tests the not-in-query subgroup as the real-retrieval proxy.

### Artifacts
`prereg-artifacts/rerank-{results,scores,pool}-{arxiv,qbio}-name.json`. Tools: `rerank-dump.ts --candidate=name`,
`rerank_score.py`, `rerank-eval.ts`, `rerank-lexcheck.ts` (the name-in-query + LEX diagnostic).
