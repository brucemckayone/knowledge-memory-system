# 21 — Cluster Bridging & Graph Analysis: Master Plan

**Status:** Design draft (2026-04-29) — under review
**Branch:** `feat/reasoning-agent` → future `feat/cluster-bridging`
**Bead:** `nmemo-a7f` (P1)
**Children:** (Option B — deep structure, one doc per feature; shipping-order numbering)

**Phase 1 — foundation (single feature):**
- `22-graph-stats-foundation.md` — singleton stats table + computation

**Phase 2 — topology primitives (T0, master + 5 features; file numbers match ship order):**
- `23-topology-primitives.md` — phase master, scope and integration
- `23.1-connected-components.md`
- `23.2-k-core.md`
- `23.3-articulation-points.md`
- `23.4-community-detection.md`
- `23.5-centrality.md`

**Phase 3 — centroid clustering + drift (T1, master + 2 features):**
- `24-centroid-clustering-and-drift.md` — phase master
- `24.1-hdbscan-clustering.md`
- `24.2-drift-detection.md`

**Phase 4 — integration:**
- `25-cross-cluster-generator.md` — generate-then-verify pipeline consuming T0+T1 outputs

**Phase 5 — structural embeddings (deferred, design only):**
- `26-structural-embeddings.md`

**Phase 6 — deep entity resolution (deferred, design only):**
- `27-deep-entity-resolution.md`

**Sibling doc (testing infrastructure dependency):**
- `28-test-data-snapshots.md` — Postgres + Qdrant snapshot infrastructure for production-shape representative datasets. **Hard dependency:** Phase 1 close is bd-blocked on the snapshot infrastructure being ready (see §10 lock B2). Sibling, not child — covers more than cluster-bridging.

**Sibling epic (separate beads tree):** code test-hardening and improvements to the `test-harden` skill itself — separate scope per user direction 2026-04-29. Cluster-bridging work *uses* `test-harden`; improving `test-harden` does not belong in this epic.

---

## 1. Purpose

This work makes the knowledge graph **self-aware**. Today the system can store entities, facts, and causal edges, but it cannot answer questions about its own structure: how many islands exist, which entities are protagonists, where the bridges are, whether two clusters are actually about the same person, whether an entity's meaning has drifted over time. Without these signals, every reconciliation decision the LLM makes is uninformed by the shape of what it's reconciling.

We are building a **graph-analysis layer** that sits alongside Graph S (truth) and Graph C (causality), per `06-graph-meta-layer.md` lines 17-22. It computes structural and semantic statistics, surfaces candidates that the existing 3-signal merge scoring misses, and feeds those candidates to the existing `reconciliation_agent` for judgement.

The architectural insight underpinning the whole plan: **we already have the verifier; what we lack is the candidate generator.** The modern paradigm in cross-domain entity resolution (Peeters & Bizer, ESWC 2023; Tang et al., arXiv 2402.10588, 2024) is *generate-then-verify*: cheap structural and embedding-based methods produce candidate pairs/clusters, then an LLM judges identity from full text. `reconciliation_agent.py` is exactly the verifier half of that pattern. This work builds the generator half.

### 1.1 Quality bar

Per user direction 2026-04-29: the priority is **good design that is easy to parse**. Commit structure, doc structure, code structure, and bead structure all follow from this — clean separation of concerns and a clean dependency tree at every level. The work also requires **deep verification and testing**: every phase ships with explicit acceptance criteria, edge-case coverage, and a benchmark suite (see §7). The existing `test-harden` skill (`/test-harden`, `docs/architecture/truth-graph/20-test-harden-skill-design.md`) is the recursive verification mechanism we lean on — fixture evolution + isolated-context subagents catching regressions and surfacing real failures rather than fitting tests to code.

## 2. The trigger

The need for this layer surfaces whenever a corpus contains identity-bridging cases that the existing 3-signal merge scoring cannot detect: two entities that represent the same real-world referent but inhabit disconnected source contexts. The pattern is general — it arises in:

- **Narrative text** with multiple voices for the same person (third-person description of a character before they begin first-person narration)
- **Technical documentation** with cross-section coreference (a concept introduced by description in one chapter and named formally in another)
- **Conversation transcripts** with anaphora across speakers
- **Any multi-document corpus** where coreference resolution must cross document boundaries

In all of these the existing scoring fails the same way: centroid similarity diverges (entities sit in different semantic neighbourhoods), memory overlap is zero (different sources), structural similarity is zero (no shared neighbours). All three signals say "distinct"; the system is structurally blind to identity that bridges disconnected source contexts.

`docs/handoff/truth-graph-findings.md` (2026-03-31) documented one concrete instance — the canonical *Frankenstein* test case where an entity introduced in third person ("the stranger") is later revealed as a first-person narrator ("Victor Frankenstein"). This case is useful as a diagnostic, but the design must generalise. Every capability in §6 is framed against the abstract pattern; concrete examples appear as illustrations only, never as the spine of the design.

The architecture anticipated this — `06-graph-meta-layer.md` lines 204-211 lists "Cluster membership per entity" and "Embedding drift detecting identity transitions" as Phase 3+ future work. This document operationalises that future.

## 3. North Star — questions the system should be able to answer

