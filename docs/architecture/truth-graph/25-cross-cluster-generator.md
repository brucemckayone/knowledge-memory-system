# 25 — Cross-Cluster Candidate Generator (Phase 4)

**Phase:** 4 (integration — consumes T0+T1 outputs, generates candidates, hands off to reconciliation_agent)
**Master:** `21-cluster-bridging-master.md`
**Status:** Design draft (2026-04-29) — under review
**Bead:** to be created post-review

---

## 1. Purpose

Phase 4 is the integration pipeline that delivers on the cluster-bridging epic's headline goal: **detecting cross-component identity pairs that the existing 3-signal scoring cannot find**. It is the generator half of the generate-then-verify pattern — the verifier (`reconciliation_agent.py`) is already deployed; without this generator, it never sees the cross-component cases.

The pipeline consumes everything Phase 1–3 has produced:

- **Components** (`23.1`) — defines the disconnected sets between which we generate pairs
- **Communities** (`23.4`) — graph-edge groupings within each component
- **k-core** (`23.2`) — filters trivially-sparse leaves out of consideration
- **Articulation points** (`23.3`) — high-priority candidate endpoints (bridge would be structurally significant)
- **Centrality** (`23.5`) — protagonists make better candidates than periphery
- **Embedding clusters** (`24.1`) — same cluster across components is the strongest signal
- **Drift events** (`24.2`) — drifting entities are direct candidates

The output: rows in `merge_candidates` (existing table from `003_graph_meta.sql`) with a candidate-source tag identifying them as cross-cluster-generated. The existing reconciliation_agent picks them up via its existing flow. Phase 4 ships **no new agent**, **no new MCP tool**, **no new prompt** beyond a small extension to the existing reconciliation_agent system prompt.

This is the operationalisation of the master plan's headline insight: "we already have the verifier; we lack the candidate generator." The verifier is the reconciliation_agent. This doc builds the generator.

## 2. Design

### 2.1 The candidate-generation pipeline

For each pair of components `(A, B)` where `A.size >= MIN_COMPONENT_SIZE` and `B.size >= MIN_COMPONENT_SIZE` and `A != B`:

