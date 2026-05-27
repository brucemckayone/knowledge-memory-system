# Compute-trigger registry

**Status:** initial fill, 2026-05-26 (bead `nmemo-2yv.131`).
**Theme:** T12 — every graph compute needs a documented auto-trigger.
**Discovered from:** Review #14 cross-feature synthesis (`31-review-cycle-synthesis.md` §2.7 + §3 G4 + §4 C2).

---

## 1. Overview

Every graph compute has a documented trigger. No compute ships without a row in this registry. PRs that add a new compute must add the row in the same PR (enforced via the feature-integration checklist, doc 31 §4 C4).

The registry exists because the May 2026 review cycle found that more than half of the existing computes shipped manual-only and never received their promised auto-trigger. T12 was the cross-cutting symptom; this doc + the P1 trigger beads (`.61 .71 .72 .84 .85`) together are the cure.

This doc is intentionally a single markdown table — no YAML/JSON manifest, no CI lint, no TS-side code registry. The bead `.131` Decision section weighed those alternatives and rejected them as adding moving parts ahead of evidence that drift was a real problem.

## 2. Registry table

| Compute | Service file | Trigger condition | Cadence / threshold | `*_runs` table | Trigger source (code) |
|---|---|---|---|---|---|
| `graph_stats` | `src/services/graph-stats.ts` | Threshold-driven (post-ingest counter) | Fires when `derived_freshness.facts_since_compute` for `graph_stats` crosses `GRAPH_STATS_FACT_THRESHOLD` (default 20). Manual debug surface preserved. | n/a (single-row materialised view) | `src/services/derived-freshness.ts` (`maybeFireGraphStats`, bead `.72`); `POST /api/graph-stats/compute` still callable |
| `entity_topology` | `ml-services/app/topology.py` | DB-reactive (post-merge) + threshold-driven (post-ingest counter) | Fires on every successful `merge_entities()`; also fires when `derived_freshness.facts_since_compute >= TOPOLOGY_CLUSTERING_FACT_THRESHOLD` (default 100). Manual debug surface preserved. | `topology_compute_runs` | `src/services/derived-freshness.ts` (`triggerTopologyAndClusteringAfterMerge`, `maybeFireFactThresholdCompute`); `POST /api/topology/compute` still callable (bead `.84`) |
| `hdbscan_clustering` | `ml-services/app/semantic_clustering.py` | DB-reactive (post-merge) + threshold-driven (post-ingest counter) | Same anchors as `entity_topology` — both compute kinds fire together so the cross-cluster generator's BOTH-upstreams-fresh gate stays satisfied. Manual debug surface preserved. | `clustering_compute_runs` | `src/services/derived-freshness.ts`; `POST /api/clustering/compute` still callable (bead `.84`) |
| `drift_detection` | `ml-services/app/drift.py` | Scheduled (time-driven) | `DRIFT_PATROL_INTERVAL_MIN` cadence (default 60min) via `node-cron` job registered in `src/scheduler.ts`. Manual debug surface preserved. | `entity_drift_events` | `src/scheduler.ts` (`drift-patrol` job); `POST /api/drift/compute` still callable (bead `.84`) |
| `cross_cluster_generator` | `src/services/cross-cluster-generator.ts` | Post-compute fire-and-forget (chained off topology + clustering) | Inline after each `/api/{topology,clustering}/compute` success | `cross_cluster_runs` (bead `.92`) | `triggerCrossClusterAfterCompute` in `src/index.ts` |
| `gardener` | `src/services/gardener.ts` | Threshold (patrol-cascade) | Every N patrols; gardener auto-trigger writes don't reach `gardening_reports`, see `nmemo-2yv.67` | `gardening_reports` (write gap) | `src/pipeline.ts` (patrol cascade) |
| `reconciliation_agent` | `ml-services/app/reconciliation_agent.py` | **MANUAL ONLY — see `nmemo-2yv.61`** (state-driven trigger is the target) | — | `reconciliation_runs` | `POST /api/reconcile` only |
| `reasoning_patrol` | `src/services/reasoning-agent.ts` (`invokeReasoningAgent`) | Scheduled (time-driven) + freshness-gated | `REASONING_PATROL_INTERVAL_MIN` cadence (default 30min) via `node-cron` job registered in `src/scheduler.ts`; runner skips the fire when `max(entity_meta.last_mentioned_at) <= max(entity_meta.last_reasoned_at, reasoning_reports.created_at)`. Manual debug surfaces (`POST /api/reason`, `POST /api/reason/query`) preserved. | `reasoning_reports` | `src/scheduler.ts` (`reasoning-patrol` job, bead `.71`); `POST /api/reason` + `POST /api/reason/query` still callable |
| `pattern_detection` | `src/services/causal-patterns.ts` | Threshold-driven (post-ingest counter) | Fires when `derived_freshness.facts_since_compute` for `pattern_detection` crosses `PATTERN_DETECTION_FACT_THRESHOLD` (default 50). Runs `detectCausalPatterns()` + `promotePatterns()` in-process. Manual debug surface preserved. | `causal_patterns` | `src/services/derived-freshness.ts` (`maybeFirePatternDetection`, bead `.72`); `POST /api/patterns/detect` + `POST /api/patterns/promote` still callable |
| `decay` | `src/services/decay.ts` | **MANUAL ONLY via `POST /api/decay`** (confirm during cycle whether intentional) | — | n/a (writes onto `facts.decay_score`) | `POST /api/decay` only |
| `source_refs_drift_detection` | `src/scheduler.ts` (`checkSourceRefsDrift`) | Scheduled (time-driven) | `SOURCE_REFS_DRIFT_PATROL_CRON` (default `0 3 1 * *` — monthly at 03:00 on day-1); convenience knob `SOURCE_REFS_DRIFT_PATROL_INTERVAL_MIN` for shorter cadences. No manual HTTP surface — DB-only watchdog. | n/a (warn-log alert; drift > 0 surfaces to ops + reasoning agent) | `src/scheduler.ts` (`source-refs-drift-patrol` job, bead `nmemo-d1r.7`) |