| Question | Capability that answers it | Tier |
|---|---|---|
| What does our graph look like in aggregate? | graph_stats | foundation |
| What islands exist? | connected components | T0 |
| How embedded is each entity? | k-core decomposition | T0 |
| Which entities, if removed, split the graph? | articulation points | T0 |
| Who are the protagonists? Who are the bridges? | centrality (PageRank, betweenness) | T0 |
| What natural groupings exist? | community detection (Leiden) | T0 |
| Which entities live in similar meaning-space? | centroid clustering (HDBSCAN) | T1 |
| Has an entity's meaning shifted over time? | drift detection (ADWIN/BOCPD) | T1 |
| What role does each entity play structurally, name-independent? | KG embeddings (TransE/RotatE) | T2 |
| Given everything about A and B, are they the same? | GNN-based entity resolution | T3 |

Each row is a capability. Each capability gets a section in §6 below explaining purpose, a worked example, the technique options (with full detail in the child docs), and current status.

## 4. Where we are today

### 4.1 What exists

| Component | Source | What it does |
|---|---|---|
| `entity_meta` table | mig 003 | Per-entity stats: mention count, source-memory count, fact count, centroid (768-dim), spread |
| `merge_candidates` table | mig 003 | Pairwise candidate pairs scored by 3 signals |
| `same_as_links` table | mig 005 | Non-destructive identity links between entities |
| `extraction_reports` table | mig 005 | Stored agent reports for reconciliation |
| `merge_entities()` function | mig 005 | Destructive merge with full re-pointing of facts/aliases/causal events/same_as |
| `graph-meta.ts` service | platform | Computes 3 signals; pairwise O(n²); thresholds 0.4 staging / 0.7 candidate |
| `reconciliation_agent.py` | ml-services | LLM judge with full SAME_AS/MERGE/DISTINCT decision framework |
| `gardener_agent.py` | ml-services | Topology-aware exploration (sparse leaves already detected) |
| `/api/reconcile` endpoint | platform | Manual trigger; auto-fired when candidates exist |
| `/api/garden` endpoint | platform | Manual gardener trigger |

### 4.2 What's missing

- **Graph-level statistics.** No `graph_stats` table. The 3-signal scoring uses fixed weights regardless of whether the graph is single-source or multi-cluster. `06-graph-meta-layer.md` lines 136-202 specifies adaptive weighting that reads `graph_stats`; never implemented.
- **Topology awareness.** `graph-meta.ts` is purely pairwise. It does not compute connected components, k-core, articulation points, or any centrality. The gardener has hand-rolled "sparse leaf" detection but no general structural primitives.
- **Community membership.** No entity has a community label. There is no way to say "show me all entities from cluster X" (the doc 06 line 207 example).
- **Centroid clustering.** Centroids exist but are never clustered. We don't know which entities live in the same semantic neighbourhood.
- **Drift tracking.** `updateEntityMeta` overwrites the centroid on every call. There is no history. The "stranger → Victor" centroid shift is mathematically detectable but currently invisible.
- **Cross-component candidate generation.** Above all: no mechanism produces cross-cluster candidate pairs when the 3-signal score is below threshold. This is the *primary* gap behind `nmemo-a7f`.

## 5. Architecture decisions

### 5.1 The ML sidecar question

`ml-services/` is a Python FastAPI service running on port 8000. Today it routes everything to Claude (extraction, reconciliation, gardening, reasoning). Adding graph analysis means scaling up the Python dependency footprint of this existing service:

| Tier | Adds to `ml-services/requirements.txt` | Image impact | GPU? |
|---|---|---|---|
| T0 | `networkx`, `igraph` | Negligible | No |
| T1 | `scikit-learn`, `hdbscan`, `river` (for ADWIN) | Small | No |
| T2 | `pykeen` → `torch` (CPU) | Large (~1 GB) | Optional |
| T3 | `torch-geometric` or `dgl` | Large + GPU recommended | Yes (10k+ edges) |

We commit to T0 + T1 unconditionally. T2 and T3 are evaluated as separate decisions after T0+T1 ships and we measure remaining gaps.

### 5.2 The generate-then-verify contract

All cluster-bridging candidate generation feeds into the *existing* `reconciliation_agent` as the LLM verifier. We do not build a second judgement layer. New candidate generators surface pairs into `merge_candidates` (or a sibling table for cluster-level candidates) and let the existing agent decide. This keeps reasoning, source-evidence, and audit trail centralised in one place.

### 5.3 Compute placement

| Computation | Where | Why |
|---|---|---|
| Graph stats | Postgres (SQL/AGE) | Singleton; runs in seconds; database-native |
| Components, k-core, articulation | Postgres (Cypher in AGE) or Python sidecar | Both work at our scale; Python is more flexible |
| Centrality | Python sidecar (NetworkX/igraph) | Approximate algorithms (sampled betweenness) need library support |
| Community detection | Python sidecar (Leiden) | igraph/leidenalg are the canonical implementations |
| Centroid clustering (HDBSCAN) | Python sidecar | hdbscan package |
| Drift detection (ADWIN) | Python sidecar | river or hand-rolled |
| KGE (T2) | Python sidecar | PyKEEN |

