# Comparison run 2026-06-09T11-34-11-255Z

- commit: `5cf954f`
- corpus: corpus20.json (20 chunks)
- modes: optimistic | orders: forward, reverse
- model: haiku

## Structural scorecard (exact)

| mode | wallMs | ents | facts | dupEnt | dupFact | litmus | vsBaseline(match/extraF/missF) |
|---|---|---|---|---|---|---|---|
| optimistic | 1358391 | 22 | 66 | 0 | 0 | false | baseline |

## Semantic scorecard (entityF1/factF1)

| mode | determinism | litmus(fwd/rev) | vsBaseline |
|---|---|---|---|
| optimistic | - | 0.90/0.29 | baseline |

## Correctness vs gold

### optimistic.forward vs gold (`corpus20.json`)

- entity F1: 0.85 (P 0.77 / R 0.94)
- current-fact F1: 0.15 (P 0.09 / R 0.50)
- current-state correctness: 0.63 (5/8 exclusive expectations)
- failing exclusive expectations:
  - Elena Vasquez [role_title]: expected `chief technology officer`, got 1 active (engineering lead)
  - Sofia Reyes [role_title]: expected `partner`, got 0 active (none)
  - Priya Anand [role_title]: expected `startup ceo`, got 1 active (vp of product)
- predicate sprawl:
  - role_title: 2 predicates (job_title, has_role)

### optimistic.reverse vs gold (`corpus20.json`)

- entity F1: 0.89 (P 0.80 / R 1.00)
- current-fact F1: 0.13 (P 0.07 / R 0.50)
- current-state correctness: 0.63 (5/8 exclusive expectations)
- failing exclusive expectations:
  - Elena Vasquez [role_title]: expected `chief technology officer`, got 2 active (cto, junior software engineer)
  - Sofia Reyes [role_title]: expected `partner`, got 1 active (board member)
  - Priya Anand [role_title]: expected `startup ceo`, got 2 active (vp of product, vp of product at helix robotics)
- predicate sprawl:
  - role_title: 2 predicates (job_title, has_role)

## Invariants

### optimistic.forward (4/5 pass, 1 error rows)

- FAIL [error] singleActivePerExclusiveGroup — At most one active fact per (subject, exclusive predicate group); supersession should expire the rest.
  - subject 0c505e58-8a77-4e9c-bca2-96dec508271b holds 2 active facts in exclusive group 'works_at' with distinct objects: 81451c92-1b75-4f54-ae3c-9bc7303b5316, 5313bc19-5672-4db5-baae-702d7ed1a86f
- PASS [error] causalJustification — Every causal edge has non-empty reasoning + source_references and is not a self-loop.
- PASS [error] referentialIntegrity — All fact/event/edge/contradiction/same_as foreign keys resolve to existing rows.
- PASS [warning] objectValueNotSentence — Active literal object_values should be values, not sentences (<= 64 chars and <= 12 words).
- PASS [info] orphanEntities — Entities referenced by no active fact (as subject or object).

### optimistic.reverse (4/5 pass, 2 error rows)

- FAIL [error] singleActivePerExclusiveGroup — At most one active fact per (subject, exclusive predicate group); supersession should expire the rest.
  - subject 61e1ac64-2540-455b-8e1f-a781ace165bc holds 2 active facts in exclusive group 'role_title' with distinct objects: value:CTO, value:junior software engineer
  - subject a6a32345-bf5c-4c70-80f9-c1e26de7b59f holds 2 active facts in exclusive group 'role_title' with distinct objects: value:VP of Product, value:VP of Product at Helix Robotics
- PASS [error] causalJustification — Every causal edge has non-empty reasoning + source_references and is not a self-loop.
- PASS [error] referentialIntegrity — All fact/event/edge/contradiction/same_as foreign keys resolve to existing rows.
- PASS [warning] objectValueNotSentence — Active literal object_values should be values, not sentences (<= 64 chars and <= 12 words).
- PASS [info] orphanEntities — Entities referenced by no active fact (as subject or object).

## Per-step instrumentation

### optimistic.forward

- contradictions: detected 7 during ingest, reflected 7 in final table, gap 0
- contradictions by status: 0 resolved / 0 dismissed / 7 active
- supersession: 13 expired / 66 active facts
- causal edges: 13 active / 0 expired
- same_as merges: 3; entities 22; facts 79

### optimistic.reverse

- contradictions: detected 9 during ingest, reflected 9 in final table, gap 0
- contradictions by status: 1 resolved / 0 dismissed / 8 active
- supersession: 17 expired / 67 active facts
- causal edges: 7 active / 9 expired
- same_as merges: 0; entities 20; facts 84

## Reports review

### optimistic.forward (0 discrepancies)

- reports: 20 extraction / 4 gardening / 4 reasoning
- reasoning by mode: patrol=4; thin/patrol-only: 4/4
- gardening actions total: 0
- no report-vs-graph discrepancies.

### optimistic.reverse (0 discrepancies)

- reports: 20 extraction / 4 gardening / 5 reasoning
- reasoning by mode: patrol=5; thin/patrol-only: 4/5
- gardening actions total: 0
- no report-vs-graph discrepancies.

## Snapshots

- optimistic.forward: `optimistic.forward.canonical.json` / `optimistic.forward.rich.json`
- optimistic.reverse: `optimistic.reverse.canonical.json` / `optimistic.reverse.rich.json`

## Trend

Comparing run `2026-06-09T11-34-11-255Z` (commit `5cf954f`) vs `2026-06-09T09-02-15-350Z` (commit `bc379fa`).

- optimistic (new arm — no prior):
  - current-state-correctness: - -> 0.63
  - invariant pass-rate: - -> 0.67
  - fact F1 vs gold: - -> 0.15
  - determinism F1 (fact): - -> - 
  - litmus F1 (fact): - -> 0.29
  - throughput ms: - -> 1358391.00
  - predicate-sprawl: - -> 2.00
