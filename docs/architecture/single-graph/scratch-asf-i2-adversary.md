# Blind-adversary audit — I2 multi-session retrieval (doc 43)

Audited from SOURCE (`longmemeval_s_cleaned.json`), not the harness result JSON. Vectors read from
the shared cache `i1-vecs.bin`/`i1-keys.jsonl`; `splitUnits`, BM25, `rankByScore`, RRF-60,
`recall_all`, and the `mulberry32` clustered bootstrap were re-implemented from scratch in python
(`scratchpad/repro_i2.py`, `repro_i2b.py`, `classify.py`). Supporting artifacts:
`repro_i2_misses.json`, `repro_i2_miss_detail.txt` (this directory).

---

## Step 1 — recall_ALL recomputation from source

Independent parse of the 121 multi-session (non-`_abs`) questions, scored against cache vectors:

| arm | recall_all@10 | recall_all@5 | recall_any@10 | frac_gold@10 | nDCG@10 |
|---|---|---|---|---|---|
| DENSE-FLAT | **0.9504** | 0.8347 | 1.0000 | 0.9780 | 0.9381 |
| BM25-FLAT | 0.7851 | 0.5950 | 0.9917 | 0.9062 | 0.8388 |
| DENSE+BM25 | 0.9091 | 0.7686 | 0.9917 | 0.9613 | 0.9206 |

Per-stratum DENSE recall_all@10: 2 -> 0.9733, 3 -> 0.9583, 4-5 -> 0.8636.
DENSE CI (my ported mulberry32, seed 20260909, 10k resamples) = **[0.9091, 0.9835]**.
H1 = DENSE+BM25 - DENSE-FLAT = **-0.0413, CI [-0.0909, 0.0083], SPANS 0** (directionally negative).
McNemar fused-only = 2, dense-only = 7. Per-stratum H1 delta: 2 -0.0133 / 3 -0.0417 / 4-5 -0.1364.
Tie-break |asc-desc| on DENSE recall_all@10 = **0.0000** (no fragility).

Every one of these numbers matches the pre-registration headline and the harness result JSON
(`2026-09-09-i2-multihop.json`) to the full printed precision, including the seed-specific bootstrap
CIs. The `recall_ALL` logic is correct: 1 iff EVERY gold index is in top-k (verified in code and
against the per-question detail). recall_any@10 = 1.0000 and frac_gold@10 = 0.9780 confirm the metric
is the ALL-conjunction, not any.

**VERDICT: REPRODUCED bit-for-bit. The 0.9504 headline, the BM25 0.7851 floor, the 0.9091 fusion,
the negative H1, and the per-stratum 4-5 drop to 0.8636 are all faithful to source.**

## Step 2 — oracle (multi-gold)

- Unresolved gold ids: **0** (every `answer_session_ids` entry resolves in its own haystack).
- Questions with < 2 gold: **0** (all 121 are genuinely multi-evidence; distribution 2:75 / 3:24 /
  4:16 / 5:6, mean 2.61, 316 gold sessions — matches prereg exactly).
- Gold sessions with no `has_answer` turn: **11 across 10 questions** — matches the prereg count
  exactly. The harness builds gold by SESSION-ID membership (`answer_session_ids.includes(session_id)`,
  harness line 208; my repro identical), NOT by `has_answer`, so those 10 questions are not spuriously
  failed. Confirmed: `has_answer` is turn-level diagnostic only.
- Off-by-one / duplicate check: 3 haystacks carry a duplicated session_id (`d23cf73b`, `91b15a6e`,
  `078150f1`), but in all 3 the duplicated id is a NON-gold distractor, so the gold set is never
  inflated and no recall_all is spuriously broken by a duplicate.
- Minor benchmark-quality note (not a harness fault): at least one gold session is only weakly
  on-topic — `00ca467f` idx 12 (a "March appointments" question) is a gold session that mentions an
  April 1st appointment and has no `has_answer` turn. Some of the "headroom" is missed marginal gold.

**VERDICT: ORACLE CLEAN. 0 unresolved, all >=2 gold, 11-across-10 no-`has_answer` count confirmed,
session-id gating confirmed, duplicates are non-gold.**

## Step 2b — cache independence + missing-chunk robustness

- **Independence:** 30 already-cached keys (doc chunks + query keys) fresh-embedded via the ml service
  (nomic-embed-text, L2-normalised) vs their cache vectors: cos **min = mean = max = 1.00000**. The
  cache vectors are genuine nomic embeddings, not fabricated.