Pattern: **Postgres holds the canonical state and result rows; the Python sidecar runs the algorithms and writes back.** This mirrors how extraction and reconciliation already work.

### 5.4 Trigger model

Three trigger modes, mirroring the existing reconciliation/gardener pattern:

- **On-demand**: `POST /api/graph-analysis/run` for manual / viz-button invocation.
- **Patrol-time**: every N reasoning-agent runs (mirrors `PATTERN_DETECTION_INTERVAL` from Phase 6 — `pipeline.ts:33-40`). Each capability (graph_stats, topology compute, drift detection) has its own interval and is fired sequentially after a successful patrol — *never in parallel*. Concrete intervals: `GRAPH_STATS_INTERVAL = 5`, `TOPOLOGY_COMPUTE_INTERVAL = 5`, `DRIFT_DETECTION_INTERVAL = 5` (each runs on every 5th reasoning patrol). They don't double-up: each is a try/catch wrapper called once when its modulo condition fires, the next runs only after the previous returns. (Cold-eyes review S7.)
- **No inline path**: nothing in this layer runs on the hot ingest path. Drift was originally locked inline (master §10 Q3) but moved to patrol-time per cold-eyes review W6 — the supposed O(log n) cost glosses over cold-restart history-load cost. Patrol-time is simpler and equally effective.

Topology primitives (T0), centroid clustering (T1), and drift detection all run patrol-time or on-demand. This bounds blast radius if a computation is slow or buggy.

## 6. Capability catalogue

Each capability gets a "what question does it answer?" framing with a Frankenstein worked example, then points to the child doc for technique details and acceptance criteria.

### 6.1 Graph stats (foundation)

**Question it answers:** What does our graph look like in aggregate? Is it healthy?

**What it surfaces:** Single-culture vs multi-culture posture, total scale, fact density, orphan rate, predicate diversity, recent-growth deltas. The graph's *shape* changes the meaning of every other signal — a centroid similarity of 0.7 means very different things in a graph where most entities live in one tight semantic cluster vs one spread across multiple cultures. Without these aggregates, every downstream computation is operating on context-free numbers.

**Why it matters:** Adaptive weighting in the 3-signal scoring (`06-graph-meta-layer.md` lines 180-195) depends on it. So does every viz-time aggregate ("show me the dashboard"). It is the cheapest capability to ship and unblocks many others.

**Technique:** Direct SQL aggregation, recomputed periodically. See `22-graph-stats-foundation.md`.

**Status:** Ship first.

### 6.2 Connected components

**Question it answers:** What islands exist in the graph?

**What it surfaces:** Each entity gets a `component_id`. Disconnected entity sets become explicitly enumerable. Cross-component candidate pairs — the gap behind `nmemo-a7f` — become a queryable concept that any candidate generator can iterate over. In any multi-document corpus where coreference fails to bridge document boundaries, this is the most direct way to detect that the failure has occurred.

**Why it matters:** The primary cross-component candidate generator runs over component pairs. For each pair of components above a size threshold, we ask: "is there an entity in A and an entity in B that the LLM should consider co-referent?" Without component IDs, this question can't even be phrased.

**Technique:** Standard union-find or BFS traversal. NetworkX `connected_components` or AGE Cypher. See `23-topology-primitives.md`.

**Status:** Ship in T0.

### 6.3 k-core decomposition

**Question it answers:** How embedded is each entity in the connectivity?

**What it surfaces:** A single integer per entity. k=0 → orphan (no edges in the active fact graph). k=1 → leaf. k≥2 → embedded. Replaces the ad-hoc "sparse leaf" rules currently in the gardener with a principled, well-known graph primitive that gives a clean total ordering of every entity by how deeply it sits in the connectivity.

**Why it matters:** Replaces the gardener's hand-rolled sparse-leaf detection with a principled, O(m) primitive. Pairs with embedding outlier scoring to distinguish "real-but-undocumented" from "extraction artifact."

**Technique:** Batagelj & Zaveršnik O(m) algorithm. Standard library implementations. See `23-topology-primitives.md`.

**Status:** Ship in T0.

### 6.4 Articulation points & bridges

**Question it answers:** Which entities, if removed, would split the graph?

**What it surfaces:** Edges whose removal disconnects the graph (bridges) and vertices whose removal does the same (articulation points). After cluster bridging, the `same_as` link between two previously-disconnected clusters is by definition a bridge — its removal returns the graph to two components. Identifying these structurally critical edges and entities flags the highest-risk targets for any operation that might modify or remove them (merge, expire, demote).

**Why it matters:** Operational safety — flags entities and edges where structural damage from a bad reconciliation decision is highest.

**Technique:** Tarjan's algorithm, O(n+m). See `23-topology-primitives.md`.

**Status:** Ship in T0.

### 6.5 Centrality

**Question it answers:** Who are the protagonists? Who's the bridge?

**What it surfaces:** Different centralities answer different questions and produce different rankings:
- **Degree** — local popularity (how many direct neighbours)
- **Betweenness** — bridge-ness (how often this entity sits on shortest paths between others)
- **PageRank** — structural importance with damping
- **Eigenvector** — connected-to-the-important

