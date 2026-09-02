# Pre-registration 26 — cross-encoder reranking of the two-signal fusion pool

**Bead:** nmemo-u8j.4 · **Depends on:** nmemo-u8j.1 (fusion read path), nmemo-u8j.2 (eval engine)
**Status:** FROZEN. Append results below the line; do not edit above it.
**Committed before computing:** yes.

## 1. Question

R4/doc 16 confirmed the two-signal fusion `FACTNAME = RRF-60(dense-over-names, dense-over-facts)` as the one
lever that beats name-only. doc 10 tested only a **dense** re-rank of a pool (tie — the only re-ranker that
improved the head *was* the head). The field-standard lever we have NOT tested is a **cross-encoder**: a model
that reads the query and a candidate *jointly* (not two independent embeddings), which can capture
interactions a bi-encoder cannot.

**Does reranking the top-K fusion pool with an open cross-encoder beat the fusion baseline (`FACTNAME`) on
R@10 — strict, all three bootstraps > 0 — on a well-populated graph?**

## 2. Design

- **Retrieve** the top-**K=50** candidate entities per query via the shipped two-signal fusion
  `FACTNAME = RRF-60(rName, rFactMax)` (the exact arm the eval engine computes; index-asc tie-break).
  K=50 is the "wide pool" (doc 11 proved 50 preserves the R4 lever). Also report K=100 as a sensitivity.
- **Rerank** the pool with a cross-encoder scoring each `(query_text, candidate_text)` pair jointly, then
  order the pool by descending cross-encoder score (stable tie-break = original fusion order).
