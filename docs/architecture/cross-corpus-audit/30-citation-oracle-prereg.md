# Doc 30 — Does the concept signal predict CITATION-relatedness better than embedding? (pre-registration)

**Bead:** new (nmemo, citation-oracle) · **Status:** PRE-REGISTRATION — frozen before any score
**Date:** 2026-07-27 · **Discipline:** [[verify-empirical-gates]] (26th run). Committed to git BEFORE scoring.
Autonomous `/goal`. Follow-up to doc-29 (the settling experiment the doc-29 adversary named).

---

## 0. Why (the oracle doc-29 lacked)

doc-28/29 scored cross-corpus retrieval against an OpenAlex **topical-concept** oracle. The doc-29 adversary
showed that oracle is **self-aligned with embedding** — doc-embedding cosine and a coarse shared-topic oracle are
both surface-topical-similarity functions, so "embedding beats concept-JOIN/agent" was graded against embedding's
own inductive bias (circular), and on agent/oracle disagreements the agent was often right. **The retrieval
question is therefore OPEN.** To settle it we need a relatedness oracle NOT built from surface similarity.
**Citations** are that: two papers linked by citation / shared references are related by *intellectual
dependence*, which is orthogonal to how similar their abstracts read. This gate asks the clean question:
**does the concept-graph signal predict citation-relatedness across corpora better than dense embedding?**

## 1. Claims under test
- **(primary, mechanical, no LLM):** on a citation oracle, does mechanical **concept-JOIN** (IDF shared-node
  overlap) predict cross-corpus relatedness **≥ embedding** (dense cosine)? Because the oracle is now
  embedding-independent, whoever wins wins honestly — a JOIN win settles doc-29 in the concept layer's favor; an
  embedding win settles it against; a tie = no difference.
- **(secondary, agent):** do the frozen doc-29 agent rankings (STRUCT graph-reasoning, free-nav) predict
  citation-relatedness better than embedding? Tests whether the agent's *categorical* judgment aligns with real
  intellectual relatedness better than surface similarity does.

## 2. Citation oracle (frozen; fetched + calibrated BEFORE any score)