For narrative or technical corpora, betweenness identifies entities that bridge subnarratives or sub-disciplines; PageRank identifies the protagonists or central concepts. The reasoning agent currently picks targets by `last_reasoned_at` cooldown alone — adding a centrality-aware *boost on top of the cooldown* lets it prefer structurally important entities without re-reasoning over them constantly. Centrality augments the cooldown-based ranker; it does not replace it. (Cold-eyes review W4.)

**Why it matters:** The reasoning agent (`reasoning_agent.py`) currently picks targets by `last_reasoned_at` cooldown. Centrality lets it prioritise structurally important entities — the protagonists deserve more attention than the periphery.

**Technique:** Brandes for exact betweenness (O(n·m), too expensive at scale); Riondato-Kornaropoulos sampled betweenness for approximation. PageRank power iteration is cheap. See `23-topology-primitives.md`.

**Status:** Ship in T0 (PageRank + sampled betweenness).

### 6.6 Community detection (Leiden)

**Question it answers:** What natural groupings does the graph reveal on its own?

**What it surfaces:** Run Leiden over the active fact graph and the algorithm returns communities — graph-edge-defined groupings — *without being told they exist*. Each entity gets a `community_id`. Downstream queries become possible: "what predicates are common in community X but not Y?", "which entities sit at the boundary between two communities?", "is this community growing, stable, or shrinking?". Distinguishes narrative-derived communities from technical-derived from conversation-derived automatically.

**Terminology note:** "community" in this doc always refers to Leiden output (graph-edge-based). "Embedding cluster" (§6.7) refers to HDBSCAN output (centroid-based). The legacy term "culture" from `06-graph-meta-layer.md` is retired in favour of these two precise terms.

**Why it matters:** Doc 06 line 207 ("show me all entities from source cluster X") is unblocked. So is multi-source `graph_stats` — `culture_count` is just `count(distinct community_id)`. Communities also serve as the unit for cross-cluster candidate generation: pairs of entities in different communities are higher-priority for cluster bridging.

**Technique:** Leiden via `leidenalg` + igraph. Louvain is the predecessor; Leiden fixes its badly-connected-community bug (Traag, Waltman & van Eck, *Sci Rep* 2019). See `23-topology-primitives.md`.

**Status:** Ship in T0.

### 6.7 Centroid clustering (HDBSCAN)

**Question it answers:** Which entities live in similar parts of meaning-space?

**What it surfaces:** HDBSCAN over `entity_meta.centroid` finds dense neighbourhoods in 768-dim semantic space. It returns a "noise" label for entities outside any neighbourhood — those are structurally interesting outliers (rare topics, weakly contextualised entities, or extraction artefacts). Critically, two entities that are co-referent across narrative voices typically land in *different* HDBSCAN clusters because their source contexts differ; this cluster mismatch, *combined* with other signals, is itself a candidate signal that drift detection (§6.8) reads.

**Why it matters:** Complements community detection (which uses graph edges) with embedding-space communities (which use textual semantics). When the two disagree, that's interesting — it surfaces "structurally close, semantically distant" or vice versa, both of which are reconciliation candidates.

**Technique:** HDBSCAN over the existing `entity_meta.centroid` column. No `k` required. Variable density. See `24-centroid-clustering-and-drift.md`.

**Status:** Ship in T1.

### 6.8 Drift detection

**Question it answers:** Has an entity's meaning-space-position shifted over time?

**What it surfaces:** A flag, per entity, when the distribution of that entity's source-mention vectors shifts. Whenever new mentions arrive in a different semantic neighbourhood than prior mentions — because of a narrative voice change, a new context introduction, or genuine cross-source coreference resolution by the extraction agent — ADWIN detects the distributional shift and raises an event. The reconciliation agent is then invoked specifically on the drifted entity to ask "is this still one entity, or two?". This is the only capability on the menu that addresses identity transition as a temporal phenomenon.

**Why it matters:** This is doc 06 line 209 made operational. It's also the *only* technique on the menu that addresses identity transition as a temporal phenomenon. It runs cheaply on the live ingest path because each addition is O(log n).

**Technique:** ADWIN (Bifet & Gavaldà, SDM 2007) per entity, watching distance-from-rolling-centroid. BOCPD as a richer alternative. See `24-centroid-clustering-and-drift.md`.

**Status:** Ship in T1.

### 6.9 Structural embeddings (KGE) — deferred (`26-structural-embeddings.md`)

**Question it answers:** What role does each entity play structurally, regardless of name?

**What it surfaces:** Entities that participate in similar `(subject, predicate, object)` patterns get nearby embeddings — even in disjoint subgraphs, even with no shared neighbours. Two entities that play analogous structural roles (e.g. "narrator-of," "rescued-by," "depends-on," "instance-of") cluster together in KGE space regardless of name or source context. This produces candidate pairs that pure centroid or memory-overlap similarity miss; it is the technique most directly aimed at the residual cross-component bridging cases that T0+T1 cannot reach.

**Why it matters:** Closes the gap that all of T0 + T1 leave open: cross-component candidate pairs whose structural roles match but whose source contexts and graph structure don't overlap.

**Technique:** TransE, DistMult, ComplEx, RotatE — all standard. PyKEEN provides ready implementations. CPU training is feasible at our scale.

