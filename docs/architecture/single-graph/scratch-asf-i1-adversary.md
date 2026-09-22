# Blind-adversary audit — I1-local LongMemEval_S retrieval (doc 42, nmemo-asf.13)

Auditor: independent blind adversary. Working from SOURCE
(`benchmarks/longmemeval/data/longmemeval_s_cleaned.json`, 500 instances), NOT the harness's
derived cut, embed cache, or result JSON. Scripts live in the session scratchpad; no production
code was changed. Claim under audit: DENSE-FLAT session recall@10 = 1.000 (recall@5 0.947,
nDCG@10 0.914) on n=150; BM25-FLAT 0.967; DENSE+BM25 0.987; H1 = -0.0133 CI[-0.033, 0.000] SPANS 0.

Population reproduced from source, independently: n = 150 exactly
(single-session-user 64, single-session-assistant 56, single-session-preference 30), after
excluding `_abs`. Matches the harness's per-type n exactly.

---

## Step 1 — POSITIONAL ARTIFACT (source-only, no embedding)

For each of the 150 I1 questions the gold session appears exactly once (`n_gold_per_q`: all = 1).
Position of the single gold session within its own `haystack_session_ids`:

- absolute index: min 0, max 51, mean 26.73, median 29 (haystacks: min 41, median 48, max 62).
- **at index 0: 1/150. at index 0 or 1: 1/150.**
- fractional-position histogram is essentially flat across [0,1); **mean fractional position 0.562**
  (0.5 = uniform; near 0 = leading). If anything gold sits slightly LATE, not early.

The index-ascending tie-break can only manufacture rank when scores tie. Gold is not front-loaded,
so the tie-break cannot be inflating rank via position. The harness's reported
`tiebreak_dense_recall_at_10_delta = 0.0000` is independently plausible: (a) dense cosine scores are
continuous floats (verified in step 4 — no exact session-score ties observed), and (b) recall@10 is
already 1.000 with the `>10` bucket empty, so gold is strictly inside the top-10 by score and NO
tie-break order can change recall@10 (asc/desc give the same 1.000). The zero delta is a
consequence of the ceiling, not evidence of a clean margin.

**VERDICT: PASS — no positional artifact.** Gold is near-uniformly distributed (mean frac 0.562);
only 1/150 questions has gold at index 0. Tie-break sensitivity is genuinely 0 but for the benign
reason that recall@10 is ceilinged, not because scores are cleanly separated.

## Step 2 — ORACLE MAPPING (source-only)

- **UNRESOLVED gold ids: 0/150** — every `answer_session_ids` entry resolves inside that question's
  own `haystack_session_ids`. Confirms doc 42 §6's "0 unresolved" claim independently.
- **gold sessions with NO `has_answer:true` turn: 0/150** — every gold session carries at least one
  evidence turn, so the label is anchored to real evidence.
- Off-by-one is structurally impossible: the harness matches gold by SESSION-ID string equality
  (`q.answer_session_ids.includes(s.session_id)`), not by list index, so a reordering or index shift
  cannot mis-map. I re-derived the id->session map independently and got 0 mismatches.
