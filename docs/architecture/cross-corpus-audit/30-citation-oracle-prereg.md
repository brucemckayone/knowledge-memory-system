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
Fetch `referenced_works` (and `id`) for all 294 papers (corpus-A/B) from OpenAlex — independent of our pipeline
AND of embedding. A cross-pair (a∈NLP, b∈CV) is **CITE-RELATED** under:
- **direct:** a ∈ refs(b) OR b ∈ refs(a) (one cites the other), OR
- **coupled:** |refs(a) ∩ refs(b)| ≥ k (bibliographic coupling — share ≥k references).

Report **direct-only** and **direct∪coupled** separately (direct is the cleanest embedding-orthogonal signal;
coupling is mildly topical — flagged). **k is calibrated on the oracle distribution alone** (choose the smallest
k giving a median ≥2 cross-related B per A-query and ≥50% of queries with ≥1; if citations are too sparse,
report that as the finding and fall back to co-citation via `cited_by`). Report base rate + cross-corpus direct-
citation density + the overlap between the citation oracle and the doc-28 topical oracle (if citations were just
the topical oracle again, the test is void — a required check).

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

## 8. RESULT

*(added after the run + blind adversary)*