**Status:** Design only in `26-structural-embeddings.md`. Ship decision deferred until after T0+T1 ships and we measure how many cluster-bridging cases T0+T1 plus existing reconciliation actually solve.

### 6.10 Deep entity resolution — deferred (`27-deep-entity-resolution.md`)

**Question it answers:** Given everything we know about A and B, are they the same?

**Worked example:** A trained R-GCN takes (A, B) and all their neighbourhoods, centroids, predicate signatures, and outputs a probability they are co-referent. Or a biencoder + cross-encoder pipeline takes synthesised entity profiles and ranks the cross-product.

**Why it matters:** Highest-precision entity resolution available. Probably overkill at our scale.

**Technique:** R-GCN, GraphSAGE, BLINK-style biencoders. PyTorch + torch-geometric. See `27-deep-entity-resolution.md`.

**Status:** Design only. No commitment to ship.

## 7. Shipping order

Numbered phases. Each phase ends with a measurable milestone *and* a benchmark report before the next begins. Every phase produces:

1. A migration (or no-migration justification)
2. Code in the appropriate service
3. Tests covering happy path, edge cases, adversarial inputs
4. A baseline benchmark report committed under `platform/src/test/data/phaseN-{name}/benchmark-reports/`
5. A `bd close` only after all of the above pass concrete verification (per `feedback_verify_tasks.md`)

The `test-harden` skill is the recursive verification mechanism. Each phase's design doc must specify its **iteration cycle**: how the fixture set evolves over time to catch regressions and surface previously-hidden failures. This is mandatory, not optional.

### Phase 0 — Doc tree complete (this work)

Finish `21` (this doc) plus the per-feature design docs per Option B (see §10). The 9 unconditional docs (`22`, `23` + 5 children, `24` + 2 children, `25`) get full sections 1-8 per the §10 template. The 2 deferred docs (`26`, `27`) get sections 1-3 (Purpose, Design, Implementation) only — Verification / Benchmark / Iteration are deferred until ship decision.

User reviews each doc. Beads tasks created from completed docs (per user direction 2026-04-29: detailed beads created *after* docs are reviewed, not before).

### Phase 1 — `graph_stats` foundation (`22`)

Migration `013_graph_stats.sql` adding the singleton table. `computeGraphStats()` routine. Initial wiring into `/api/graph-analysis/run`. Viz dashboard surface (small).

**Milestone:** `SELECT * FROM graph_stats` returns a populated row after ingest. Numbers match a manual SQL audit.

### Phase 2 — T0 topology primitives (`23`)

Migration adding `entity_topology` (component_id, k_core, pagerank, betweenness, community_id, is_articulation_point). Computation routine in Python sidecar reading from AGE. Patrol-time trigger.

**Milestone:** After ingesting the canonical multi-source test corpus, every entity has a populated topology row. Component count matches the expected number of source-disjoint subgraphs. Highest betweenness lies on the `same_as` bridge after reconciliation has run. Spot-checks against multiple corpora (narrative, technical, mixed) show consistent results.

### Phase 3 — T1 centroid clustering + drift (`24`)

Migration adding `entity_centroid_history` (time-series of centroids per entity per N memory additions) + `entity_clusters` (HDBSCAN cluster IDs). Drift detector wired into `updateEntityMeta`. Drift events raised as `causal_events` of a new transition_type.

**Milestone:** Re-ingesting the canonical test corpus chunk-by-chunk produces a drift event for any entity whose source-mention distribution shifts beyond the ADWIN threshold. The cross-narrative co-reference case in the *Frankenstein* corpus is one specific instance that must trigger; corpora without any drifting entities must not produce false positives.

### Phase 4 — Cross-cluster candidate generator

The whole point of `nmemo-a7f`. With T0 + T1 in place: a routine that walks (component A, component B) pairs above a size threshold, scores each cross-component entity pair using *new* signals (KGE-or-not, role-overlap, drift-flag, embedding-cluster-mismatch), and surfaces high-scoring pairs into `merge_candidates` with a new candidate-source label so the reconciliation agent knows to handle them differently. The agent's prompt is extended to recognise cluster-bridging candidates.

**Milestone:** On a clean re-ingest of any multi-cluster corpus that contains identity-bridging cases, the cross-component generator surfaces the cross-narrative coreference pairs as candidates, the reconciliation agent creates `same_as` links with reasoning and source evidence, and the topology layer reports the post-bridging cluster count (with each `same_as` link visible as an articulation edge). The *Frankenstein* canonical test case is one specific instance of this milestone; the acceptance harness covers it explicitly without making it the sole acceptance condition.

### Decision point

Measure how many cluster-bridging cases Phase 4 solves on real corpora (Frankenstein, MISRA + work docs). If the precision/recall is acceptable, stop. If not, proceed.

### Phase 5 — KGE (`25`) — conditional

PyKEEN sidecar. TransE/RotatE training on the full triple set. KGE-based candidate generator added to Phase 4's pipeline.

### Phase 6 — Deep ER (`26`) — conditional

Only if Phase 5 isn't enough. R-GCN or biencoder + cross-encoder. Largest commitment; do not ship without measured need.

### Migration policy

