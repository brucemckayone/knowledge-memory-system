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
