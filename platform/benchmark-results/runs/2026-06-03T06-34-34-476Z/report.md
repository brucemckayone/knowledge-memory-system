# Comparison run 2026-06-03T06-34-34-476Z

- commit: `80d203c`
- corpus: corpus10.json (10 chunks)
- modes: serial | orders: forward, reverse
- model: pi

## Structural scorecard (exact)

| mode | wallMs | ents | facts | dupEnt | dupFact | litmus | vsBaseline(match/extraF/missF) |
|---|---|---|---|---|---|---|---|
| serial | 1714476 | 10 | 27 | 0 | 0 | false | baseline |

## Semantic scorecard (entityF1/factF1)

| mode | determinism | litmus(fwd/rev) | vsBaseline |
|---|---|---|---|
| serial | - | 0.78/0.18 | baseline |

## Correctness vs gold

### serial.forward vs gold (`corpus10.json`)

- entity F1: 0.95 (P 0.90 / R 1.00)
- current-fact F1: 0.18 (P 0.11 / R 0.50)
- current-state correctness: 0.67 (2/3 exclusive expectations)
- failing exclusive expectations:
  - Helix Robotics [org_hq]: expected `Austin`, got 0 active (none)
- predicate sprawl: none

### serial.reverse vs gold (`corpus10.json`)

- entity F1: 0.78 (P 0.78 / R 0.78)
- current-fact F1: 0.11 (P 0.07 / R 0.33)
- current-state correctness: 0.33 (1/3 exclusive expectations)
- failing exclusive expectations:
  - Elena Vasquez [role_title]: expected `chief technology officer`, got 2 active (navigation stack engineer, junior software engineer)
  - Helix Robotics [org_hq]: expected `Austin`, got 2 active (boston, austin)
- predicate sprawl: none

## Invariants

### serial.forward (5/5 pass, 0 error rows)

- PASS [error] singleActivePerExclusiveGroup — At most one active fact per (subject, exclusive predicate group); supersession should expire the rest.
- PASS [error] causalJustification — Every causal edge has non-empty reasoning + source_references and is not a self-loop.
- PASS [error] referentialIntegrity — All fact/event/edge/contradiction/same_as foreign keys resolve to existing rows.
- PASS [warning] objectValueNotSentence — Active literal object_values should be values, not sentences (<= 64 chars and <= 12 words).
- PASS [info] orphanEntities — Entities referenced by no active fact (as subject or object).

### serial.reverse (4/5 pass, 2 error rows)

- FAIL [error] singleActivePerExclusiveGroup — At most one active fact per (subject, exclusive predicate group); supersession should expire the rest.
  - subject 2e42463b-e1fb-4c87-a0a6-2a9133a73b95 holds 2 active facts in exclusive group 'org_hq' with distinct objects: 5555beb4-2720-47bd-9e42-4762d46c031e, 54fd6bf7-b30a-41ed-82b5-6eee50f1d932
  - subject b9f1f183-2137-4437-8b15-0d9b0cad1b28 holds 2 active facts in exclusive group 'role_title' with distinct objects: value:navigation stack engineer, value:junior software engineer
- PASS [error] causalJustification — Every causal edge has non-empty reasoning + source_references and is not a self-loop.
- PASS [error] referentialIntegrity — All fact/event/edge/contradiction/same_as foreign keys resolve to existing rows.
- PASS [warning] objectValueNotSentence — Active literal object_values should be values, not sentences (<= 64 chars and <= 12 words).
- PASS [info] orphanEntities — Entities referenced by no active fact (as subject or object).

## Per-step instrumentation

### serial.forward

- contradictions: detected 4 during ingest, reflected 4 in final table, gap 0
- contradictions by status: 0 resolved / 0 dismissed / 4 active
- supersession: 6 expired / 27 active facts
- causal edges: 9 active / 1 expired
- same_as merges: 0; entities 10; facts 33

### serial.reverse

- contradictions: detected 4 during ingest, reflected 4 in final table, gap 0
- contradictions by status: 0 resolved / 0 dismissed / 4 active
- supersession: 12 expired / 29 active facts
- causal edges: 7 active / 1 expired
- same_as merges: 0; entities 9; facts 41

## Reports review

### serial.forward (0 discrepancies)

- reports: 10 extraction / 2 gardening / 3 reasoning
- reasoning by mode: patrol=3; thin/patrol-only: 2/3
- gardening actions total: 0
- no report-vs-graph discrepancies.

### serial.reverse (0 discrepancies)

- reports: 10 extraction / 2 gardening / 4 reasoning
- reasoning by mode: patrol=4; thin/patrol-only: 2/4
- gardening actions total: 0
- no report-vs-graph discrepancies.

## Snapshots

- serial.forward: `serial.forward.canonical.json` / `serial.forward.rich.json`
- serial.reverse: `serial.reverse.canonical.json` / `serial.reverse.rich.json`

## Trend

Comparing run `2026-06-03T06-34-34-476Z` (commit `80d203c`) vs `2026-06-02T19-44-28-424Z` (commit `f06ab63`).

- serial (new arm — no prior):
  - current-state-correctness: - -> 0.67
  - invariant pass-rate: - -> 1.00
  - fact F1 vs gold: - -> 0.18
  - determinism F1 (fact): - -> - 
  - litmus F1 (fact): - -> 0.18
  - throughput ms: - -> 1714476.00
  - predicate-sprawl: - -> 0.00