- **query_text** = `"{title} {abstract}"` of the query document (identical to the eval's query text).
- **candidate_text** = `"{canonical_name}. "` + up to 10 of the entity's fact `source_text` sentences,
  **held-out** (exclude any fact whose source paper == the query doc, the same guard the fusion uses). This
  gives the cross-encoder the same substrate the fusion had (name + facts), so the test isolates the
  *reranking mechanism*, not an information advantage. If an entity has 0 held-out facts, candidate_text =
  the name alone.
- **Model:** `BAAI/bge-reranker-v2-m3` (open, multilingual, the bead's first pick). Run locally (CPU) in an
  isolated venv; no external API, no Claude. Record the exact model id + revision + device + latency. If the
  model genuinely cannot be provisioned, the fallback is `BAAI/bge-reranker-base`, then
  `cross-encoder/ms-marco-MiniLM-L-6-v2`; the actually-used model is recorded in the results (a fallback does
  NOT change the frozen bar).
- **Substrate:** PRIMARY = arxiv (arxiv-nlp + arxiv-cv, R4-confirmed, n≈387). SECONDARY = qbio (doc 24,
  n≈94) — to see whether reranking helps where the *degree-poor* fusion did not.
- **Arms:** `FACTNAME` (fusion baseline = the thing to beat), `RERANK` (cross-encoder over the K=50 fusion
  pool). `NAME` reported for reference. All scored under BOTH oracles by the same `retrieval-eval` engine
  (core.ts oracle + bootstrap primitives), so the numbers are directly comparable to R4/doc 20/24.

## 3. Pipeline (two-stage, so metric computation stays in the frozen TS engine)

1. **TS dump:** a thin tool over `retrieval-eval/{data,core}` builds the query pairs + fusion pool (top-K
   FACTNAME per pair) and writes, per pair: query_text, and for each of the K pool entities its
   entity_id + candidate_text (name + ≤10 held-out fact source_texts). Also emits the fusion baseline
   rankings so RERANK and FACTNAME are scored on the identical pair set.
2. **Python score:** a standalone script loads the cross-encoder once and scores every (query, candidate)
   pair, writing `{pairIdx: {entityId: score}}`. CPU; batched. Records wall-clock + per-query latency.
3. **TS score:** reads the scores, reorders each pool by cross-encoder score (fusion-order tie-break),
   computes strict + condensed rank of the target, and runs the 3 cluster bootstraps (seed 20260831) — the
   SAME `clusteredBootstrap` R4 used. Emits the arm table + primary delta + pool-recall ceiling.

## 4. Metric, statistics & the ceiling

- **R@10**, both oracles. **PRIMARY = RERANK − FACTNAME, strict R@10.**
- Deltas via cluster bootstrap by pair AND entity AND document (seed 20260831, 10,000 resamples).
- **Pool-recall ceiling (MUST report):** reranking can only surface targets that are IN the K-pool, so the
  achievable RERANK R@10 is bounded by the fusion's R@K. Report `FACTNAME R@K` (the ceiling) and the fraction
  of targets present in the pool. If the ceiling is at/near FACTNAME R@10 (no headroom), the experiment is
  ceiling-bound and a null is expected/uninformative (see kill).
- Report cross-encoder latency (ms/query at K=50) and the model id — the bead requires it.

## 5. Pre-registered bar & decision rule

- **PRIMARY (DEMONSTRATED):** `RERANK − FACTNAME`, **strict** R@10, **> 0 on ALL THREE bootstraps** (pair/
  entity/doc) on **arxiv** ⇒ cross-encoder reranking is a real lever ⇒ a production reranker is worth
  building (as a SEPARATE, gated step). Condensed reported alongside.
- **Decision:**
  - strict clears ⇒ reranking beats fusion; file the gated production reranker; report latency/pool cost.
  - strict fails but condensed clears ⇒ oracle-dependent lift; document honestly (do NOT ship on condensed
    alone; a fresh pre-reg like the hybrid `.18` precedent).
  - fails both ⇒ cross-encoder reranking does NOT beat the two-signal fusion on this task; banked NEGATIVE
    (a valid outcome — consistent with doc 10's dense-rerank tie and the "fusion is already the head" finding).

## 6. Kill / VOID conditions

- **VOID (wiring):** the eval, pointed at arxiv, must reproduce R4's `FACTNAME` numbers bit-for-bit
  (NAME strict `0.19121447028423771`, FACTNAME strict `0.26356589147286824`, n=387) ⇒ else the harness
  drifted; fix before trusting RERANK.
- **VOID (ceiling-bound):** if the K=50 pool-recall ceiling (FACTNAME R@50) is not meaningfully above
  FACTNAME R@10, there is no headroom for reranking to demonstrate anything ⇒ report the ceiling and treat a
  null as uninformative, not as a reranker verdict (raise K or change the pool, don't claim).
- **VOID (model):** the cross-encoder produces degenerate scores (all-equal, or NaN) ⇒ fix the model/tokeniser
  before scoring.
- **Underpowered:** < 30 query pairs ⇒ no pass/fail (arxiv n≈387 is fine; guards the qbio secondary).

## 7. Adversary (before banking)

Blind adversary: (a) confirm the wiring anchor reproduces R4; (b) re-derive RERANK − FACTNAME as an integer
hit-count on the same pairs; (c) confirm the cross-encoder saw held-out candidate_text (no query-doc fact
leak into the candidate); (d) confirm RERANK is scored on the SAME pair set as FACTNAME (no pair added/dropped
by pooling); (e) check the pool-recall ceiling is honestly reported and the verdict respects it; (f) confirm
the spec froze before the numbers; (g) attack the direction of any framing (a null must not be laundered into
"cross-encoders are useless", nor a ceiling-bound null into a real negative).

---

<!-- RESULTS APPENDED BELOW THIS LINE -->

## RESULTS (2026-09-02) — cross-encoder reranking does NOT beat the fusion (NEGATIVE; hurts arxiv, ties qbio) — but a name-only variant REOPENS it

**Outcome:** the pre-registered PRIMARY fails both substrates. Reranking the top-K=50 fusion pool with an
off-the-shelf cross-encoder (`BAAI/bge-reranker-v2-m3`) using the frozen `name + ≤10 held-out facts`
candidate HURTS on arxiv (strict R@10 Δ **−0.1059, below 0 all three bootstraps**) and TIES on qbio (Δ
−0.0106, spans 0). Blind adversary reproduced everything bit-for-bit and confirmed the negative is a real
reordering failure (not a truncation/leak/ceiling artifact). **BUT** an exploratory name-only slice shows the
candidate REPRESENTATION was decisive — a bare-name cross-encoder BEATS the fusion (+0.133 on n=60) —
reopening the question. Banked NEGATIVE for the frozen config; name-only pursued under a fresh prereg (doc 27).

### Setup
- Model **BAAI/bge-reranker-v2-m3** (open, multilingual, 568M), local CPU, isolated venv (torch 2.13.0+cpu,
  transformers 5.16.1, sentence-transformers 6.0.1). No external API, no Claude. max_length=512.
- Pool K=50 from the shipped fusion `FACTNAME=RRF-60(names,facts)`; candidate_text = `"{name}. "` + up to 10
  HELD-OUT fact source_texts (query-doc facts excluded); query = title+abstract. Two-stage TS-dump →
  Python-score → TS-score, so the metric stays in the frozen engine. Wiring anchor PASSES bit-for-bit
  (FACTNAME reproduces R4 on both substrates).

### PRIMARY (§5) — FAILS both
| substrate | n | FACTNAME strict R@10 | RERANK strict R@10 | Δ strict (pair/entity/doc) | condensed Δ | ceiling R@50 |
|---|---|---|---|---|---|---|
| arxiv | 387 | 0.2636 | 0.1576 | **−0.1059 BELOW 0 all 3** | −0.0698 BELOW 0 all 3 | 50.9% |
| qbio  | 94  | 0.3511 | 0.3404 | −0.0106 SPANS 0 | +0.0106 SPANS 0 | 57.4% |

Integer hits @10: arxiv FACTNAME 102 → RERANK 61 (−41); qbio 33 → 32 (−1). On arxiv RERANK is worse at every
k (R@1 0.016 vs 0.070).

### Not ceiling-bound (the strongest point FOR the finding)
The K=50 pool contained the target for **50.9%** of arxiv queries (== FACTNAME R@50, adversary-verified
197/387) — nearly 2× the fusion R@10 (26.4%) and 3× RERANK (15.8%). Ample headroom existed; the reranker used
it to push correct targets DOWN (demoted targets land at median rerank position 23). A genuine reordering
failure, not the VOID(ceiling-bound) escape hatch.

### Mechanism (evidenced, not asserted)
Of the 65 targets FACTNAME had in top-10 that RERANK ejected, **64/65 were scored on the FULL, untruncated
candidate** (median 173 tokens < 512) and still scored low — 36/65 below 0.5, 15/65 below 0.1. Candidate
tokens are short (median 65, p99 313, name always first); truncation, when it happens (18.7% of arxiv pairs),
trims the ABSTRACT tail, never the name/facts. So "the fact-blob drowns the name" and "the name gets
truncated" are both false. The cross-encoder reorders by query↔passage **topical relevance**, which is not
the same objective as **cross-paper target identity**, so it confidently demotes the correct recurring
target the fusion surfaced. Reinforces doc 10 (dense re-rank tie: "the only re-ranker that improves the head
is the head").

### Name-only sensitivity — the surprise: representation is decisive; a name-only reranker is a LEAD
Exploratory, **n=60 random arxiv slice** (seed 20260901), NOT pre-registered:
| arm | strict R@10 hits (of 60) | vs fusion |
|---|---|---|
| FACTNAME (fusion) | 13/60 = 0.217 | — |
| RERANK name+facts (the prereg config) | 13/60 = 0.217 | +0/60 (tie on this slice; −0.106 on full 387) |
| **RERANK name-only** | **21/60 = 0.350** | **+8/60 = +0.133** |

The candidate REPRESENTATION is decisive: the concatenated fact-blob MISLEADS the cross-encoder (pulls its
topical judgement toward the facts' content, away from name-identity), and with the **bare entity name** the
cross-encoder BEATS the fusion on this slice. This is the one result the adversary flagged as able to reopen
the scoping — and it did. It is a genuine **LEAD, not a banked win**: n=60, single point estimate, no
bootstrap, not pre-registered (the doc-12 "small-K hybrid = lead not demonstration" precedent). Confirm only
via a full-scale (n=387), both-oracle, all-3-bootstrap, adversary-checked run under a fresh pre-registration
(doc 27). The pre-registered PRIMARY here (name+facts) stays negative.

### Adversary (§7) — verdict SUPPORTED (for the frozen config); all checks PASS
(1) wiring anchor bit-for-bit (NAME 0.1912 / FACTNAME 0.2636, n=387); (2) both substrates reproduced exactly,
integer hits independently re-derived (gained 24 − lost 65 = −41/387); (3) same pair set, 0 degenerate
scores, every pool exactly 50; (4) held-out guard correct (candidate uses the same factToPaper map the fusion
uses; a leak would only HELP rerank, so its absence makes the negative conservative); (5) scores real +
discriminating (full sigmoid range, strong per-query spread); (6) ceiling honest and NOT ceiling-bound;
(7) froze before numbers (`git show d487842` adds only the prereg; committed doc == working tree). Check 8:
the frozen-config negative is a real reordering failure, not truncation/leak/representation-drowning/ceiling.
The adversary's mandatory scope (this model + this candidate + full-abstract query, NOT "cross-encoders in
general"; "impractical" is CPU-specific) is adopted. The adversary explicitly predicted the name-only variant
would NOT beat fusion and asked to confirm — the confirmation instead FALSIFIED that prediction (+0.133 on
the slice), which is why the name-only lead is now the live thread.

### Disposition (per §5: PRIMARY fails both — but the door is NOT closed)
**The pre-registered config (name+facts candidate) is a BANKED NEGATIVE** — it does not beat the fusion
(hurts arxiv, ties qbio). **Do NOT read this as "cross-encoders can't help this task":** the name-only slice
(+0.133 on n=60) shows the *representation* was the culprit, and a name-only cross-encoder is a live LEAD.
**Next step: a fresh pre-registration (doc 27) runs name-only reranking at full scale (n=387, both oracles,
all-3 bootstraps, blind adversary)** before any build/claim. Bead nmemo-u8j.4 stays OPEN pending that.
**Cost:** ~22 s/query at K=50 on CPU (~445 ms/candidate) — CPU-specific; a GPU would be far faster.

### Artifacts
`prereg-artifacts/rerank-results-{arxiv,qbio}.json`, `rerank-scores-{arxiv,qbio}.json`,
`rerank-pool-{arxiv,qbio}.json`. Tools: `rerank-dump.ts`, `rerank_score.py`, `rerank-eval.ts`. Model cached
at `~/.cache/huggingface/hub/models--BAAI--bge-reranker-v2-m3` (2.2 GB), scored in an isolated scratch venv.
