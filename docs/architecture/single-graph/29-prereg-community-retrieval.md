# Pre-registration 29 — community-structure retrieval (does graph community routing add to the fusion?)

**Bead:** nmemo-u8j.8 · **Depends on:** nmemo-u8j.1 (fusion), nmemo-u8j.2 (eval engine), doc 28 (feasibility)
**Status:** FROZEN. Append results below the line; do not edit above it.
**Committed before computing:** yes.

## 1. Question

`.8`'s premise (RAPTOR / GraphRAG-community / LightRAG) is that summarising graph COMMUNITIES helps retrieval
that a flat entity/fact index misses. Doc 28 established the graph HAS strong community structure (arxiv
Louvain modularity ≈ 0.91, 50–62 substantial communities). This experiment tests the **structure** lever
**deterministically** — no LLM summaries, no Claude — as the gate before spending on LLM summarisation:

**Does a community-level signal (query → community centroid) add anything to the two-signal fusion FACTNAME
on the target-finding task, or beat name-only on the relevant-set (condensed) task?**

A deterministic community representation is the floor: the community *centroid* = the mean of its member
entity-NAME vectors (already cached; L2-normalised). If even the centroid signal helps, an LLM summary
(richer) is worth trying next; if it does not, community summaries are unlikely to be worth the LLM spend
(the same logic doc 32 used for the concept layer's density lever).

## 2. Communities & the community signal (deterministic)

- **Communities:** Louvain (`networkx.community.louvain_communities`, **seed 20260831**) on the per-corpus
  entity graph (nodes = entities, edges = active facts with distinct subject/object). Frozen assignment
  `entityId → communityId` exported to `prereg-artifacts/communities-<corpus>.json`. Entities with no fact
  edge are their own singleton community.
- **Community centroid** `c_k` = L2-normalise(mean over members of the entity NAME vector) — the SAME nomic
  name vectors the NAME/FACTNAME arms use (from the frozen + arxiv writable caches). No new embeddings.
- **Community score for a query** = cosine(query_vector, c_k).

## 3. Arms (all scored by the shared retrieval-eval oracle/bootstrap engine)

- `NAME` — dense-over-names (baseline).
- `FACTNAME` — RRF-60(names, facts), the confirmed fusion = **the head to beat**.
- `COMM` — rank entities by their community's score (all members share c_k·q; tie-break within a community by
  the entity's own NAME cosine, then index). Pure community-level routing.
- `COMMFUSE` — retrieved-set RRF-60(FACTNAME, COMM): does the community signal ADD to the head?

## 4. Metric, statistics

- **R@10**, both oracles (strict = specific target; condensed = relevant-set, the "global/thematic" flavour).
- Cluster bootstrap by pair AND entity AND document (seed 20260831, 10,000 resamples).
- **PRIMARY = COMMFUSE − FACTNAME, strict R@10** (does community structure add to the head?).
- **CO-PRIMARY (relevant-set) = COMMFUSE − FACTNAME, condensed R@10** (community's natural home is thematic
  recall).
- SECONDARY = COMM − NAME (does community routing alone beat entity-name?).

## 5. Pre-registered bar & decision rule

- **DEMONSTRATED:** `COMMFUSE − FACTNAME`, **strict** R@10 **> 0 on ALL THREE bootstraps** on arxiv ⇒ the
  community-structure signal adds to the fusion ⇒ LLM community summaries are worth testing next (a gated,
  Claude-spending follow-up). Condensed reported alongside.
- strict fails but condensed clears all three ⇒ community routing helps RELEVANT-SET (thematic) retrieval but
  not specific-target; document honestly (a real but scoped win — the "global query" use case).
- both fail ⇒ community structure (as a deterministic centroid) does NOT add to the fusion; banked NEGATIVE —
  and LLM summaries are then a hard sell (bounded by the same structure the centroid captures). Consistent
  with the cross-corpus concept-layer negatives (docs 28–32).

## 6. Kill / VOID

- **VOID (wiring):** arxiv FACTNAME must reproduce R4 (strict 0.26356589147286824, n=387) — else harness drift.
- **VOID (degenerate communities):** if Louvain returns ~1 community (no structure) or all singletons, the
  COMM signal is trivial ⇒ report the structure, don't claim. (Doc 28: arxiv modularity 0.91, not degenerate.)
- **Underpowered:** < 30 pairs ⇒ no pass/fail (guards the qbio secondary).
- **Substrate note:** report per-corpus; qbio is fragmented (doc 28: giant component 2.6%) so a null there is
  expected and is a substrate property, not a lever verdict.

## 7. Adversary (before banking)

Blind adversary: (a) wiring anchor reproduces R4; (b) communities are the frozen Louvain assignment (seed
20260831) and centroids are the mean of the SAME cached name vectors (no leakage, no re-embed); (c) re-derive
the PRIMARY delta as integer hits; (d) confirm COMM/COMMFUSE are scored on the same pair set; (e) check the
community signal is not a trivial proxy for NAME (e.g. singleton-dominated communities just reproducing the
name arm); (f) spec froze before the numbers; (g) attack the direction — is any lift real structure or an
oracle/tie-break artifact; is a null underpowered.

---

<!-- RESULTS APPENDED BELOW THIS LINE -->

## RESULTS (2026-09-02) — BANKED NEGATIVE: the condensed "win" was an UN-HELD-OUT-EDGE LEAK; held-out, community routing HURTS

> **CORRECTION (2026-09-02, supersedes the "scoped win" reading below).** The condensed +0.0439 reported
> below used a community assignment built from ALL facts **including each query paper's own edges**. Sizing
> that leak (the adversary's owed item 2) with a HELD-OUT assignment — Louvain rebuilt per query doc,
> EXCLUDING that doc's edges — flips the sign: **condensed −0.0620, strict −0.0775, both BELOW 0**. The entire
> apparent win was the leak (the community having seen the query paper). **Community structure does NOT add to
> the fusion. Banked NEGATIVE.** The "genuine multi-member structure" ruling (singleton control) ruled out the
> .4 name artifact but not this leak; the held-out test is decisive. See §Held-out leak-sizing.

**Outcome (leaky global assignment — DO NOT read as a win, see the correction):** PRIMARY (strict) TIE;
CO-PRIMARY (condensed) apparently +0.0439 — but this is 100% the un-held-out-edge leak (below).

### Numbers (arxiv n=387, reproduced bit-for-bit; wiring anchor FACTNAME strict 0.2636 = R4)
| arm | strict R@10 | condensed R@10 |
|---|---|---|
| NAME | 0.1912 | 0.2429 |
| FACTNAME (the head) | 0.2636 | 0.2920 |
| COMM (community routing) | 0.1938 | 0.2248 |
| COMMFUSE = RRF-60(FACTNAME, COMM) | 0.2661 | 0.3359 |

- **PRIMARY strict COMMFUSE − FACTNAME = +0.0026, SPANS 0** all three (103 vs 102 hits) → no specific-target
  gain. COMM − NAME strict = +0.0026 spans 0 → community routing alone ≈ name on strict.
- **CO-PRIMARY condensed COMMFUSE − FACTNAME = +0.0439 (+17/387), ABOVE 0 all three** (byDoc lo 0.0027 —
  thin) → community structure adds on the relevant-set / thematic task.

### Adversary (§7) — verdict: (a) genuine structure, NOT (b) the .4 artifact; all checks PASS
The decisive control the adversary built — **singleton** (centroid == own name everywhere, i.e.
COMMFUSE = RRF-60(FACTNAME, NAME)):
| variant | condensed Δ vs FACTNAME |
|---|---|
| COMMFUSE (real communities) | **+0.0439** (all-3 above 0) |
| SINGLETON (RRF-60(FACTNAME, NAME)) | **−0.0181** (spans 0, leans negative) |
| COMMFUSE − SINGLETON | **+0.0620** (all-3 above 0) |
The pure-name signal does NOT reproduce the win (it slightly hurts) — so this is not the .4
name+condensed-forgiveness artifact. Corroboration: singletons are only 2.5% of entities (not
singleton-dominated); the relevant entities floated above the target split Tier-A 67 (attribution/
co-occurrence) vs Tier-B 56 (verbatim name-in-query) — NOT Tier-B-dominated, so a `query.includes(name)`
reranker would not reproduce it. Wiring anchor bit-for-bit; froze first (`git show 6b8949e` = prereg only);
integer re-derivation exact (+17/387 cond, +1/387 strict).

### Caveats the adversary requires (adopted)
1. **Condensed-only, a different task from target-finding.** Strict is a true tie; re-adding the name signal
   even hurts strict (−0.0258). No specific-target capability is claimed.
2. **Un-held-out-edge LEAK (methodological).** The Louvain community graph is built from ALL active facts
   **including each query paper's own co-occurrence edges** — it is NOT held out, unlike the fact signal
   (harness excludes query-doc facts). So a portion of the thematic gain is the community having *seen* the
   query paper. On arxiv this is dilution-limited (large 50–70-member communities; COMM strict ≈ NAME strict,
   i.e. no strict advantage; ~140 non-relevant entities also float above the target — it routes broad
   thematic clusters, not a memorised query set). On qbio it is the whole story (below).
3. **High rank-churn** (38 condensed gains, 21 losses): the condensed win is community-coherent churn — when
   it demotes a target, the replacements are co-relevant community-mates that condensed forgives.

### qbio (n=94) — dismissed as a fragmented-graph artifact (adversary-confirmed honest)
COMMFUSE − FACTNAME = +0.2021 all three (strict == condensed; COMM strict 0.543 vs NAME 0.362). This is
18/20 strict target-promotion, Tier-A-dominated (31 vs 5), driven by qbio's ~5.6-entity communities (654
communities / giant component 2.6%) whose centroid ≈ the query paper's own entity cluster (query IS that
paper) — the un-held-out-edge leak at its extreme. NOT a generalisable capability; not banked.

