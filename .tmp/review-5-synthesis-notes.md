# Review #5 synthesis notes — Graph meta + stats

Cross-cutting observations to fold into the end-of-review integration & improvements section.

## Theme 1 — graph_stats is mostly write-only

Doc 22 §2.2 promised 5 consumers reading graph_stats values. Reality:

| Consumer | Spec | Wired |
|---|---|---|
| Viz dashboard | all columns on render | ✓ viz/js/panels/stats.js (lazy expand → /api/graph-stats) |
| Adaptive 3-signal scoring | culture_count, p10/p90 per detection | ✗ graph-meta uses fixed weights, never reads graph_stats |
| Gardener prompt | total_entities, orphan_rate, merge_candidates_pending | ✗ gardener exists (mig 006) but doesn't include graph_stats in prompt |
| Reasoning agent context | one-line summary in patrol prompt | ✗ causal-agent only BUMPS the counter, never reads |
| Phase 4 cross-cluster generator | culture_count, mean_inter_distance | ✗ cross-cluster-generator.ts has no getGraphStats call |

1 of 5 wired. The data is computed every 5 patrols and stored, but downstream context-aware scoring described in doc 22 §2.2 is not realised. graph_stats today is a viz panel, not a feedback signal.

## Theme 2 — graph-meta lags graph-stats in engineering rigor

Same conceptual layer (mig 003 vs mig 013), opposite quality bars:

| | graph-stats | graph-meta |
|---|---|---|
| Test file | ✓ 10 cases, all §4.2 covered | ✗ none |
| Benchmark reports | ✓ empty + canonical + synthetic-10k | ✗ none |
| Bench script | ✓ scripts/bench-graph-stats.ts | ✗ none |
| Idempotency | ✓ setseed + transaction-wrapped CTE | ✗ not asserted |
| Query strategy | ✓ single CROSS JOIN, ~50ms at 10k | ✗ 5 roundtrips per pair, O(n²) |
| Edge cases | ✓ doc 22 §6 enumerates 12 + tests cover most | ✗ no edge case enumeration |
| Cold-eyes review fixes | ✓ W1/B1/W7 captured in code comments | ✗ never reviewed |

graph-meta would benefit from a port of the same engineering rigour. Possible epic candidate.

## Theme 3 — doc 06 is stale on Phase 2

Doc 06 lines 132-134 describe a "Future: Reconciliation Agent (Phase 2)" as deferred. But `invokeReconciliationAgent` exists in causal-agent.ts and is called from /api/reconcile (index.ts:462). The Reconcile button is wired in viz/js/agents/reconcile.js. Phase 2 has effectively shipped; doc 06 needs a status update or a pointer to where the agent lives now.

## Theme 4 — entity_meta is touched by many features

Cross-feature reads/writes of `entity_meta`:
- mig 003 — original (centroid, mention counts)
- mig 004 — `summary TEXT` added (Review #6 / entity summarization)
- mig 008 — `last_reasoned_at TIMESTAMPTZ` added (reasoning reports)
- mig 015 — entity_clusters references entity_meta.centroid (Phase 3 HDBSCAN)
- mig 016 — entity_drift compares centroid snapshots (Phase 3 sibling)

entity_meta has become the "everything about an entity that isn't first-class" table. Schema/ownership ambiguity may bite later. Not in scope for Review #5 but worth flagging at the epic level.

## Theme 5 — dead endpoints

`/api/viz/merge-candidates` GET and `/api/viz/run-meta` POST have zero callers in viz/scripts/tests (per `git grep` against HEAD). The merge-candidates panel was presumably designed but never built; run-meta is a manual full-refresh endpoint that was never wired.

## Theme 6 — fixtures vs programmatic seeding

Doc 22 §7.1 enumerated 6 SQL fixtures under `platform/src/test/data/phase1-graph-stats/fixtures/` paired with `expected/` JSON files. Tests use programmatic seeding instead (createTestEntity/createTestFact/raw INSERTs). Functionally adequate; breaks the test-harden skill's evolution loop which consumes fixtures. Decision worth surfacing.

## Findings filed

- **F1** → split into 3 beads:
  - nmemo-2yv.42 — Extract scoreMergeCandidates module (P1)
  - nmemo-2yv.43 — Wire graph_stats adaptive weighting (P1, deps .42)
  - nmemo-2yv.44 — Retire cross-cluster score block + simplify agent prompt (P2, deps .42)
- **F2** → absorbed into nmemo-2yv.42's acceptance criteria via --notes (unit tests on the new unified scorer).
- **F5** → absorbed into nmemo-2yv.42's acceptance criteria via --notes (batched-SQL pattern + benchmark at 100/1k/10k scales).
- **F6** → nmemo-2yv.48 — computed_duration_ms atomicity (P3)
- **F7** → nmemo-2yv.49 — graph-stats reasoning_reports follow-up (P3)
- **F8** → nmemo-2yv.50 — doc 22 §7.1 fixture files (P3)
- **F3** → nmemo-2yv.45 — getMergeCandidates filter + paginate (P2)
- **F4** → split into 2 beads:
  - nmemo-2yv.46 — Delete /api/viz/run-meta (P2, now)
  - nmemo-2yv.47 — Unified merge-candidates viz panel (P3, deps .44 + .45)
