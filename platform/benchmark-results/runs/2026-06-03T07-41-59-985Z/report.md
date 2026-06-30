# Comparison run 2026-06-03T07-41-59-985Z

- commit: `8daa8e3`
- corpus: corpus20.json (20 chunks)
- modes: serial | orders: forward, reverse
- model: pi

## Structural scorecard (exact)

| mode | wallMs | ents | facts | dupEnt | dupFact | litmus | vsBaseline(match/extraF/missF) |
|---|---|---|---|---|---|---|---|
| serial | 3554575 | 21 | 53 | 0 | 0 | false | baseline |

## Semantic scorecard (entityF1/factF1)

| mode | determinism | litmus(fwd/rev) | vsBaseline |
|---|---|---|---|
| serial | - | 0.90/0.28 | baseline |

## Correctness vs gold

### serial.forward vs gold (`corpus20.json`)

- entity F1: 0.81 (P 0.71 / R 0.94)
- current-fact F1: 0.19 (P 0.11 / R 0.60)
- current-state correctness: 0.75 (6/8 exclusive expectations)
- failing exclusive expectations:
  - Sofia Reyes [role_title]: expected `partner`, got 0 active (none)
  - Helix Robotics [org_hq]: expected `Austin`, got 0 active (none)
- predicate sprawl: none

### serial.reverse vs gold (`corpus20.json`)

- entity F1: 0.94 (P 0.89 / R 1.00)
- current-fact F1: 0.15 (P 0.09 / R 0.50)
- current-state correctness: 0.38 (3/8 exclusive expectations)
- failing exclusive expectations:
  - Elena Vasquez [role_title]: expected `chief technology officer`, got 5 active (chief technology officer, project atlas, senior engineer, engineering lead, junior software engineer)
  - Sofia Reyes [role_title]: expected `partner`, got 1 active (board member)
  - Sofia Reyes [works_at]: expected `Northwind Capital`, got 0 active (none)
  - Priya Anand [role_title]: expected `startup ceo`, got 1 active (vp of product)
  - Helix Robotics [org_hq]: expected `Austin`, got 2 active (boston, austin, texas)
- predicate sprawl:
  - role_title: 2 predicates (job_title, has_title)

## Invariants

### serial.forward (4/5 pass, 2 error rows)

- FAIL [error] singleActivePerExclusiveGroup — At most one active fact per (subject, exclusive predicate group); supersession should expire the rest.
  - subject c2c4efff-b72d-4fe8-a5a8-4ec55ccc8405 holds 2 active facts in exclusive group 'works_at' with distinct objects: 6178b2f7-a7d7-47fc-95ab-88cddc87b74f, e1dd1d04-bca1-4ff3-bb5c-1cfccea73ef6
  - subject 6178b2f7-a7d7-47fc-95ab-88cddc87b74f holds 2 active facts in exclusive group 'lives_in' with distinct objects: 895e2ff9-e190-42c9-a36a-b95973576147, a04fad3f-db14-4d8c-8257-00fe69a6290e
- PASS [error] causalJustification — Every causal edge has non-empty reasoning + source_references and is not a self-loop.
- PASS [error] referentialIntegrity — All fact/event/edge/contradiction/same_as foreign keys resolve to existing rows.
- PASS [warning] objectValueNotSentence — Active literal object_values should be values, not sentences (<= 64 chars and <= 12 words).
- PASS [info] orphanEntities — Entities referenced by no active fact (as subject or object).

### serial.reverse (4/5 pass, 3 error rows)

- FAIL [error] singleActivePerExclusiveGroup — At most one active fact per (subject, exclusive predicate group); supersession should expire the rest.
  - subject 6fb2c2d4-8831-4f4a-b9cb-5e85b155f8f1 holds 5 active facts in exclusive group 'role_title' with distinct objects: value:Chief Technology Officer, c8b60fe7-f5f6-4fd4-a918-61435ec5a57c, value:senior engineer, value:engineering lead, value:junior software engineer
  - subject a3844e23-198c-4c8e-af29-163df7855613 holds 3 active facts in exclusive group 'role_title' with distinct objects: value:engineering lead, value:head of engineering, value:Engineering Lead
  - subject 234a5b48-dfe0-4887-a4cc-d798ae714acd holds 2 active facts in exclusive group 'org_hq' with distinct objects: 6c7a1606-4cf0-4e8c-9917-fab243b754ef, fc3e40f5-016e-4642-844e-56375d5b183f
- PASS [error] causalJustification — Every causal edge has non-empty reasoning + source_references and is not a self-loop.
- PASS [error] referentialIntegrity — All fact/event/edge/contradiction/same_as foreign keys resolve to existing rows.
- PASS [warning] objectValueNotSentence — Active literal object_values should be values, not sentences (<= 64 chars and <= 12 words).
- PASS [info] orphanEntities — Entities referenced by no active fact (as subject or object).

## Per-step instrumentation

### serial.forward

- contradictions: detected 8 during ingest, reflected 8 in final table, gap 0
- contradictions by status: 3 resolved / 0 dismissed / 5 active
- supersession: 9 expired / 53 active facts
- causal edges: 18 active / 1 expired
- same_as merges: 0; entities 21; facts 62

### serial.reverse

- contradictions: detected 6 during ingest, reflected 6 in final table, gap 0
- contradictions by status: 6 resolved / 0 dismissed / 0 active
- supersession: 13 expired / 56 active facts
- causal edges: 9 active / 2 expired
- same_as merges: 0; entities 18; facts 69

## Reports review

### serial.forward (0 discrepancies)

- reports: 20 extraction / 4 gardening / 3 reasoning
- reasoning by mode: patrol=3; thin/patrol-only: 3/3
- gardening actions total: 0
- no report-vs-graph discrepancies.

### serial.reverse (0 discrepancies)

- reports: 20 extraction / 3 gardening / 6 reasoning
- reasoning by mode: patrol=6; thin/patrol-only: 3/6
- gardening actions total: 0
- no report-vs-graph discrepancies.

## Snapshots

- serial.forward: `serial.forward.canonical.json` / `serial.forward.rich.json`
- serial.reverse: `serial.reverse.canonical.json` / `serial.reverse.rich.json`

## Trend

Comparing run `2026-06-03T07-41-59-985Z` (commit `8daa8e3`) vs `2026-06-03T06-34-34-476Z` (commit `80d203c`).

- serial:
  - current-state-correctness: 0.67 -> 0.75 (Δ +0.08)
  - invariant pass-rate: 1.00 -> 0.67 (Δ -0.33)
  - fact F1 vs gold: 0.18 -> 0.19 (Δ +0.01)
  - determinism F1 (fact): - -> - 
  - litmus F1 (fact): 0.18 -> 0.28 (Δ +0.10)
  - throughput ms: 1714476.00 -> 3554575.00 (Δ +1840099.00)
  - predicate-sprawl: 0.00 -> 0.00 (Δ 0.00)