Migrations are **roll-forward-only**, per the established pattern (`012_pattern_rejected.sql` header). New tables introduced by `22` (`graph_stats`), `23` (`entity_topology`, `topology_bridges`, `topology_compute_runs`), and any Phase 3+ tables are additive and idempotent (`CREATE TABLE IF NOT EXISTS`). Rollback would require explicit DROP migrations, which are not in scope. If a column needs renaming or a constraint changing, that's a separate forward migration (e.g. `015_rename_culture_to_cluster.sql` if the terminology lock §10 ships *after* `013_graph_stats.sql` has been applied to a real DB). Cold-eyes review coverage gap 1.

## 8. Out of scope

- Re-architecting the existing `reconciliation_agent`. It's the verifier. We feed it better candidates; we don't replace it.
- Replacing the 3-signal merge-candidate scorer in `graph-meta.ts`. It coexists. New signals are additive.
- Visualization beyond the dashboard graph_stats surface and the bridge-overlay on viz. Per-capability viz is a separate body of work.
- Multi-graph or multi-tenant analysis — we're designing for one graph instance.
- Performance work above ~50k entities. The algorithms scale that far without re-architecture; beyond it, reconsider.

## 9. References

### Existing docs cited

- `00-position-paper.md` — research-grounded dual-graph proposal
- `01-dual-graph-architecture.md` — Graph S + Graph C overview
- `06-graph-meta-layer.md` — *the precursor to this doc*; lines 17-22 (Graph M alongside S/C), lines 24-53 (3 signals), lines 102-124 (`merge_candidates` schema), lines 136-202 (`graph_stats` Phase 2+), lines 204-211 (cluster membership Phase 3+, embedding drift)
- `09-graph-quality-issues.md` — five quality issues; issue 5 (merge vs same_as) covers the foundation
- `10-reasoning-layer-overview.md` — phases 0-6 of the reasoning layer
- `19-implementation-runbook.md` — pattern for laying out shipping order across many phases
- `docs/handoff/truth-graph-findings.md` — Frankenstein test, 2026-03-31
- `docs/architecture/truth-graph/issues/05-merge-same-as-quality.md` — the merge/same_as criteria still in force

### Primary literature

- Bordes et al., *Translating Embeddings for Modeling Multi-relational Data* (TransE), NeurIPS 2013
- Trouillon et al., *Complex Embeddings for Simple Link Prediction* (ComplEx), ICML 2016
- Sun et al., *RotatE: Knowledge Graph Embedding by Relational Rotation in Complex Space*, ICLR 2019
- Schlichtkrull et al., *Modeling Relational Data with Graph Convolutional Networks* (R-GCN), ESWC 2018
- Hamilton et al., *Inductive Representation Learning on Large Graphs* (GraphSAGE), NeurIPS 2017
- Wu et al., *Zero-Shot Entity Linking with Dense Entity Retrieval* (BLINK), EMNLP 2020
- Peeters & Bizer, *Using ChatGPT for Entity Matching*, ESWC 2023
- Tang et al., *LLMs for Data Annotation and Entity Resolution: A Survey*, arXiv 2402.10588, 2024
- Pan et al., *Unifying Large Language Models and Knowledge Graphs: A Roadmap*, TKDE 2024
- Blondel et al., *Fast unfolding of communities in large networks* (Louvain), J Stat Mech 2008
- Traag, Waltman & van Eck, *From Louvain to Leiden*, Sci Rep 2019
- Rosvall & Bergstrom, *Maps of random walks reveal community structure* (Infomap), PNAS 2008
- Campello, Moulavi & Sander, *Density-Based Clustering Based on Hierarchical Density Estimates* (HDBSCAN), PAKDD 2013
- Bifet & Gavaldà, *Learning from Time-Changing Data with Adaptive Windowing* (ADWIN), SDM 2007
- Adams & MacKay, *Bayesian Online Changepoint Detection*, arXiv 0710.3742, 2007
- Brandes, *A Faster Algorithm for Betweenness Centrality*, J Math Sociol 2001
- Tarjan, *Depth-first search and linear graph algorithms*, SIAM J Comput 1972
- Batagelj & Zaveršnik, *An O(m) Algorithm for Cores Decomposition of Networks*, 2003
- Newman, *Networks: An Introduction*, Oxford 2nd ed. 2018

### Libraries

- NetworkX — https://networkx.org
- igraph — https://igraph.org
- python-louvain, leidenalg — https://github.com/vtraag/leidenalg
- scikit-learn — https://scikit-learn.org
- hdbscan — https://hdbscan.readthedocs.io
- river (online learning, ADWIN) — https://riverml.xyz
- PyKEEN (KGE) — https://pykeen.readthedocs.io
- PyTorch Geometric — https://pytorch-geometric.readthedocs.io
- DGL — https://www.dgl.ai

## 10. Decisions and remaining open questions

### Locked (2026-04-29)