## 3. Trigger taxonomy

Five trigger types are blessed. Pick one when adding a new compute:

### Post-ingest

The compute fires inline after an `ingest()` cycle completes. Use when:
- the compute reads facts/entities written in this ingest cycle, AND
- the cost is bounded enough to add to the ingest-path latency budget (~50ms total budget), AND
- the result is needed by downstream features that read soon after the ingest.

Examples: contradiction detection (today), gardener (today, via patrol cascade — should arguably be post-ingest), cross-cluster generator (today, after topology + clustering completes — close to post-ingest).

### DB-reactive

The compute fires when a specific DB-state condition is met — typically a counter crossing a threshold or a new row landing in a table. The trigger lives in an app-layer event handler reacting to writes (e.g. a `triggerCrossClusterAfterCompute` style hook after each topology/clustering compute).

Use when:
- the compute is expensive enough that "every ingest" is wrong, AND
- the natural anchor is "enough new state has accumulated", AND
- the anchor is observable in the DB without a clock.

Examples: cross-cluster generator (chained off topology + clustering), proposed reconciliation_agent trigger (`.61` — fires when `merge_candidates_pending > N`).

### Scheduled (time-driven)

The compute fires on a cron-like cadence, regardless of DB state. Use when:
- the compute is a streaming detector with cold-restart cost (e.g. ADWIN drift), OR
- the compute is checking for "no activity" conditions (silence is the signal), OR
- the compute has no natural DB anchor at all.

Examples: drift detection (`.84`), reasoning patrol (`.71`, time-driven cadence with an `entity_meta` freshness gate so the Claude Code subprocess only spawns when the graph has moved since the last pass).

### Threshold-driven (counter)

The compute fires when a process-local or DB-stored counter crosses a threshold. Subset of DB-reactive but worth calling out because it's the simplest shape — no state to track beyond the counter itself.

Examples: graph_stats (every N patrols), gardener (every N patrols), proposed `derived_freshness` table in `.84` (every N facts since last compute).

### Manual

The compute fires only via an explicit HTTP call or viz button. **This is a deprecated trigger condition** — every compute should evolve to one of the four above. Manual remains valid as:
- a debug surface for ad-hoc developer-driven runs (T12 rule 3: viz is a debug surface, not a primary trigger), AND
- the MVP placeholder before the real auto-trigger lands. The P1 bead `.61` remains in this category; `.71` (reasoning patrol) landed scheduled + freshness-gated, `.72` (pattern_detection + graph_stats) landed DB-reactive (threshold-driven via `derived_freshness`), `.84` (topology/clustering/drift) landed event + threshold + scheduled.

Rows in §2 with `MANUAL ONLY — see <bead>` are explicit work-in-progress placeholders.

The bead `.84` Decision section blesses **time-driven cadences as a third blessed mechanism** alongside DB-reactive event-handlers and post-event chains. The `Scheduled` taxonomy in §3 covers them; the `src/scheduler.ts` module is the single home for all such jobs going forward.

## 4. PR contract

Any PR that adds a compute MUST add its row to §2 in the same PR. Reviewers reject PRs without the registry update. The check is manual (no CI lint today); doc 32 + this section is the social contract.

Any PR that **changes a compute's trigger** (e.g. lands `.84` and converts the three MANUAL ONLY rows to their real triggers) MUST update §2 in the same PR.

The five P1 trigger beads tracking the MANUAL ONLY entries:

- `nmemo-2yv.61` — reconciliation_agent state-driven trigger
- `nmemo-2yv.71` — reasoning_patrol time-driven trigger
- `nmemo-2yv.72` — pattern_detection cadence decoupling from reasoning patrol
- `nmemo-2yv.84` — topology / clustering / drift auto-triggers (event-driven + scheduled hybrid; introduces `scheduler.ts` + `derived_freshness` table)
- `nmemo-2yv.85` — cross-cluster generator drift-event refresh hook

When each lands, its `MANUAL ONLY` row(s) update to the real trigger condition + cadence + source-of-trigger code path.

## 5. Cross-references

- `21-cluster-bridging-master.md` §10 W6 — patrol-time drift promise; the §2 row for drift_detection points back to `.84`.
- `25-cross-cluster-generator.md` §3.2 — freshness gate that requires BOTH upstream computes to be fresh; the cross-cluster row in §2 names it as the cure for stale-input runs.
- `31-review-cycle-synthesis.md` §2.7 — T12 theme inventory.
- `31-review-cycle-synthesis.md` §4 C2 — the umbrella bead motivating this doc.
- `nmemo-2yv.131` — this doc's owning bead.

When implementing a new compute, before writing code:

1. Read §3 of this doc to pick the trigger type.
2. Add the placeholder row to §2 (trigger column = the picked type; cadence column = TBD).
3. Implement compute + trigger.
4. Update §2 row with concrete cadence + source code path before the PR merges.