**AMENDMENT (2026-07-27, before any score):** the pre-registered `referenced_works` (outgoing) is **empty for
these arXiv preprints** — only 4/294 have any references (OpenAlex doesn't parse preprint reference lists). So
bibliographic coupling and direct-outgoing citation are not computable. **Incoming citations (`cited_by`) ARE
rich** (BLIP-2 920, LLaVA 687, …). The oracle is therefore built from **co-citation**, a standard
embedding-independent relatedness signal: two papers are related if the later literature *cites them together*.
This is a data-availability method change made BEFORE scoring (documented, not post-hoc goalpost-moving).

Fetch, per paper P, the set of works citing P (`filter=cites:P`, capped at the first `C` citers — cap disclosed).
A cross-pair (a∈NLP, b∈CV) is **CO-CITED** if |citers(a) ∩ citers(b)| ≥ k (a common later paper cites both).
**k calibrated on the oracle distribution alone** (smallest k giving a median ≥2 co-related B per A-query and
≥50% of queries with ≥1; if too sparse at k=1, report that as the finding). Report base rate + cross-corpus
co-citation density + **overlap with the doc-28 topical oracle** (Jaccard on related-pair sets; if citations are
just the topical oracle again, the test is void — required check) + evidence that co-cited pairs are often
textually dissimilar (the embedding-independence check).

## 3. Arms (RE-SCORE frozen rankings — 0 new LLM calls)
The rankings are oracle-independent (each arm ranks by its own criterion); only scoring changes. Re-score the
existing doc-29 rankings against the citation oracle:
- **Mechanical, FULL corpus (primary — no pool bias, no LLM):** concept-JOIN-full vs embedding-full rank all 147
  B per A-query; score vs citation oracle. This is the cleanest settling test.
- **Agent, pool (secondary):** STRUCT / TEXT rankings from `cc-agent-cache.json` (pool = embedding+JOIN top-30 —
  note residual candidate bias; report citation-pool-recall = citation-related pairs that made it into the pool).
- **Agent, FULL corpus:** free-nav rankings from `cc-freenav-cache.json` (autonomous, no pool — the pool-bias-free
  agent check).
Metrics: precision@5, MRR, recall@10 (full-corpus arms) macro over the query set; paired-bootstrap CIs for
JOIN−EMB, STRUCT−EMB, freenav−EMB.

## 4. Bars (FROZEN before scoring)
On the citation oracle (embedding-independent):
- **Settling — concept signal:** JOIN-full − EMB-full on precision@5 (primary) with paired-bootstrap CI. CI>0 →
  the concept signal predicts real relatedness better than embedding (**answers the user's question YES at the
  mechanical level**). CI<0 → embedding genuinely better (**NO, honestly**). CI straddling 0 → no difference /
  still open.
- **Settling — agent:** STRUCT−EMB and freenav−EMB likewise (agent's categorical judgment vs dense).
- Report direct-only AND direct∪coupled; a result that holds on **direct-only** (the least topical) is the
  strongest.
- **Void check:** if the citation oracle's overlap with the doc-28 topical oracle is high (>~0.6 Jaccard on
  related-pair sets), the oracles aren't independent and the test cannot settle anything — report and stop.

## 5. Anti-launder controls
- Oracle fetched + k calibrated on the oracle distribution BEFORE any arm is scored; embedding never enters the
  oracle. Void-check that citations ≠ the topical oracle.
- **Re-score frozen rankings — no arm trained to the oracle, no new agent calls** (the agent judged "genuine
  relatedness," not "citations"; scoring its honest ranking against citations is fair, not fitted).
- Mechanical primary is FULL-corpus (no pool bias); pool arms report citation-pool-recall; free-nav is the
  full-corpus agent check.
- Report both direct-only and combined; both directions of outcome pre-named as YES/NO/open; paired-bootstrap CIs
  (a win needs CI excluding 0 — no laundering a tie, rule 30/50/58; and no manufacturing a negative via a biased
  oracle, rule 59 — the whole point of this doc).
- Blind adversary before any claim. Owed if positive: capable-model agent, human-expert oracle (gold, ≥2
  experts), 2nd corpus pairing.

## 6. Blind-adversary protocol
Fresh subagent: (1) reproduce the citation oracle from the fetched refs + all arm scores/CIs independently;
confirm match. (2) Verify the citation oracle is embedding-independent and NOT a re-skin of the topical oracle
(compute the overlap; inspect that citation-related pairs are often textually dissimilar). (3) Verify the
re-scored rankings are the frozen doc-29 ones (no re-run, no fitting). (4) Attack: is bibliographic coupling
sneaking topical similarity back in (does direct-only tell the same story)? Is cross-corpus citation so sparse
the numbers are anecdotal (report n)? (5) Rule whether the concept/agent signal genuinely predicts citation-
relatedness better than embedding, or not, or whether citations still can't adjudicate. Verdict even if it
retracts.

## 7. Disposition
Names the outcome per §4. This is the experiment that can actually settle whether the concept layer's
discrimination beats dense retrieval for REAL (citation-grounded) relatedness — the question doc-28/29 could not
answer against an embedding-aligned oracle. Does NOT settle: human-relevance gold (citations are a proxy),
capable-model agent, generality. Each its own follow-up.

---

## 8. RESULT (2026-07-27) — does NOT settle the deep question; oracle is embedding-CORRELATED, not independent; my read overclaimed 3 ways

Built the co-citation oracle (K=1 by the frozen rule; base rate 0.05), re-scored the frozen doc-29 rankings.
Blind adversary (Opus, fresh) reproduced **every number to the last decimal** (K-sweep, void Jaccard, cosine
gaps, all arm scores + CIs) and then corrected my interpretation in three places — two pessimistic, one optimistic.

| on co-citation oracle | concept-JOIN | embedding | STRUCT | TEXT | free-nav |
|---|---|---|---|---|---|
| precision@5 | 0.19 | 0.30 | 0.32 | 0.32 | 0.52 (n=18) |
| MRR | 0.36 | 0.60 | — | — | — |

### Correction 1 (my CENTRAL overclaim): the oracle is NOT embedding-independent
I called co-citation "largely embedding-independent" from a +0.072 mean-cosine gap. Wrong statistic. The
adversary: **cosine predicts co-citation at AUC 0.79, Cohen's d 1.17**; only 14.8% of co-cited pairs sit below
the random-mean cosine. So the oracle is **dominated by textually-similar pairs** and embedding (which ranks by
cosine) gets a large mechanical boost from it. It IS a genuine, behaviorally-derived oracle *distinct* from the
topical one (Jaccard 0.065, robust to K=2) — a real improvement — but it **de-circularizes doc-29 only
partially.** It can settle the narrow "does EMB rank co-citation better than JOIN," NOT the deep "surface
similarity vs real relatedness." **The settling experiment did not settle the deep question** — because even
co-citation is ~79% cosine-predictable.

### Correction 2 (my PESSIMISTIC overclaim): "concept layer genuinely loses, not an artifact" is overstated
Embedding does robustly out-rank concept-JOIN (p@5 0.30 vs 0.19; MRR 0.60 vs 0.36; CI [−0.157,−0.074], holds at
K=2). BUT JOIN's loss is **largely an extraction-sparsity artifact: 73.4% of co-cited pairs share ZERO concept
nodes** (median ~7 nodes/doc), so JOIN is structurally blind to them; and where overlap exists, joinScore is
barely above chance (AUC 0.54 vs cosine 0.77). **Earned claim: dense embedding beats the concept layer AS
CURRENTLY EXTRACTED (~6 sparse nodes/doc). NOT earned: the concept signal intrinsically loses** — a denser /
description-aligned extraction is untested (and is exactly the [[project-concept-layer]] EMBED_DESCRIPTIONS lever).

### Correction 3 (my mild OPTIMISTIC oversell): free-nav "parity" is NOISE
n=18, CI [−0.078,+0.167] straddles 0; **embedding actually wins more queries (7 vs 5, 6 ties)**; the +0.033
"lead" rides 2–3 high-variance queries; and the 18 free-nav queries are the **easiest-for-embedding subset** (EMB
p@5 0.489 there vs 0.302 full-corpus). "Not a win, underpowered" was right; "reaches parity" oversold noise on
EMB's home turf. **No defensible signal the autonomous agent matches embedding.**

### Integrity (adversary)
Rankings frozen, no refit; oracle built before scoring (prereg+amendment committed before result). Flags: I
**failed to report the pre-reg-required citation-pool-recall** = **0.648** (STRUCT/TEXT recall-capped at ~65% by
the pool) — omission, now recorded. STRUCT==TEXT 0.3211 is coincidence (61/190 hits each; 32/40 rankings differ),
not a bug. 200-citer cap saturates 19/294 popular papers (undercounts some co-citations; noise, not bias).

### OVERALL — what doc-30 does and does not establish
- **CAN claim:** on a behaviorally-derived (non-text-*derived*) co-citation oracle, dense embedding decisively
  and robustly out-ranks the concept-JOIN signal **as currently extracted**; the concept signal carries
  real-but-weak information (AUC 0.60); numbers reproduce; H-B (graph representation ≈ reading) replicates.
- **CANNOT claim:** that the oracle is embedding-independent or that doc-30 "settles" the doc-29 circularity
  (cosine AUC 0.79); that the concept signal is *intrinsically* weaker than embedding (73% sparsity confound —
  denser extraction untested); that the agent-over-graph matches/beats dense retrieval (noise).
- **The deep question is still OPEN and needs a text-orthogonal oracle** — human relevance judgment, or
  co-citation *restricted to textually-dissimilar pairs* (co-cited but low-cosine), where embedding's mechanical
  edge is removed. The actionable lever for the concept layer is **extraction density** (the untested denser /
  description-aligned extraction), not the retrieval mechanism.

### Discipline note
Third consecutive both-directions miscalibration this arc (iters 24/25/26): I landed conclusions at the wrong
STRENGTH — over-claimed oracle independence (mean-gap not AUC), over-claimed a pessimistic "settled loss"
(ignored the 73% sparsity confound), and mildly over-claimed an optimistic "parity" (n=18 noise). The
quantitative adversary checks (AUC 0.79, Cohen's d 1.17, per-query win counts, zero-overlap decomposition) are
what calibrate; my prose reads consistently over-strength. See [[verify-empirical-gates]] iter-26 (rule 60).