### Held-out leak-sizing (the decisive test — `community-fusion.ts --heldout=1`, `heldout_communities.py`)
For each query doc, communities were rebuilt with Louvain (seed 20260831) EXCLUDING that doc's own
fact-edges (`heldout-communities-<corpus>.json`, 145 nlp / 147 cv per-doc assignments), then re-scored. The
global run reproduces +0.0439 exactly (regression clean), so the refactor is faithful; the held-out run:
| arm | strict R@10 | condensed R@10 |
|---|---|---|
| NAME | 0.1912 | 0.2429 |
| FACTNAME | 0.2636 | 0.2920 |
| COMM (held-out) | 0.1214 | 0.1266 |
| COMMFUSE (held-out) | 0.1860 | 0.2300 |
- **COMMFUSE − FACTNAME condensed = −0.0620, BELOW 0 all three** (vs +0.0439 leaky — a ~0.106 swing).
- strict = −0.0775 BELOW 0; COMM − NAME strict = −0.0698 BELOW 0.
So the entire condensed "win" was the leak: with the query paper's edges held out, community routing is
strictly WORSE than name and drags the fusion DOWN. (Mechanism: held-out communities fragment — a target's
grouping often depended on the query paper's own co-occurrence — so the centroid signal is noisier than the
name signal and adds harmful noise to the fusion.)