1. **Pre-filter entities by k-core**: drop entities with `k_core < MIN_K_CORE_FOR_BRIDGE` (default 1; we don't bridge orphans). This eliminates obvious junk before scoring.
2. **Compute pairwise scores** between candidate entities in A and B using a combined signal vector — see §2.2.
3. **Threshold and rank**: keep only pairs above `BRIDGE_SCORE_THRESHOLD`. Sort by score descending.
4. **Cap per component pair**: keep top `MAX_CANDIDATES_PER_COMPONENT_PAIR` (default 5) — avoids flooding reconciliation with low-quality pairs.
5. **Insert into merge_candidates**: each pair becomes a row with the existing 3-signal columns plus a high `combined_score`. The `resolution_reasoning` field is pre-populated with which signals fired.
6. **Existing reconciliation flow** picks them up on its next periodic invocation.

The pipeline runs after T0+T1 compute. The trigger model:

- **On-demand:** `POST /api/cross-cluster/generate` for manual / viz
- **Post-compute auto-trigger:** fire-and-forget from the success branches of `/api/topology/compute` and `/api/clustering/compute` (see §3.2 for wiring). The generator's own freshness gate enforces both-upstream-fresh — if either `topology_compute_runs` or `semantic_clustering_compute_runs` is stale relative to the most recent `entities.created_at`, the run skips with a logged reason.

### 2.2 The combined signal vector

For each candidate pair `(a, b)`:

```
score = w1 * embedding_cluster_match(a, b)
      + w2 * drift_signal(a) + w3 * drift_signal(b)
      + w4 * role_similarity(a, b)
      + w5 * centrality_match(a, b)
      + w6 * articulation_bonus(a, b)
```

Cold-eyes review fixes applied:

- **`embedding_cluster_match(a, b)`** (W2 fix — soft signal): `min(a.cluster_probability, b.cluster_probability)` if `a.cluster_id == b.cluster_id != -1`, else 0.0. Soft signal preserves HDBSCAN's per-point probability (Phase 3 already stores it in `entity_clusters.cluster_probability`). Two entities both at probability 0.95 of being in cluster 7 are stronger evidence than two at 0.51.
- **`drift_signal(x)`**: 1.0 if `x` has a recent drift event (within last 30 days) AND `target_cluster_id == y.cluster_id` for the candidate partner, else 0.0. Reads `entity_drift_events.target_cluster_id` (per `24.2` schema, cold-eyes review B2 fix). A drifting entity in component A is a strong signal when it's drifting *toward* the cluster B's partner sits in.
- **`role_similarity(a, b)`** (B1 fix — defined representation): cosine similarity of `entity_topology.predicate_signature` vectors. The signature is an L2-normalised vector over the canonical predicate vocabulary, where each component is the count of outgoing edges with that predicate. Computed by Phase 2's unified compute (master `23` §2.1 schema lock). Vector dimension is `|canonical predicate vocabulary|` from `predicates.ts`.
- **`centrality_match(a, b)`** (W1 fix — corrected formula): `min(a.pagerank, b.pagerank) / max_global_pagerank`. Rewards bridging two protagonists; penalises bridging a protagonist to a leaf — matching `21` §6.5 framing. Replaces the original `1 - |normalized_diff|` which inverted the intent on power-law-distributed pagerank.
- **`articulation_bonus(a, b)`**: 0.5 if either is an articulation point in its component (would create a structurally-meaningful bridge), else 0.0.

Initial weights (per the master plan's commitment to ship-and-tune): **w1=0.35, w2=w3=0.125, w4=0.20, w5=0.15, w6=0.05**. Sum = 1.0. Tuned via §7.x weight-tuning protocol.

### 2.3 Signal source tagging

Cross-cluster candidates need to be distinguishable from the existing 3-signal candidates so reconciliation can apply different prompting. Two options:

- **A. Add a `candidate_source` column** to `merge_candidates` with default `'three_signal_scoring'`; cross-cluster sets it to `'cross_cluster_generator'`. Forward-compatible with future generators.
- **B. Use the existing `resolution_reasoning` field** with a structured prefix like `[CROSS_CLUSTER]`.

We pick **A** — explicit column. Cleaner queries, easier to extend.

```sql
ALTER TABLE public.merge_candidates ADD COLUMN candidate_source VARCHAR(40) NOT NULL DEFAULT 'three_signal_scoring';
CREATE INDEX IF NOT EXISTS idx_merge_candidates_source ON public.merge_candidates (candidate_source);
```

### 2.4 Reconciliation_agent prompt extension

The existing `reconciliation_agent.py` iterates over `merge_candidates` rows and decides per pair: same_as / merge / distinct. Post-bead `nmemo-2yv.42` (unified scorer) and `nmemo-2yv.44` (prompt-builder collapse), the system prompt carries a single signal-interpretation section **between INVESTIGATION PROCESS and BRIDGE FACTS**:

> **=== INTERPRETING SIGNALS ===**
>
> Each candidate row carries a set of similarity signals (centroid, memory overlap, structural, cluster, drift, role, centrality, articulation). Any of these may be NULL — that means the input wasn't applicable (e.g. cross-component pairs have no shared memories, so `memory_overlap` is NULL, not zero). Treat NULL as "signal not applicable", NOT as "signal fired weakly".
>
> When most direct-similarity signals (centroid, memory_overlap, structural) are NULL — typical for pairs in disconnected components surfaced by topological evidence — the strongest evidence will come from textual narrative, not graph signals. Prioritise `get_entity_sources` to look for narrative voice changes, role similarities across disjoint subgraphs, or coreference signals the extraction agent missed.
>
> The `resolution_reasoning` field (when present) carries a per-signal contribution breakdown. Treat it as a hypothesis seed, not a verdict.

The prompt-builder collapses to a single block:

```python
def _build_reconciliation_prompt(candidates: list[dict], recent_reports: list[str]) -> str:
    lines = ["## Reconciliation Context\n"]
    if not candidates:
        lines.append("### No merge candidates\n")
    else:
        lines.append(f"### Merge Candidates ({len(candidates)} unresolved)\n")
        for c in candidates:
            lines.append(
                f"- **Candidate {c.get('id')}** | score={c.get('combined_score', 0):.2f} "
                f"| source={c.get('candidate_source', 'unknown')} | status={c.get('status')}\n"
                f"  Entity A: {c.get('a_name')} ({c.get('a_type')}) id={c.get('entity_a_id')}\n"
                f"  Entity B: {c.get('b_name')} ({c.get('b_type')}) id={c.get('entity_b_id')}\n"
                f"  Signals: centroid={_fmt_signal(c.get('centroid_similarity'))} "
                f"memory_overlap={_fmt_signal(c.get('memory_overlap'))} "
                f"structural={_fmt_signal(c.get('structural_similarity'))}\n"
                f"  reasoning_seed: {c.get('resolution_reasoning') or '(no per-signal seed)'}\n"
            )
    # ... rest (recent_reports, instructions) unchanged ...
```

`_fmt_signal` renders NULL as the literal `"NULL"` (not `"0.00"`) so the LLM can distinguish "signal not applicable" from "signal fired weakly". The `candidate_source` value is visible on each row as informational tag; it no longer drives prompt branching because — post-.42 unification — signal-population is uniform across both enumerators.

§4.2 includes integration tests (`ml-services/tests/test_reconciliation_prompt.py`) locking the single-block shape, NULL rendering, and source-tag visibility.

### 2.5 Drift events as direct candidates

A drift event with `triggered_action='reconciliation_invoked'` already invokes the **sibling drift endpoint** per `24.2` §2.5 (`/reconciliation-agent/drift`). But that flow scopes the agent to the single drifted entity; it doesn't produce a *paired* candidate.

For drift events above the action threshold, Phase 4 ALSO inserts cross-cluster candidate rows pairing the drifted entity with each entity in `entity_drift_events.target_cluster_id` (per `24.2` schema). The target cluster is computed by Phase 3's drift detector at event-emission time (cold-eyes review R3 B2 fix), not at Phase 4 read time.

For each candidate row inserted from a drift event:
- `entity_a_id`, `entity_b_id` = canonical (LEAST, GREATEST) of (drifted_entity, target_cluster_member)
- `combined_score` = the §2.2 score, computed against the partner
- `centroid_similarity`, `memory_overlap`, `structural_similarity` = typically **NULL** for cross-component pairs because their inputs (shared memories, structural neighbours) are absent. Post-bead `nmemo-2yv.42`, this follows uniform NULL semantics across both enumerators — a signal is NULL when its inputs are absent, populated when inputs exist. The pre-.42 per-source "NULL by design" lock (originally R3 B3) is superseded: the same observable behaviour now derives from the shared scorer's NULL-on-absent-input rule rather than a per-path policy.
- `candidate_source` = `'cross_cluster_generator'`
- `resolution_reasoning` = "Drift-driven candidate; entity drifted toward this cluster on [date]"

ON CONFLICT policy: post-bead `nmemo-2yv.42` both enumerators feed `scoreMergeCandidates`/`upsertScoredCandidates` (merge-scorer.ts), so signal columns are uniform regardless of which path wrote the row. The pre-.42 service-side rule preserving an existing `'cross_cluster_generator'` tag against three-signal downgrade (originally R3 B4) is moot — there's no source-demotion risk because the source tag is now informational (enumerator origin), not policy-bearing. Last-writer-wins on the source tag is acceptable.

Per-event cap (bead `nmemo-2yv.97`): the "always insert" semantics above hold for the **top-N** candidates per drift event. The env knob `MAX_DRIFT_DRIVEN_CANDIDATES_PER_EVENT` (default 10) caps each drift event's contribution — for each event, drift-driven pairs are sorted by combined score DESC and only the top-N are kept. Without this cap, a single drift event whose `target_cluster_id` points at a 500-member cluster would pair the drifted entity with every cross-component member, blowing out the reconciliation_agent's prompt budget on one event and crowding out attention from other candidates. The cap preserves the doc-locked "always insert" intent — the strongest N still bypass `BRIDGE_SCORE_THRESHOLD` that §2.2 enforces — while bounding blast radius. Mirrors the §2.2 `MAX_CANDIDATES_PER_COMPONENT_PAIR` pattern (default 5).

This pairs the drift mechanism with the candidate-generation mechanism so they reinforce rather than duplicate work.

### 2.6 Out of scope

- **Multi-round candidate generation** — re-running after reconciliation creates same_as links. Future cycles will pick up the new graph state automatically.
- **Reverse signal (entities that should be split)** — when an entity is improperly merged. That's a separate pipeline not in scope here.
- **Active learning** — using the reconciliation_agent's verdicts to retrain the signal weights. Future work; for now we tune via iteration cycle benchmarks.
- **Cross-cluster candidates within the same component** — by definition, this pipeline is about disconnected components. Same-component identity questions are handled by the existing 3-signal scoring.

## 3. Implementation

### 3.1 Module location

New file `platform/src/services/cross-cluster-generator.ts`:

```typescript
export async function generateCrossClusterCandidates(): Promise<CandidateGenerationResult> {
  // 1. Verify upstream computes are recent
  await verifyTopologyAndClusteringFresh();
  
  // 2. Get all (component_id_a, component_id_b) pairs above threshold
  const componentPairs = await getEligibleComponentPairs(MIN_COMPONENT_SIZE);
  
  // 3. For each pair, score eligible entities
  const allCandidates: ScoredCandidate[] = [];
  for (const [aId, bId] of componentPairs) {
    const candidates = await scoreComponentPair(aId, bId);
    allCandidates.push(...candidates);
  }
  
  // 4. Threshold + cap + insert
  const filtered = filterAndCap(allCandidates);
  await insertCandidates(filtered);
  
  // 5. Return summary
  return { component_pairs_evaluated: componentPairs.length, candidates_inserted: filtered.length };
}
```

`scoreComponentPair(a, b)` queries the relevant tables (entity_topology, entity_clusters, entity_drift_events) and computes the combined score per §2.2.

### 3.2 Endpoint and pipeline wiring

- **`POST /api/cross-cluster/generate`** — manual trigger. Returns the generation result.
- **`GET /api/cross-cluster/candidates`** — list cross-cluster-generated candidates. Convenience for viz / debugging.
- **Auto-trigger wiring:** a helper `triggerCrossClusterAfterCompute(after: 'topology' | 'clustering')` is called fire-and-forget (`void`) from the success branches of `/api/topology/compute` and `/api/clustering/compute`. The helper wraps `generateCrossClusterCandidates()` in try/catch and logs the result (or skip reason, or failure) without ever surfacing back into the originating HTTP response. The helper currently lives in `platform/src/index.ts`; bead `nmemo-2yv.88` will relocate it (alongside `triggerReconciliationDriftAfterCompute`) into a `services/` module — the doc references it as "the trigger helper" rather than pinning a file path.

The "same patrol both-fresh" constraint from the master plan is not enforced by call-site coordination; instead, the generator's own freshness gate (below) skips when either upstream is stale, and a `pg_try_advisory_xact_lock` inside the generator short-circuits overlapping invocations.

**"Fresh" definition (cold-eyes review W4):** an upstream compute is "fresh" if its `*_compute_runs.completed_at` is more recent than the most recent `entities.created_at` (i.e. nothing's been ingested since the compute ran). Concretely:

```typescript
async function isUpstreamFresh(runsTable: string): Promise<boolean> {
  const latestCompute = await db.queryOne(
    `SELECT MAX(completed_at) AS ts FROM public.${runsTable} WHERE status = 'completed'`
  );
  const latestEntity = await db.queryOne(
    `SELECT MAX(created_at) AS ts FROM public.entities`
  );
  if (!latestCompute?.ts || !latestEntity?.ts) return false;
  return latestCompute.ts >= latestEntity.ts;
}
```

The cross-cluster generator skips this cycle if either `topology_compute_runs` or `semantic_clustering_compute_runs` is not fresh. The skip is logged via the trigger helper's wrapper but not treated as failure — the next compute on either route retries.

### 3.3 Schema migration

Migration `017_candidate_source.sql`:

```sql
ALTER TABLE public.merge_candidates
  ADD COLUMN IF NOT EXISTS candidate_source VARCHAR(40) NOT NULL DEFAULT 'three_signal_scoring';

CREATE INDEX IF NOT EXISTS idx_merge_candidates_source
  ON public.merge_candidates (candidate_source);
```

### 3.4 Read patterns

- `SELECT * FROM merge_candidates WHERE candidate_source = 'cross_cluster_generator' AND status = 'candidate' ORDER BY combined_score DESC` — for the reconciliation_agent's prompt
- `SELECT COUNT(*) FROM merge_candidates GROUP BY candidate_source, status` — viz dashboard

## 4. Verification

### 4.1 Manual checks

- After running on `synthetic-10k` with 50 ground-truth bridge pairs (per `28` §3.3): the generator surfaces a substantial fraction of the 50 pairs as candidates
- After ingesting Frankenstein and reconciling: the generator produces "the stranger ↔ Victor Frankenstein" as a candidate (the canonical milestone case)
- Recall ≥ target threshold against ground-truth bridge pairs

### 4.2 Automated tests

Test file `platform/src/test/harness/cross-cluster-generator.snapshot.test.ts` (snapshot-using; serial).

- **Empty graph:** no candidates generated; no error.
- **Single-component graph:** no candidates (no cross-component pairs to consider).
- **Two trivial components (size 1 each):** no candidates (below MIN_COMPONENT_SIZE).
- **Two non-trivial components, no shared cluster, no drift:** few or no high-scoring candidates (signal vector low across the board).
- **Two non-trivial components, one entity in each shares an embedding cluster:** that pair scores high, surfaces as a candidate.
- **Drifted entity:** entity with a recent drift event in component A produces candidates against entities in component B sharing the drifted-toward cluster.
- **Articulation bonus:** an articulation point in component A scores higher than a non-articulation-point counterpart, all else equal.
- **Threshold filter:** candidates below `BRIDGE_SCORE_THRESHOLD` are NOT inserted; verified by setting threshold high and confirming zero rows.
- **Cap per pair:** with many candidates above threshold for a single component pair, only top `MAX_CANDIDATES_PER_COMPONENT_PAIR` inserted.
- **Candidate_source column populated:** every row inserted has `candidate_source = 'cross_cluster_generator'`.
- **No duplicates:** running the generator twice on the same state produces zero new rows on the second run (UNIQUE on entity_a_id, entity_b_id from the existing schema enforces this).
- **Bridge-pair recall on synthetic-10k:** with default thresholds and weights, recall on ground-truth bridge pairs > `RECALL_THRESHOLD` (default 0.6 — to be tuned).
- **Frankenstein integration milestone:** load `frankenstein-10chunks` after a clean ingest; run pipeline; verify "the stranger" and "Victor Frankenstein" appear as a high-score candidate. (This is the canonical `nmemo-a7f` milestone.)
- **Prompt-builder integration test (cold-eyes review W6):** insert a cross-cluster `merge_candidates` row; invoke `_build_reconciliation_prompt(candidates=[that row])`; assert the resulting prompt string contains "Cross-Cluster Candidates" and the entity names. This locks the prompt-rendering contract.

### 4.3 Acceptance criteria for `bd close`

- All §4.2 tests pass
- Manual checks pass on Frankenstein + synthetic-10k
- Bridge-pair recall on `synthetic-10k` >= 0.6 (tuneable; the value is recorded in benchmark report)
- Reconciliation_agent prompt extension shipped + integration test verifies agent receives `candidate_source` correctly
- Migration `017_candidate_source.sql` applies cleanly to a populated DB
- Benchmark report committed
- No regression in upstream test suites

## 5. Benchmark

### 5.1 Acceptance thresholds

Pipeline latency on `synthetic-10k` (~10k entities, 5 cluster modes, 50 bridge pairs):

| Operation | Target | Hard cap |
|---|---|---|
| Get eligible component pairs | < 100 ms | 500 ms |
| Score one component pair (avg) | < 1 s | 5 s |
| Score all pairs (10k entities, ~10 components) | < 30 s | 120 s |
| Insert candidates | < 1 s | 5 s |
| **Total wall clock** | **< 35 s** | **150 s** |

Pipeline complexity is roughly O(n²) in the worst case (small dense graph, many components). The `MIN_COMPONENT_SIZE` and `MIN_K_CORE_FOR_BRIDGE` filters reduce the effective n. We do NOT compute scores for every entity-pair across all components — only entities passing both filters.

### 5.2 Quality metrics

The acceptance signal is precision/recall, not latency. Phase 4 ships with three quality metrics measured against `synthetic-10k`'s ground-truth bridge pairs:

- **Recall** = correctly-flagged bridge pairs / total ground-truth bridge pairs. **Target ≥ 0.6** at default thresholds (cold-eyes review W5 rationale: above 0.5 indicates measurable lift over the existing 3-signal scorer's ~0% recall on cross-component cases. The bar is "the generator does measurably better than what we have"; 0.5 is the floor of "more than chance").
- **Precision** = correctly-flagged bridge pairs / total candidates emitted. **Target ≥ 0.3** (we accept more false positives than false negatives — the LLM verifier filters them; 0.3 means the agent rejects ~70% of candidates which keeps prompt cost bounded).
- **Precision @ recall=0.9** measured separately — to recover all bridges, what fraction of candidates is junk? If precision drops below 0.1 at recall=0.9, the score is too noisy at high recall; investigate.
- **F1** = harmonic mean. Reported but not the primary metric (we tolerate low precision in favour of high recall).

These thresholds are tunable via the iteration cycle. The benchmark report records all four numbers per run so trends are visible across regenerations.

### 5.3 Baseline reports

Under `platform/src/test/data/phase4-cross-cluster/benchmark-reports/`:

- `synthetic-10k.json` — `{recall, precision, f1, candidates_emitted, ground_truth_size, elapsed_ms, weights, thresholds}`
- `frankenstein-10chunks.json` — `{cross_cluster_candidates_emitted, manual_assessment_notes, elapsed_ms}`
- `mixed-narrative-technical-1k.json` — same as above

### 5.4 What we measure over time

- **Recall trend** across LLM-snapshot regenerations: stable indicates a robust pipeline; drift indicates upstream signal change
- **Precision trend** as weights are tuned: tightening thresholds should raise precision at recall cost
- **Top-flagged-pair stability** on the same snapshot across runs: deterministic given upstream computes

## 6. Edge cases

| Case | Expected behaviour |
|---|---|
| Empty graph | No component pairs to evaluate; no candidates. |
| Single component | No cross-component pairs; no candidates. |
| All entities in noise (cluster_id=-1) | Embedding cluster signal is 0 for all pairs; other signals may still produce candidates. |
| Topology compute is stale (out of date) | Pipeline logs warning; skips this cycle. |
| Semantic-clustering compute is stale | Same — skip with warning. |
| Two entities already linked by same_as | They're in the same component (per `23.1` rules). Pipeline skips them. |
| Two entities already in `merge_candidates` (any source) | Existing UNIQUE constraint on (entity_a_id, entity_b_id); INSERT does upsert (or skip — depending on existing logic). Verify no duplicate rows. |
| Drift event for entity that's been deleted | drift_event row cascade-deleted; pipeline correctly handles missing entity. |
| Concurrent generation invocations | Advisory lock `pg_try_advisory_lock(hashtext('cross_cluster_generator'))`; second call short-circuits with "generation in progress." Released on completion (or rolled back automatically on transaction end). Cold-eyes review B5 lock. |
| Score weights sum != 1.0 | Pipeline normalises (each weight ÷ sum) before comparing to threshold AND emits a `console.warn` naming the drift so operator typos surface. Sum = 0 also warns; the run yields zero candidates. See bead nmemo-2yv.91. |
| Score depends on a NULL column (e.g. pagerank not yet computed) | Treat as 0; component pair may still produce candidates from other signals. |

## 7. Iteration cycle

### 7.1 Initial fixtures

Under `platform/src/test/data/phase4-cross-cluster/`:

```
fixtures/
├── empty-graph.sql
├── single-component.sql
├── two-trivial-components.sql
├── two-components-no-bridge.sql           -- no cluster overlap, no drift
├── two-components-cluster-overlap.sql     -- one entity in each shares cluster
├── drifted-entity-bridge.sql              -- one entity drifting toward another cluster
├── articulation-point-pair.sql            -- bonus signal active
├── many-candidates-cap-test.sql           -- exceeds MAX_CANDIDATES_PER_COMPONENT_PAIR

expected/
├── (one per fixture, asserting candidate count + presence of expected pairs)
```

### 7.2 Evolution signals

- Recall drops on a regenerated snapshot — upstream extraction or clustering changed
- Precision drops too low (too many false positives) — tighten weights or add new signal
- Frankenstein milestone fails — investigate which signal failed to fire on the canonical case
- Real corpora produce candidate counts wildly different from expected — extend fixtures

### 7.3 "Done enough"

- All §4.2 tests pass
- Recall ≥ 0.6 and precision ≥ 0.3 on `synthetic-10k`
- Frankenstein milestone passes
- Reconciliation agent integration test passes
- No upstream regressions

### 7.4 Weight-tuning protocol (cold-eyes review W3)

Weights are not magic. The protocol:

1. **Per-signal contribution logging.** Each candidate emitted records its per-signal contribution in `merge_candidates.resolution_reasoning` JSON: `{cluster: 0.X, drift_a: 0.Y, drift_b: 0.Z, role: 0.A, centrality: 0.B, articulation: 0.C}`. Benchmark reports aggregate this distribution per signal across all candidates.
2. **Grid-search post-hoc.** After each Phase 4 benchmark run on `synthetic-10k` ground truth, an offline analysis grid-searches weights in `[0, 0.5]` × 6 dimensions (subject to `sum=1.0`) for F1-optimal at recall ≥ 0.6. Top-3 candidate weight vectors logged.
3. **Adoption requires evidence.** A weight vector change ships only if it improves F1 AND maintains recall ≥ 0.6 on at least two distinct snapshots (`synthetic-10k` + `mixed-narrative-technical-1k`). One-snapshot wins are noise.
4. **Per-corpus tuning is future work.** For now, one weight vector applies globally. If real-world ingest produces consistent per-corpus underperformance, revisit.

#### Env-override workflow (bead nmemo-2yv.91)

Operators tune weights without source edits via these env vars (each defaults to the §6 reference value):

| Env var                          | Signal           | Default |
|----------------------------------|------------------|---------|
| `CROSS_CLUSTER_W_CLUSTER`        | embedding match  | 0.35    |
| `CROSS_CLUSTER_W_DRIFT_A`        | drift A→B        | 0.125   |
| `CROSS_CLUSTER_W_DRIFT_B`        | drift B→A        | 0.125   |
| `CROSS_CLUSTER_W_ROLE`           | role similarity  | 0.20    |
| `CROSS_CLUSTER_W_CENTRALITY`     | centrality match | 0.15    |
| `CROSS_CLUSTER_W_ARTICULATION`   | articulation     | 0.05    |

Behaviour:

- Weights read per `generateCrossClusterCandidates()` invocation — restart not required.
- If `|sum - 1.0| > 1e-3`, the pipeline normalises each weight (`w_i / sum`) before scoring AND emits a `console.warn` naming the sum drift. Operator typo (e.g. only setting one weight) surfaces instead of being silently rescaled.
- If `sum == 0`, the pipeline emits a separate warn and yields zero candidates (no crash, no NaN scores).
- `BRIDGE_SCORE_THRESHOLD` stays calibrated against the normalised weighted sum (bounded by 1), so threshold semantics are preserved across weight changes.

### 7.5 Forward evolution

- **Generator output as training data for KGE (Phase 5)** — high-confidence Phase 4 candidates, once verified by reconciliation, become labelled positives for KGE supervised training.
- **Active feedback** — reconciliation_agent's same_as / distinct verdicts are labels. Phase 5+ can use them to retrain weights or train a learned-to-rank model that subsumes the heuristic combination.

## 8. References

### Existing docs
- `21-cluster-bridging-master.md` §7 Phase 4 milestone
- `22-graph-stats-foundation.md` — operational concerns, especially auth + reasoning_reports patterns
- `23-topology-primitives.md` — provides components, communities, k-core, articulation, centrality
- `24-centroid-clustering-and-drift.md` — provides clusters and drift events
- `28-test-data-snapshots.md` — provides `synthetic-10k` ground-truth bridge pairs

### Existing code referenced
- `platform/src/services/graph-meta.ts` — sibling 3-signal generator that this pipeline complements
- `platform/src/db/migrations/003_graph_meta.sql` — `merge_candidates` schema
- `ml-services/app/reconciliation_agent.py` — the LLM verifier; prompt extended by this bead
- The trigger helper (`triggerCrossClusterAfterCompute`) — currently in `platform/src/index.ts`, scheduled for relocation to a `services/` module by bead `nmemo-2yv.88`

### Sibling features
- `26-structural-embeddings.md` (Phase 5, deferred) — KGE-based candidate generation, additive to this pipeline
- `27-deep-entity-resolution.md` (Phase 6, deferred) — GNN-based ER, additive

### External
- Peeters & Bizer, *Using ChatGPT for Entity Matching*, ESWC 2023 — generate-then-verify SOTA
- Tang et al., *LLMs for Data Annotation and Entity Resolution: A Survey*, arXiv 2402.10588, 2024 — survey of recent generate-then-verify pipelines
- Pan et al., *Unifying Large Language Models and Knowledge Graphs: A Roadmap*, TKDE 2024

---

*Bead inherits §4.3 acceptance criteria. The migration `017_candidate_source.sql`, the reconciliation_agent prompt extension, and the new endpoint all ship in this bead.*
