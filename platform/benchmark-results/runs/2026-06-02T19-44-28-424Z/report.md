# Comparison run 2026-06-02T19-44-28-424Z

- commit: `f06ab63`
- corpus: corpus10.json (10 chunks)
- modes: optimistic | orders: forward
- model: pi

## Structural scorecard (exact)

| mode | wallMs | ents | facts | dupEnt | dupFact | litmus | vsBaseline(match/extraF/missF) |
|---|---|---|---|---|---|---|---|
| optimistic | 1194431 | 10 | 24 | 0 | 0 | null | baseline |

## Semantic scorecard (entityF1/factF1)

| mode | determinism | litmus(fwd/rev) | vsBaseline |
|---|---|---|---|
| optimistic | - | - | baseline |

## Correctness vs gold

### optimistic.forward vs gold (`corpus10.json`)

- entity F1: 0.84 (P 0.80 / R 0.89)
- current-fact F1: 0.20 (P 0.13 / R 0.50)
- current-state correctness: 0.67 (2/3 exclusive expectations)
- failing exclusive expectations:
  - Helix Robotics [org_hq]: expected `Austin`, got 0 active (none)
- predicate sprawl: none

## Invariants

### optimistic.forward (5/5 pass, 0 error rows)

- PASS [error] singleActivePerExclusiveGroup — At most one active fact per (subject, exclusive predicate group); supersession should expire the rest.
- PASS [error] causalJustification — Every causal edge has non-empty reasoning + source_references and is not a self-loop.
- PASS [error] referentialIntegrity — All fact/event/edge/contradiction/same_as foreign keys resolve to existing rows.
- PASS [warning] objectValueNotSentence — Active literal object_values should be values, not sentences (<= 64 chars and <= 12 words).
- PASS [info] orphanEntities — Entities referenced by no active fact (as subject or object).

## Per-step instrumentation

### optimistic.forward

- contradictions: detected 7 during ingest, reflected 7 in final table, gap 0
- contradictions by status: 0 resolved / 0 dismissed / 7 active
- supersession: 8 expired / 24 active facts
- causal edges: 8 active / 0 expired
- same_as merges: 0; entities 10; facts 32

## Reports review

### optimistic.forward (0 discrepancies)

- reports: 10 extraction / 2 gardening / 3 reasoning
- reasoning by mode: patrol=2, query=1; thin/patrol-only: 1/3
- gardening actions total: 0
- no report-vs-graph discrepancies.

## Snapshots

- optimistic.forward: `optimistic.forward.canonical.json` / `optimistic.forward.rich.json`

## Trend

Comparing run `2026-06-02T19-44-28-424Z` (commit `f06ab63`) vs `2026-06-02T14-16-04-143Z` (commit `06d085e`).

- optimistic (new arm — no prior):
  - current-state-correctness: - -> 0.67
  - invariant pass-rate: - -> 1.00
  - fact F1 vs gold: - -> 0.20
  - determinism F1 (fact): - -> - 
  - litmus F1 (fact): - -> - 
  - throughput ms: - -> 1194431.00
  - predicate-sprawl: - -> 0.00
