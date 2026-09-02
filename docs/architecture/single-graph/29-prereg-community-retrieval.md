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

## RESULTS (2026-09-02) — community structure is a REAL but SCOPED deterministic lever (relevant-set only), adversary-cleared of the .4 artifact

**Outcome:** PRIMARY (strict) is a TIE; CO-PRIMARY (condensed / relevant-set) DEMONSTRATED on arxiv. Per the
§5 decision rule (strict fails, condensed clears all three) → community routing helps **relevant-set /
thematic** retrieval, not specific-target. The blind adversary attacked this as the nmemo-u8j.4 name-in-query
artifact and it **survived the decisive singleton control** — it is genuine multi-member community structure.
Banked with the caveats below.

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

### Disposition (per §5: strict fails, condensed clears)
**Community structure is a real, scoped, DETERMINISTIC lever for relevant-set / thematic retrieval** (arxiv
condensed +0.0439, adversary-cleared), **not for specific-target** (strict tie). This clears the deterministic
FLOOR for the condensed co-primary ⇒ **LLM community summaries (richer than a name centroid) are worth a
GATED follow-up** — BUT the gate MUST use (i) a **held-out community assignment** (exclude each query paper's
edges) to remove the leak, and (ii) a **strict or independent oracle**, NOT another condensed run — else the
u8j.4 pattern re-enters. Bead nmemo-u8j.8 stays OPEN for that gated LLM-summary follow-up. The
`communities-*.json` frozen assignment + `export_communities.py` generator are committed (owed item 1); the
leak is stated (owed item 2); sizing the leak via a held-out per-query assignment is deferred to the
follow-up gate.

### Artifacts
`prereg-artifacts/community-results-{arxiv,qbio}.json`, `prereg-artifacts/communities-{arxiv-nlp,arxiv-cv,qbio}.json`
(frozen Louvain assignment, seed 20260831). Tools: `community-fusion.ts`, `export_communities.py`.
