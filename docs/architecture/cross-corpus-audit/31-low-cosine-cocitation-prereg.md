# Doc 31 — Does the concept signal find co-cited pairs that embedding CANNOT (the text-dissimilar zone)? (pre-registration)

**Bead:** new (nmemo, low-cosine-cocite) · **Status:** PRE-REGISTRATION — frozen before any score
**Date:** 2026-07-27 · **Discipline:** [[verify-empirical-gates]] (27th run). Committed to git BEFORE scoring.
Autonomous `/goal`. Follow-up to doc-30 (the "text-orthogonal" slice the doc-30 adversary named).

---

## 0. Why
doc-30: dense embedding out-ranks concept-JOIN on co-citation relatedness — but the co-citation oracle is itself
~79% cosine-predictable (AUC 0.79), so embedding wins partly because the oracle rewards text similarity, which
embedding measures. The clean isolation of "does the concept signal capture RELATEDNESS-BEYOND-TEXT-SIMILARITY"
is the subset of co-cited pairs that are **textually DISSIMILAR** — co-cited (related in the literature) yet low
embedding cosine. There, embedding's mechanical edge is removed by construction. This gate asks: **in the
text-dissimilar zone, does the concept signal (mechanical JOIN or the agent) find the co-cited pairs better than
embedding — and does adding it to embedding improve overall recall?**

