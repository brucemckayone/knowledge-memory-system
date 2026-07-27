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

## 8. RESULT

*(added after the run + blind adversary)*