| # | Question | Lock |
|---|---|---|
| Q1 | Tier scope | T0+T1 ship unconditionally; T2+T3 design-only, ship decision deferred until Phase 4 evaluation. Quality bar = "good design, easy to parse" drives commit and bead structure. |
| Q2 | Compute placement | Postgres holds canonical state; Python sidecar runs algorithms. |
| Q3 | Drift placement | **Patrol-time** alongside topology compute (revised from earlier inline decision). Per the cold-eyes review W6: ADWIN's "O(log n) per update" assumes prior history is in memory, but cold-service / cross-restart cost is unbounded. Patrol-time is simpler — no in-memory state to maintain across restarts, fits the "Postgres as canonical state" pattern. Drift is still temporal; the latency just becomes "by next patrol" rather than "next memory write." |
| Q4 | Decision-point evaluation | Benchmark suite is essential — precision/recall on labelled cluster-bridging cases is the acceptance signal. Deep verification and testing throughout, leveraging the existing `test-harden` skill. |
| — | Beads tree | Epic → phase tasks → implementation tasks (with verification + benchmark sub-tasks). Cluster-bridging is one epic; code test-hardening improvements live in a *separate* epic. |
| — | Per-doc structure | Every per-phase / per-feature design doc must include: pure definition of purpose; verification approach; benchmark mechanism; edge-case enumeration; iteration cycle for fixture / test-data evolution. |
| B2 | Snapshot infrastructure dependency | `28-test-data-snapshots.md` is a sibling doc; its bead **blocks** cluster-bridging Phase 1 close. Production-shape snapshots (Postgres + Qdrant) are required for Phase 1's `synthetic-10k` benchmark. |

### Locked from cold-eyes review (2026-04-29)

| # | Question | Lock |
|---|---|---|
| Centroid lifecycle (review B2) | Phase 3 HDBSCAN reads live `entity_meta.centroid` but writes `entity_clusters.centroid_snapshot VECTOR(768)` at clustering time. Cluster IDs remain stable; drift detection compares current live centroid against the snapshot to compute cosine drift. No new column on `entity_meta`. | Phase 3 design doc `24.1` carries the schema. |
| Vitest parallelism (review B5) | `*.snapshot.test.ts` filename convention; a dedicated vitest config / project runs these with `--no-file-parallelism`. `ensureSnapshot` closes existing pool, runs `pg_restore`, reopens pool. Snapshot tests are inherently slow and run serially. | `28` §3.6 carries the test-helper contract. |
| Synthetic generator semantics (review B6) | Layered: generator synthesises per-memory vectors → memory rows + Qdrant points → memory_entities links → calls real `updateEntityMeta`. Exercises the actual centroid-from-memory-vectors code path. Bridge-pair entities get independent memories drawn from different cluster modes. | `28` §3.3 carries the layered process. |
| Manifest model pinning (review B7) | Manifest schema gains `claude_model_version_pin`, `claude_temperature`, `embedding_model_pin`, `embedding_dim`, `pg_dump_flags`. Stops silent drift when upstream models or pg_dump defaults change. | `28` §2.3 + §3.4. |
| Technical corpus (review W8) | Replace MISRA C++ with **NIST SP 800-63B** (Digital Identity Guidelines) — public domain, technical, has cross-section coreference. License-clear. | `28` §2.2 roster. |
| Terminology | "community" = Leiden output (graph-edge-based, populated by Phase 2). "Embedding cluster" = HDBSCAN output (centroid-based, populated by Phase 3). "Culture" retired. Column rename: `graph_stats.culture_count` → `embedding_cluster_count`; `mean_intra_distance` → `mean_intra_cluster_distance`; `mean_inter_distance` → `mean_inter_cluster_distance`. | `22` §3.1 schema; `23` §2.1 schema. |

### Locked from second cold-eyes review (2026-04-29 — three reviewers)