- Answer-string plausibility: of the 132 questions whose answer contains content tokens (len>=3,
  non-numeric), **132/132 (100%)** have >=50% of the answer's key tokens present in the gold session
  text. Examples: "What degree did I graduate with?" -> "Business Administration" (gold turn: "I
  graduated with a degree in Business Administration"); "How long is my daily commute?" -> "45 minutes
  each way" (gold: "my daily commute, which takes 45 minutes each way").

**VERDICT: PASS — oracle is sound.** 0 unresolved, 0 gold-without-evidence, id-based mapping (no
off-by-one), and the answer content genuinely lives in the labelled gold session.

## Step 3 — LEAKAGE / IS IT REALLY RETRIEVAL (source-only)

I re-implemented BM25 (k1=1.2, b=0.75, `[^a-z0-9]+` tokeniser, whole-turn docs, session = MAX over
turns, rank desc / index-asc, minScore 0) from scratch in python and ran a **pure BM25 of the
QUESTION** against each haystack:

- **pure-BM25 recall@10 = 0.9667 — bit-exactly the harness's BM25-FLAT claim (0.9667).** recall@5
  0.9333, rank-1 count 128/150. Gold BM25 rank buckets {1: 128, 2-5: 12, 6-10: 5, >10: 5}.
- per-type BM25 recall@10: user 1.000, assistant 1.000, **preference 0.8333** (5 misses — all
  preference).

So the task IS largely "find the on-topic session," and a naive lexical baseline already nails it for
user/assistant questions. Is that an unfair cue or legitimate easy retrieval? Judgment: **legitimate.**
The gold session is not identified by a copied distinctive phrase; raw token overlap barely separates
gold from the best non-gold (mean overlap 12.59 vs 12.08; gold strictly higher in only 73/150). What
carries BM25 is IDF-weighted rare content terms that genuinely occur in the on-topic session
("commute", "creamer", "graduate"). These are natural human point-lookup questions over one user's
chat history where exactly one session is on-topic — a real, if easy, retrieval task, exactly the I1
"local" intent doc 42 set out to measure. Not a leak.

The interesting structure is the 5 BM25 misses — ALL single-session-preference, and all INFERENTIAL
rather than topical. The question shares no distinctive content with gold; the link requires reasoning
about relevant prior context. Examples:
- "I've been having trouble with the battery life on my phone lately. Any tips?" -> gold session is
  about buying a "portable power bank and wireless charging pad" (BM25 rank 26).
- "What should I serve for dinner this weekend with my homegrown ingredients?" -> gold session about
  harvesting "cherry tomatoes from my garden" (BM25 rank 20).
- "rearranging the furniture in my bedroom" -> gold about "a new bedroom dresser to replace" (rank 11).

These 5 are the ONLY questions where DENSE must out-perform BM25 to reach the headline 1.000. That
makes the 1.000 claim hinge entirely on dense recovering exactly these inferential preference cases —
the natural place for an adversary to be skeptical. Step 4 tests it directly.

**VERDICT: PASS (legitimate easy retrieval, NOT a leak).** The task is genuine on-topic single-session
lookup; dense is not merely lexical overlap (the turn-vs-session gap in step-4/harness confirms).
But recall@10 is EASY and CEILINGED — the honest read is "task is easy," which the authors state.

## Step 4 — INDEPENDENT DENSE REPRODUCTION (fresh embeds via ml :8000, from SOURCE)

nomic via Ollama ran ~2s/embed here (bge-m3 is the resident model; nomic appears cold/CPU), so
throughput was ~11/s at concurrency 24 (well below the prereg's ~27/s assumption). I embedded FRESH
from SOURCE into my OWN caches (not the harness's `i1-vecs.bin`), replicating the frozen convention
exactly: 256/64 sliding-window chunks, `search_document: ` on chunks + `search_query: ` on the
question, L2-normalise, cosine via dot, turn = MAX over chunks, session = MAX over turns, rank desc /
index-asc. Two runs:

**(a) Seeded random 8-question sample** [seed 20260908 shuffle -> first 8: 3 preference, 3 assistant,
2 user; 21,003 fresh embeds; 0 wrong-dim vectors]:
- **DENSE recall@10 = 1.0000, recall@5 = 1.0000, rank1 = 7/8 (87.5%)**, gold rank buckets {1: 7, 2-5: 1}.
- **0/8 questions had any exact session-score tie** — independently confirms dense scores are
  continuous, so the harness's `tiebreak sensitivity = 0.0000` is a genuine no-ties fact, not a bug.
- per-type recall@10 all 1.000. rank1 87.5% is consistent with the harness's 124/150 = 82.7%.

**(b) The DECISIVE 5 BM25-miss preference questions** [the only cases where DENSE must beat BM25 for
the 1.000 headline; 13,228 fresh embeds; 0 wrong-dim]:

| qid | DENSE gold rank | BM25 was |
|-----|-----------------|----------|
| 06f04340 (dinner/homegrown) | **4** | miss (20) |
| 1a1907b4 (cocktail) | **1** | miss (15) |
| 09d032c9 (phone battery/power bank) | **9** | miss (26) |
| 57f827a0 (furniture/dresser) | **7** | miss (11) |
| d6233ab6 (nostalgia/reunion) | **9** | miss (15) |

**DENSE recovered 5/5 of the BM25 misses into the top-10.** This is the crux: the headline
recall@10 = 1.000 hinges entirely on dense recovering exactly these inferential preference cases, and
it does — genuinely, via semantic proximity ("phone battery" ~ "portable power bank / wireless
charging"), not lexical overlap (BM25 put them at ranks 11-26).

Across both runs, **13/13 independently-embedded questions place gold in the top-10**, matching the
harness's recall@10 = 1.000 and rank1 ~83%. The reproduction MATCHES.

**VERDICT: MATCHES — the 1.000 is independently reproduced from source.** Dense genuinely near-solves
I1 single-session recall, including the inferential preference cases that lexical retrieval misses.

## Step 5 — FRAMING VERDICT

- **(a) GENUINE ceiling, not an artifact.** No positional bias (step 1, gold mean-frac 0.562),
  sound oracle (step 2, 0 unresolved / 0 evidence-free), independent BM25 already at 0.967 (step 3),
  and independent dense reproduces 13/13 in top-10 incl. 5/5 hard-miss recovery (step 4). The task is
  genuinely easy: natural point-lookup over one user's chat history where ~one session is on-topic.
- **(b) "H1 on recall@10 is uninformative because ceilinged" is CORRECT.** With DENSE pinned at the
  1.000 ceiling, DENSE+BM25 can only tie or lose; it lost 2 preference cases (dense-only=2,
  fused-only=0) -> delta -2/150 = -0.0133, CI[-0.033, 0.000]. The metric has no headroom to show a
  lexical lift, so the null is STRUCTURAL, not a power result. The authors state this plainly ("not a
  clean null") — exactly right, and it avoids the HARKing trap of banking "lexical doesn't help on
  real queries." All the H1 arithmetic (delta, McNemar, per-type -0.0667 = -2/30 on preference) is
  internally consistent with my independently-verified BM25 + the reported dense.
- **(c) Neither materially over- nor under-claims; discipline held in BOTH directions.** They banked
  the null honestly and did not fish. The one framing nudge before banking: recall@10 = 1.000 measures
  that this TASK is easy, NOT that the system's retrieval is "solved." The discriminating floor lives
  in the metrics with headroom — recall@5 0.947, nDCG@10 0.914, and especially **turn-level DENSE
  recall@10 = 0.867** (finer granularity, 493 candidates). Lead with those; treat recall@10 = 1.000 as
  "ceilinged, uninformative for H1." (The turn-vs-session gap, 0.867 vs 1.000, is itself strong
  anti-leak evidence: a trivial verbatim leak would pin BOTH at ~1.0; instead dense picks the right
  session by MAX-agg even when it can't pin the exact turn — real coarse semantic retrieval.) Also keep
  the existing SCOPE HONESTY caveat prominent: this is session retrieval on an easy single-session cut;
  it does NOT exercise the R4 entity+fact fusion lever (Path A) and does not generalise to I2/I3.
- **(d) "fusion helps head, hurts tail" is SUPPORTED and correctly stated.** Fused rank1 129 vs dense
  124 (RRF promoted 5 golds to rank1 by blending the strong lexical leg on the easy majority), while
  demoting 2 preference golds out of the top-10 where BM25 was very wrong (ranks 11-26) — net
  recall@10 148/150 < 150/150. Coherent tradeoff. (Reproduced at the mechanism + arithmetic level from
  my verified BM25 and the reported dense; I did not re-embed all 150 to reproduce the full fused
  ranking, but every number is internally consistent and the mechanism is sound.)

No launder detected in either direction.

---

## OVERALL VERDICT: **VALID-AS-FRAMED.**

Single most important reason: the suspiciously-clean recall@10 = 1.000 is a GENUINE, independently
reproduced task ceiling — an independent from-source BM25 already reaches 0.967, and fresh independent
dense embedding places gold in the top-10 on 13/13 audited questions, INCLUDING 5/5 of the exact
inferential-preference cases that lexical retrieval misses (dense ranks 1/4/7/9/9). No positional
artifact, no oracle bug, no leak, no tie-break inflation. The authors correctly read recall@10 as
ceilinged and therefore the H1 lexical-lift test on it as uninformative rather than a demonstrated
null. The only correction to make before banking is a framing emphasis, not a numbers fix: present
recall@5 / nDCG@10 / turn-level recall (which have headroom) as the discriminating floor, and do not
let "dense near-solves I1" read as "retrieval is solved" beyond this easy single-session session-
retrieval cut.