### Disposition — BANKED NEGATIVE
**Deterministic community structure does NOT add to the two-signal fusion.** The apparent condensed win was
100% an un-held-out-edge leak; held-out, COMMFUSE hurts on both oracles (condensed −0.0620, strict −0.0775).
The strict result was a tie even leaky. qbio's +0.20 was the same leak at its extreme (fragmented per-paper
communities). **LLM community summaries are now a HARD SELL** — they are bounded by the same graph structure
that, held-out, does not help retrieval, and a fair LLM test would need the same held-out discipline (the
leak that flattered the centroid would not exist). Recommend NOT pursuing the LLM-summary follow-up as a
retrieval lever; community summaries' value, if any, is non-retrieval (structure/navigation), consistent with
the cross-corpus concept-layer negatives (docs 28–32). Bead nmemo-u8j.8 CLOSED as measured-negative. Owed
items addressed: frozen assignments + generators (`export_communities.py`, `heldout_communities.py`)
committed; the leak is not just stated but SIZED (it was the whole effect).

### Artifacts
`prereg-artifacts/community-results-{arxiv,qbio}.json`, `prereg-artifacts/communities-{arxiv-nlp,arxiv-cv,qbio}.json`
(frozen Louvain assignment, seed 20260831). Tools: `community-fusion.ts`, `export_communities.py`.