- **Coverage gap found:** 589 of my 299,778 needed chunk keys were absent from the cache (536 are full
  256-char chunks; 121 touch a gold session). Root cause: JS `String.slice` chunks by UTF-16 code
  units, python by code points, so turns containing non-BMP characters (emoji) chunk differently — my
  python keys do not byte-match the harness keys for those turns.
- **Robustness:** I fresh-embedded all 589 and re-scored with COMPLETE coverage. DENSE recall_all@10 =
  **0.9504** unchanged (@5 = 0.8347, per-stratum identical). The discrepancy is immaterial: a session's
  dense score is a MAX over many chunks, and the shifted/dropped chunks were never the deciding max for
  a top-10 membership.

**VERDICT: cache is genuine (cos 1.0) and the result survives complete coverage. The UTF-16/codepoint
chunking difference is a harness-internal detail with ZERO effect on the finding.**

## Step 3 — is the BM25-negative real or a harness artifact?

BM25-FLAT reproduced at **0.7851** from an independent from-scratch python BM25 (matches). The fusion
loss is real and mechanistic, not a bug. My scoring independently found the 7 dense-only McNemar
discordants (dense recall_all@10 = 1, fused = 0). In every one, dense had ALL gold at ranks 1-8 and RRF
demoted at least one gold past rank 10:

| qid | question | gold DENSE ranks | gold FUSED ranks |
|---|---|---|---|
| f2262a51 | how many different doctors | 5,4,3 | **18,15,14** (all three demoted) |
| 2f8be40d | how many weddings this year | 3,1,5 | 4,1,**11** |
| 15e38248 | how many furniture items | 2,1,3,8 | 3,1,9,**19** |
| 194be4b3 | how many musical instruments | 7,1,2,4,5 | **15**,1,2,5,**11** |
| 81507db6 | how many graduation ceremonies | 7,1,2,4,3 | **15**,4,1,3,2 |
| a1cc6108 | how old when Alex was born | 4,3 | 1,**14** |
| c18a7dc8 | how many years older than at graduation | 3,1 | **14**,1 |

Mechanism: these are "how many X" counting questions where many distractor sessions share the generic
head token (doctor / wedding / furniture / instrument), so BM25 assigns them high scores and ranks
non-gold sessions ahead; RRF-60 then averages dense's clean rank-3 hit with BM25's noisy rank and
demotes it below 10. `recall_ALL` amplifies this: demoting ANY one of 3-5 gold flips the whole
question to 0, which is exactly why the loss concentrates in the 4-5 stratum (delta -0.1364).

**VERDICT: the BM25-negative is a GENUINE property of RRF with a weaker, noisier lexical leg (not a
fusion bug). Fusion loses 7 clean dense wins and gains 2 -> net -0.0413.**

## Step 4 — characterization of the dense misses (the decision-relevant deliverable)

6 questions have DENSE recall_all@10 = 0 (8 missed gold sessions total). For each missed session:
dense rank, BM25 rank, and question-content-token overlap with the session (`repro_i2_miss_detail.txt`).

| qid | question | missed sid | dense rank | BM25 rank | q-token overlap | class |
|---|---|---|---|---|---|---|
| ba358f49 | years old when Rachel marries | idx28 | 22 | 9 | 1/6 (only "will") | **(a) HARD HOP** — "I'm 32" buried in a SKINCARE session, zero topical overlap with "Rachel married" |
| 1a8a66a6 | how many magazine subscriptions | idx11 | 24 | 9 | 1/4 | **(a) HARD HOP** — "National Geographic issue" buried in an eco-plastics session (NatGeo->magazine inference) |
| 88432d0a | how many times did I bake | idx39 | 25 | 7 | ~1/7 (bake != baked) | **(a) HARD HOP** — "baked a chocolate cake" aside in a dinner-party session |
| dd2973ad | bedtime day before doctor appt | idx44 | 11 | 16 | 6/10 | **(c) NEAR-MISS** — evidence present, rank 11 |
| 00ca467f | doctor appts in March | idx1, idx12 | 11, 12 | 2, 7 | 3/6, 3/6 | **(c) NEAR-MISS** — both rank 11-12, BM25 top-10 |
| 6d550036 | how many projects led | idx6, idx16 | 14, 22 | 2, 13 | 4/6, 3/6 | **(b)/mixed** — idx6 is lexically strong (BM25 rank 2) but dense buried it; idx16 is a "case competition = project" inference |

Counts (per question, by the hardest miss): **HARD HOP (a) = 3** (ba358f49, 1a8a66a6, 88432d0a);
**NEAR-MISS (c) = 2** (dd2973ad, 00ca467f); **mixed/dense-ranking-failure (b) = 1** (6d550036).
By missed SESSION (8): hard-hop 3, near-miss 3, dense-buried-lexically-strong/categorical 2.