| # | Question | Lock |
|---|---|---|
| Reconciliation_agent integration | The existing `reconciliation_agent.py` Pydantic model rejects unknown kwargs and its prompt template bails when candidates is empty. Phase 3 (`24.2`) and Phase 4 (`25`) extensions land via a **sibling endpoint `/reconciliation-agent/drift`** with its own `ReconciliationDriftRequest` model and prompt template. The existing `/reconciliation-agent` endpoint is unchanged. | `24.2` §2.5; `25` §2.4. |
| Predicate signature | `role_similarity` in `25` §2.2 needs a defined representation. Lock: **`predicate_signature VECTOR(N)` column on `entity_topology`**, computed by Phase 2's unified compute as a normalised sparse vector over the canonical predicate vocabulary (counts of outgoing predicates per entity, L2-normalised). N = canonical predicate count from `predicates.ts`. | `23` §2.1 schema add; Phase 2 compute owns it. |
| Drifted-toward cluster | `25` §2.5 references "the cluster being drifted toward" but `24.2` `entity_drift_events` doesn't carry it. Lock: **add `target_cluster_id INTEGER` column** to `entity_drift_events`. Computed in `24.2`'s drift detector as the cluster whose centroid (mean of `entity_clusters.centroid_snapshot` for entities with that cluster_id) is nearest to the drifted entity's `centroid_current`. | `24.2` §2.2 schema. |
| Cluster reassignment detection | `24.2` says ADWIN state resets when HDBSCAN reassigns the entity, but the schema doesn't expose the previous cluster_id. Lock: **add `last_cluster_id INTEGER` column** to `entity_drift_state`; reset compares current vs last. | `24.2` §2.4. |
| `river` version pinning | `river.drift.ADWIN` API has changed across versions. Lock: pin **`river>=0.21,<1.0`** in `ml-services/requirements.txt`; verified API surface is `ADWIN(delta=...)`, `detector.update(value)`, `detector.drift_detected` (property). Smoke test in bead acceptance imports + exercises the three calls. Add `river_version VARCHAR(20)` column to `entity_drift_state`; mismatched version on unpickle resets state with a warning. | `24.2` §2.4, §3.1. |
| Cross-cluster signal columns | When `25` writes a cross-cluster `merge_candidates` row, the existing 3-signal columns (`centroid_similarity`, `memory_overlap`, `structural_similarity`) are **NULL**, not 0. Reconciliation prompt extension (§2.4) acknowledges that cross-cluster rows have NULL/0 in those columns and don't carry the same evidence. | `25` §2.3, §3.x. |
| Cross-cluster ON CONFLICT policy | `merge_candidates` UNIQUE on `(entity_a_id, entity_b_id)`. Lock: ON CONFLICT **preserves the existing `candidate_source`** — never downgrades cross-cluster to three-signal or vice versa. New rows arriving for an existing pair update score columns but leave `candidate_source` alone. | `25` §3.x; mirrors `graph-meta.ts` ON CONFLICT pattern. |
| `25` concurrency | Pick **PostgreSQL advisory lock** (`pg_try_advisory_lock(hashtext('cross_cluster_generator'))`) over a status table. Lighter for a generator that runs in seconds; no janitor needed. | `25` §6. |
| Snapshot test naming | All snapshot-using benchmark tests use `*-bench.snapshot.test.ts` suffix per `28` §3.6. Phase 2 children's `*-test.ts` benchmark cases split into a unit file + a snapshot file. | All Phase 2/3/4 children §4.2. |
| Auth on read endpoints | All new read endpoints (`/api/components/:id`, `/api/communities/:id`, `/api/clusters/:id`) inherit existing platform auth model — currently public. Tracked as a single cross-cutting bead in the test-hardening epic, not per phase. | All children §3.x. |
| Migration rollback | All Phase 2/3/4 migrations are roll-forward-only per `21` §7 migration policy. Children docs reference this rather than re-stating. | All children §3.x. |

### Locked (continued)

| # | Question | Lock |
|---|---|---|
| Q5 | Doc + beads granularity | **Option B** — deep structure, one doc per feature. Sharper scoping serves the §1.1 quality bar ("easy to parse"). Phase masters are lightweight indexes; per-feature docs carry the full Design + Implementation + Verification + Benchmark + Iteration-cycle sections. Beads tree mirrors: Epic → phase tasks → 1 implementation task per feature, each with verification + benchmark sub-tasks. |
| Q6 | Doc numbering | Shipping-order numbering. Phase 4 (integration) is `25`, KGE is `26`, deep-ER is `27`. Master is `21`. Phase 2/3 master docs use whole numbers (`23`, `24`); their feature children use decimal suffixes (`23.1` … `24.2`). |

### Beads tree (mirrors doc tree)

```
nmemo-a7f                   epic: Cluster bridging (P1)
  ├─ {phase-1}              Phase 1: graph_stats foundation
  │    └─ impl: 22          (single feature; no child split needed)
  ├─ {phase-2}              Phase 2: topology primitives (T0)
  │    ├─ impl: 23.1        connected components
  │    ├─ impl: 23.2        k-core decomposition
  │    ├─ impl: 23.3        articulation points & bridges
  │    ├─ impl: 23.4        centrality (PageRank + sampled betweenness)
  │    └─ impl: 23.5        community detection (Leiden)
  ├─ {phase-3}              Phase 3: centroid clustering + drift (T1)
  │    ├─ impl: 24.1        HDBSCAN clustering
  │    └─ impl: 24.2        drift detection (ADWIN)
  ├─ {phase-4}              Phase 4: cross-cluster generator
  │    └─ impl: 25          (single integration pipeline)
  ├─ {phase-5} (deferred)   Phase 5: KGE — design only
  └─ {phase-6} (deferred)   Phase 6: deep-ER — design only

{separate epic, sibling tree}: code test-hardening + test-harden skill improvements
```

Each implementation task carries its own verification + benchmark sub-tasks per `feedback_verify_tasks.md`. No `bd close` without concrete acceptance + benchmark report committed.

### Per-document required sections

Every per-feature doc must contain, in order:

1. **Purpose** — pure definition of what this feature *is*, in plain English. The question it answers.
2. **Design** — abstract framing, technique choice + rationale, integration with existing layers.
3. **Implementation** — schema (if any), code shape, integration points, trigger model.
4. **Verification** — how we know it works. Concrete checks, manual + automated.
5. **Benchmark** — what we measure. Baseline numbers committed under `platform/src/test/data/...`. Acceptance thresholds.
6. **Edge cases** — enumerated, with expected behaviour for each.
7. **Iteration cycle** — how the fixture set evolves over time via `test-harden`. What signals drive evolution. What "done enough" looks like.
8. **References** — papers, libraries, sibling docs.

---

*This master plan is the shared contract. Children docs carry per-capability Design + Implementation. Beads tasks are created only after the relevant doc(s) are reviewed.*