**Launder warning (this doc's specific risk):** the band is embedding's BLIND SPOT by construction, so a concept
"win" here is NOT a general retrieval win — it must be scoped strictly to "complementary in the text-dissimilar
zone," and guarded by (i) a RANDOM baseline (a win must beat random, else it's just non-embedding noise) and (ii)
the COVERAGE CEILING (if concept-JOIN is also blind to most band pairs, any win is a thin slice). This is the
mirror of doc-30's embedding-favoring oracle; do not rig it the other way.

## 1. Claims
- **(H1 isolation):** among low-cosine candidates, concept-JOIN ranks co-cited pairs better than embedding
  (residual within-band cosine) AND better than random.
- **(H2 payoff):** a hybrid (embedding + concept-JOIN's band finds) recovers co-cited pairs on the FULL oracle
  that embedding-alone misses → hybrid recall@10 > embedding-alone recall@10.
- **(agent):** the frozen doc-29 agent rankings (STRUCT, free-nav) recover low-cosine co-cited targets better
  than embedding.

## 2. Data + oracle (frozen; 0 new LLM calls — re-score of doc-29/30 artifacts)
Reuse corpus-A/B, cc-seeded.json (concept nodes), cc-docemb.json (embeddings), cc-cociters.json (co-citation).
Co-cited: |citers(a)∩citers(b)| ≥ **K=1** (doc-30). Text-dissimilar threshold **τ = 0.615** (doc-30's random-pair
mean cosine — "below-average text similarity", principled, frozen). Report sensitivity at τ ∈ {0.60, 0.65}.

## 3. Design (A→B; B→A owed)
- **Candidate universe per query a** = B-docs with cosine(a,b) < τ (embedding's low-signal zone).
- **Positives** = candidates that are co-cited (the hard, text-dissimilar-but-related targets).
- **Query set** = A-queries with ≥3 low-cosine co-cited B (recall measurable); report N.
- **COVERAGE CEILING (report first):** fraction of low-cosine co-cited pairs sharing ≥1 concept node = the max
  recall concept-JOIN could achieve. If ~0, concept-JOIN is structurally blind here too (honest ceiling).
- **Arms (rank the low-cosine candidate universe):** concept-JOIN (IDF overlap), embedding (within-band cosine),
  RANDOM (seeded). Metric: precision@5, recall@10, MRR of co-cited; paired-bootstrap CIs (JOIN−EMB, JOIN−RANDOM).
- **Hybrid payoff (H2):** on the FULL corpus + FULL co-citation oracle, compare embedding-alone recall@10 vs a
  hybrid that appends concept-JOIN's top low-cosine finds to embedding's ranking; does hybrid recover misses?
- **Agent:** restrict positives to low-cosine co-cited; report recall of these by STRUCT / free-nav vs embedding.

## 4. Bars (FROZEN before scoring)
- **H1:** concept-JOIN − embedding on precision@5 in the band, paired-bootstrap CI excludes 0 (positive), AND
  concept-JOIN − RANDOM CI excludes 0 (real signal, not noise). Both required.
- **H2:** hybrid recall@10 − embedding-alone recall@10 > 0, CI excludes 0 (concept adds complementary recall).
- Report the coverage ceiling alongside; a win on a <20%-ceiling slice is scoped as "thin/complementary," not a
  retrieval verdict.
- Outcome naming: H1+H2 hold → **the concept layer adds genuine complementary recall where embedding is blind**
  (first affirmative signal for the thesis, scoped to the text-dissimilar zone). H1 holds but coverage tiny →
  real-but-marginal. H1 fails (JOIN ≈ embedding ≈ random in the band) → **the concept layer is blind in
  embedding's blind spot too** → embedding-alone suffices; the thesis is done for this extraction.

## 5. Anti-launder
- Bars + τ + K frozen before any score; RANDOM baseline + coverage ceiling are mandatory guards against a
  favorable-oracle win; the band is embedding's blind spot BY CONSTRUCTION so no general-retrieval claim is
  permitted from it. Re-score of frozen rankings (no refit, 0 LLM). Report both τ-sensitivities. Blind adversary
  before any claim — specifically to check I did not rig the oracle toward the concept layer (the doc-30 mirror).
  Report both directions.

## 6. Adversary protocol
Reproduce the band oracle, coverage ceiling, all arm scores + CIs. Check: is τ=0.615 a fair "text-dissimilar"
cut or gerrymandered? Is any JOIN "win" above RANDOM (real signal) or just embedding-is-disabled-here? Is the
coverage ceiling honestly reported (is the win on a tiny slice)? Does H2's hybrid gain survive, or is it n-fragile?
Rule whether the concept layer genuinely complements embedding in the text-dissimilar zone, or is blind there too.

## 7. Disposition
Names the outcome per §4. This is the last clean shot at "concept/agent beats dense where text similarity can't."
Does NOT settle: human-relevance gold, denser extraction, capable-model agent, generality.

---

## 8. RESULT (2026-07-27) — the concept layer is BLIND in embedding's blind spot too; retrieval thesis closed FOR THIS EXTRACTION

Re-scored the frozen doc-29/30 rankings on the text-dissimilar (cos<τ) co-citation slice. Blind adversary (Opus)
reproduced **every number bit-exact** and — for the first time this arc — found the stated strength correctly
calibrated (neither over- nor under-stated).

**Coverage ceiling (deterministic, load-bearing):** of 160 text-dissimilar (cos<0.615) co-cited pairs, only
**7 share ≥1 extracted concept node = 4.4%** (1.8% at τ=0.60, 7.5% at τ=0.65; <8% at every cut). The concept
layer is **~95% blind** in embedding's blind spot.

**H1 (concept beats embedding/random in the band): FAIL.** precision@5 JOIN 0.165 vs EMB 0.118 vs RANDOM 0.118,
n=17, both CIs straddle 0. EMB = RANDOM in the band (and EMB MRR 0.257 < random 0.290) — embedding is genuinely
disabled here, as designed. **The adversary killed the point-estimate "edge":** only 3 of JOIN's 14 top-5 true
positives are concept-driven (joinScore>0); 11 are 0-score tie-order artifacts (a low-B-index popularity prior).
So the apparent lift *flatters* concept and isn't real signal — "no signal" is conservative-toward-concept.

**H2 (hybrid helps overall): FAIL.** RRF(emb,join) recall@10 0.374 vs embedding-alone 0.410 (CI [−0.079,+0.011],
leans negative) — the sparse concept signal *dilutes* rather than complements (doc-22 redux).

**Agent: recovers ZERO** of 92 low-cosine co-cited targets (STRUCT + free-nav both), verified not a parse bug.

**Blind, not wrong-where-covered.** The 7 covered pairs are GENUINE cross-domain links on real shared
abstractions (PaLM-E ↔ Faster-SAM via `transfer-learning`; RT-2 ↔ Customized-SAM-medical via
`end-to-end-training`; Annotated-Point-Clouds ↔ Faster-SAM via `zero-shot-learning`, 8 co-citers; Kosmos ↔
SAM-Medical via `cross-modality-generalization`). The mechanism is SOUND; it just fires on 4.4% of the slice.

**"Lever = extraction density" is grounded but untested.** Extraction is thin: mean ~6 concepts/doc, capped at
10, **18% of docs (27/147) got ZERO concepts**, from a 521-term vocab. Of the 160 band misses, 33% involve a
zero-concept doc (density would directly attack these) but **62.5% are populated-but-disjoint** — denser
extraction *might* surface a shared abstraction there, but this is unproven. So density is a real, grounded
lever, correctly labeled untested; the disjoint-majority means it is **not guaranteed** to make the concept
signal competitive.

τ=0.615 is fair (= the A–B all-pairs cosine mean 0.617 / median 0.613); the story holds across 0.60/0.65.
Integrity clean (no refit, seeded random baseline, agent-0 is real); one caveat (0-score tie-order popularity
prior flatters JOIN but doesn't change the verdict — a cleaner harness would randomize ties).

### OVERALL — the settled close across doc-28 → 31
- **CAN claim:** for cross-corpus RETRIEVAL, the concept layer as currently extracted (~6 sparse nodes/doc) does
  not beat, match, or complement dense embedding — anywhere, **including embedding's own text-dissimilar blind
  spot** (4.4% coverage; H1/H2 fail; RRF hurts; agent recovers 0). The failure is **blindness from extraction
  sparsity**, not a wrong mechanism (the 7 covered links are genuine). Embedding is the retrieval engine.
- **CANNOT claim:** that denser extraction WOULD make it competitive (62.5% disjoint-concept misses, untested);
  anything about human-relevance gold, capable-model agents, or generality.
- **The only surviving untested retrieval lever is extraction density.** The concept layer's demonstrated value
  remains NON-retrieval: structural audit / navigation / rare-bridge discovery / explanation (the five-agent
  exploration), which was genuinely graph-powered.

### Discipline note
First correctly-calibrated conclusion of the arc (iters 24/25/26 were all both-directions strength-
miscalibrations; the adversary said this one matches the evidence). The load-bearing claim here is a
deterministic coverage ceiling (4.4%), not an interpretation — which is why it held. See
[[verify-empirical-gates]] iter-27.
