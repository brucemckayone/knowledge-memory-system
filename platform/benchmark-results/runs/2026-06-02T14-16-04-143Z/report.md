# Comparison run 2026-06-02T14-16-04-143Z

- commit: `06d085e`
- corpus: corpus10.json (10 chunks)
- modes: epoch | orders: forward, reverse
- model: pi

## Structural scorecard (exact)

| mode | wallMs | ents | facts | dupEnt | dupFact | litmus | vsBaseline(match/extraF/missF) |
|---|---|---|---|---|---|---|---|
| epoch | 672133 | 13 | 30 | 0 | 0 | false | baseline |

## Semantic scorecard (entityF1/factF1)

| mode | determinism | litmus(fwd/rev) | vsBaseline |
|---|---|---|---|
| epoch | - | 0.96/0.39 | baseline |

## Correctness vs gold

### epoch.forward vs gold (`corpus10.json`)

- entity F1: 0.87 (P 0.77 / R 1.00)
- current-fact F1: 0.21 (P 0.13 / R 0.50)
- current-state correctness: 0.67 (2/3 exclusive expectations)
- failing exclusive expectations:
  - Elena Vasquez [works_at]: expected `Helix Robotics`, got 2 active (helix, helix robotics)
- predicate sprawl: none

### epoch.reverse vs gold (`corpus10.json`)

- entity F1: 0.80 (P 0.73 / R 0.89)
- current-fact F1: 0.06 (P 0.03 / R 0.17)
- current-state correctness: 0.33 (1/3 exclusive expectations)
- failing exclusive expectations:
  - Elena Vasquez [role_title]: expected `chief technology officer`, got 1 active (senior engineer)
  - Helix Robotics [org_hq]: expected `Austin`, got 0 active (none)
- predicate sprawl: none

## Invariants

### epoch.forward (4/5 pass, 1 error rows)

- FAIL [error] singleActivePerExclusiveGroup — At most one active fact per (subject, exclusive predicate group); supersession should expire the rest.
  - subject 79b84d2c-ca2b-4fcd-bf1d-1c0d3236f2ab holds 2 active facts in exclusive group 'works_at' with distinct objects: 9597cfec-ecfa-487f-bf31-5d67b4fdd1dc, 6f48544f-2ed0-4a09-8eea-10f77fa5526d
- PASS [error] causalJustification — Every causal edge has non-empty reasoning + source_references and is not a self-loop.
- PASS [error] referentialIntegrity — All fact/event/edge/contradiction/same_as foreign keys resolve to existing rows.
- PASS [warning] objectValueNotSentence — Active literal object_values should be values, not sentences (<= 64 chars and <= 12 words).
- PASS [info] orphanEntities — Entities referenced by no active fact (as subject or object).

### epoch.reverse (5/5 pass, 0 error rows)

- PASS [error] singleActivePerExclusiveGroup — At most one active fact per (subject, exclusive predicate group); supersession should expire the rest.
- PASS [error] causalJustification — Every causal edge has non-empty reasoning + source_references and is not a self-loop.
- PASS [error] referentialIntegrity — All fact/event/edge/contradiction/same_as foreign keys resolve to existing rows.
- PASS [warning] objectValueNotSentence — Active literal object_values should be values, not sentences (<= 64 chars and <= 12 words).
- PASS [info] orphanEntities — Entities referenced by no active fact (as subject or object).

## Per-step instrumentation

### epoch.forward

- contradictions: detected 5 during ingest, reflected 5 in final table, gap 0
- contradictions by status: 5 resolved / 0 dismissed / 0 active
- supersession: 9 expired / 30 active facts
- causal edges: 7 active / 0 expired
- same_as merges: 2; entities 13; facts 39

### epoch.reverse

- contradictions: detected 3 during ingest, reflected 3 in final table, gap 0
- contradictions by status: 3 resolved / 0 dismissed / 0 active
- supersession: 11 expired / 29 active facts
- causal edges: 6 active / 0 expired
- same_as merges: 0; entities 11; facts 40

## Reports review

### epoch.forward (0 discrepancies)

- reports: 10 extraction / 2 gardening / 2 reasoning
- reasoning by mode: patrol=2; thin/patrol-only: 1/2
- gardening actions total: 0
- no report-vs-graph discrepancies.

### epoch.reverse (0 discrepancies)

- reports: 10 extraction / 2 gardening / 3 reasoning
- reasoning by mode: patrol=2, query=1; thin/patrol-only: 2/3
- gardening actions total: 0
- no report-vs-graph discrepancies.

## Snapshots

- epoch.forward: `epoch.forward.canonical.json` / `epoch.forward.rich.json`
- epoch.reverse: `epoch.reverse.canonical.json` / `epoch.reverse.rich.json`

## Trend

first run — no prior to compare.