Two adversarial observations that bear on the decision:
1. **"Lexical cannot close the hard hops" is overstated.** BM25 surfaced these buried mentions at
   ranks 2, 7, 9, 9, 13 — i.e. lexical DOES leak into the off-topic sessions via one shared token and
   would place most of them in or near top-10. The problem is not that lexical misses them; it is that
   fusion nets negative (step 3).
2. **The 3 genuine hard hops are counting/aggregation questions whose missing evidence is a buried,
   off-topic, category- or attribute-inference side-mention.** The "bridge" is either the user-self
   (ba358f49 age; every session is about the user, so a self-entity traversal is non-discriminative)
   or a type inference (NatGeo -> magazine; chocolate cake -> baking). Category-concept retrieval is
   the exact mechanism this project already found FAILS for retrieval (docs 28-32). What actually
   closes them is structured EXTRACTION of the buried fact/event plus aggregation, not an entity-bridge
   traversal from a dense seed.

**VERDICT: ~3/6 misses are genuine off-topic hard hops (existence confirmed — ba358f49 is a clean
zero-topical-overlap compositional hop); ~2/6 are rank-11/12 threshold near-misses a k bump erases;
1/6 is a plain dense ranking failure on a lexically strong session. The hard hops are
counting/aggregation + category/attribute inference, NOT entity-bridge traversals.**

## Step 5 — framing verdict

(a) **"dense strong but not ceilinged, headroom in 4-5":** mostly right but soft-pedals the ceiling.
At the per-session level dense is essentially ceilinged (recall_any@10 = 1.0000, frac_gold@10 =
0.9780; the DENSE CI upper bound 0.9835 nearly touches the 0.98 saturation gate). The recall_ALL
"headroom" is 6 questions, and ~half of it is rank-11/12 near-misses. The 4-5 concentration is partly
a mechanical artifact of the ALL-conjunction over more items competing for 10 slots: an independent
per-session recall of 0.978 predicts ~0.92-0.90 at 4-5 vs observed 0.864 — so there is SOME genuine
extra hardness in 4-5, but a large part of the "headroom" is conjunction/slot mechanics, not hop
difficulty. Honest framing: per-session ceilinged; the gap is a thin recall_ALL tail.

(b) **BM25-negative "clean negative, not ceiling-confounded":** CORRECT and well-supported. Dense was
not at 1.0, so the negative is not a ceiling artifact; the 7 discordants show fusion actively demoting
clean dense hits (ranks 3-8 -> 14-19). This is the strongest, cleanest claim in the write-up.

(c) **"residual is genuine hard hops that traversal (Path A) might close":** OVER-CLAIMED / a launder
toward building Path A. It is true that hard hops EXIST (~3), but (i) they are counting/aggregation
over buried category/attribute mentions, whose bridge is either the non-discriminative self entity or
a concept-type inference that already failed for retrieval here (docs 28-32); (ii) lexical does
surface most of them (ranks 2-13), contradicting "lexical cannot close"; (iii) ~half the residual is
near-misses, not hops at all. The mechanism these need is buried-fact EXTRACTION + aggregation, which
is a different capability than the entity-graph TRAVERSAL Path A is framed around.

---

## OVERALL VERDICT: VALID-BUT-MISFRAMED

Single most important reason: the numbers are real, robust, and faithfully computed from source
(0.9504 reproduced bit-for-bit including the seed-specific CIs, cache proven genuine at cos 1.0, result
unchanged under complete chunk coverage, oracle clean, BM25-negative a genuine RRF property) — but the
decision-driving interpretation, that the residual dense misses motivate an entity-graph TRAVERSAL
(Path A), is not supported by the miss structure: the genuine hard hops are counting/aggregation over
buried category/attribute side-mentions that a self-entity or concept-type bridge does not
discriminatively close (concept-type retrieval already failed in docs 28-32), and BM25 already surfaces
most of them, so "lexical cannot close them, traversal might" reads as a motivated conclusion.

**Is the residual headroom traversal-addressable (is Path A worth it)?** Mostly NO: only ~3/6 misses
are genuine hard hops, and those are counting/aggregation questions closable by buried-fact EXTRACTION
plus aggregation (BM25 already ranks the buried mentions 2-13), not by entity-bridge traversal (the
only shared entity is the user-self = non-discriminative, and category-concept retrieval already lost
in docs 28-32); the other ~3 are rank-11/12 threshold near-misses. The honest next step is denser
extraction of buried facts, not a traversal graph.
