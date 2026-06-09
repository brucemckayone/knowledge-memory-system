# Comparison run 2026-06-09T09-02-15-350Z

- commit: `bc379fa`
- corpus: corpus20.json (20 chunks)
- modes: epoch | orders: forward, reverse
- model: glm-5-turbo

## Structural scorecard (exact)

| mode | wallMs | ents | facts | dupEnt | dupFact | litmus | vsBaseline(match/extraF/missF) |
|---|---|---|---|---|---|---|---|
| epoch | 1759472 | 16 | 47 | 0 | 0 | false | baseline |

## Semantic scorecard (entityF1/factF1)

| mode | determinism | litmus(fwd/rev) | vsBaseline |
|---|---|---|---|
| epoch | - | 0.94/0.23 | baseline |

## Correctness vs gold

### epoch.forward vs gold (`corpus20.json`)

- entity F1: 1.00 (P 1.00 / R 1.00)
- current-fact F1: 0.14 (P 0.09 / R 0.40)
- current-state correctness: 0.38 (3/8 exclusive expectations)
- failing exclusive expectations:
  - Elena Vasquez [role_title]: expected `chief technology officer`, got 1 active (helix robotics)
  - Daniel Okoro [role_title]: expected `vp of product`, got 1 active (helix robotics)
  - Sofia Reyes [role_title]: expected `partner`, got 0 active (none)
  - Sofia Reyes [works_at]: expected `Northwind Capital`, got 0 active (none)
  - Helix Robotics [org_hq]: expected `Austin`, got 1 active (boston, massachusetts)
- predicate sprawl: none

### epoch.reverse vs gold (`corpus20.json`)

- entity F1: 0.94 (P 0.94 / R 0.94)
- current-fact F1: 0.12 (P 0.07 / R 0.40)
- current-state correctness: 0.38 (3/8 exclusive expectations)
- failing exclusive expectations:
  - Elena Vasquez [role_title]: expected `chief technology officer`, got 1 active (helix robotics)
  - Elena Vasquez [works_at]: expected `Helix Robotics`, got 0 active (none)
  - Daniel Okoro [role_title]: expected `vp of product`, got 1 active (helix robotics)
  - Sofia Reyes [role_title]: expected `partner`, got 1 active (northwind capital)
  - Priya Anand [role_title]: expected `startup ceo`, got 2 active (helix robotics, startup ceo)
- predicate sprawl: none

## Invariants

### epoch.forward (4/5 pass, 1 error rows)

- FAIL [error] singleActivePerExclusiveGroup — At most one active fact per (subject, exclusive predicate group); supersession should expire the rest.
  - subject f73eafc6-09cb-402a-b467-47559c316e31 holds 2 active facts in exclusive group 'works_at' with distinct objects: 74a498de-2ad8-44ad-af0a-47509d4cfb15, 075b024b-70be-41a9-8d04-b86859da386d
- PASS [error] causalJustification — Every causal edge has non-empty reasoning + source_references and is not a self-loop.
- PASS [error] referentialIntegrity — All fact/event/edge/contradiction/same_as foreign keys resolve to existing rows.
- PASS [warning] objectValueNotSentence — Active literal object_values should be values, not sentences (<= 64 chars and <= 12 words).
- PASS [info] orphanEntities — Entities referenced by no active fact (as subject or object).

### epoch.reverse (3/5 pass, 2 error rows)

- FAIL [error] singleActivePerExclusiveGroup — At most one active fact per (subject, exclusive predicate group); supersession should expire the rest.
  - subject 473088a7-03a6-45cc-9a3f-25a80e7e9702 holds 2 active facts in exclusive group 'works_at' with distinct objects: 8b923354-a46a-4f4c-8d8e-0f32bac0a080, e7639627-2b77-4711-84fb-ce2bdad8624c
  - subject 473088a7-03a6-45cc-9a3f-25a80e7e9702 holds 2 active facts in exclusive group 'role_title' with distinct objects: 8b923354-a46a-4f4c-8d8e-0f32bac0a080, value:startup CEO
- PASS [error] causalJustification — Every causal edge has non-empty reasoning + source_references and is not a self-loop.
- PASS [error] referentialIntegrity — All fact/event/edge/contradiction/same_as foreign keys resolve to existing rows.
- PASS [warning] objectValueNotSentence — Active literal object_values should be values, not sentences (<= 64 chars and <= 12 words).
- FAIL [info] orphanEntities — Entities referenced by no active fact (as subject or object).
  - entity d12460e5-83d1-4c12-bd12-a517648e5ab0 (Boston) is referenced by no active fact

## Per-step instrumentation

### epoch.forward

- contradictions: detected 3 during ingest, reflected 3 in final table, gap 0
- contradictions by status: 3 resolved / 0 dismissed / 0 active
- supersession: 10 expired / 47 active facts
- causal edges: 18 active / 2 expired
- same_as merges: 0; entities 16; facts 57

### epoch.reverse

- contradictions: detected 4 during ingest, reflected 4 in final table, gap 0
- contradictions by status: 4 resolved / 0 dismissed / 0 active
- supersession: 12 expired / 57 active facts
- causal edges: 13 active / 0 expired
- same_as merges: 0; entities 16; facts 69

## Reports review

### epoch.forward (4 discrepancies)

- reports: 20 extraction / 3 gardening / 8 reasoning
- reasoning by mode: patrol=8; thin/patrol-only: 3/8
- gardening actions total: 0
- discrepancies:
  - [dangling_reference/reasoning] reasoning report 4f29b743-6a01-42fd-875e-586a7c240efe references missing entity 28eeb10b-5e74-4d41-9dda-60c4cbce82b4
  - [dangling_reference/reasoning] reasoning report 91b4f93d-c4c3-44bb-9eac-6f336467510e references missing entity c234aa22-0230-494f-89ce-5eed1a437604
  - [dangling_reference/reasoning] reasoning report 91b4f93d-c4c3-44bb-9eac-6f336467510e references missing entity 969e9b89-d779-4704-b433-9a376a717d8c
  - [dangling_reference/reasoning] reasoning report 96147a55-a541-421a-aee3-d8d745397638 references missing entity 28eeb10b-5e74-4d41-9dda-60c4cbce82b4

### epoch.reverse (13 discrepancies)

- reports: 20 extraction / 4 gardening / 10 reasoning
- reasoning by mode: patrol=10; thin/patrol-only: 3/10
- gardening actions total: 0
- discrepancies:
  - [dangling_reference/reasoning] reasoning report 11fb7e72-51f2-4a83-bc18-e48e0d09ae93 references missing entity 45f18c7c-32c7-4216-9ff4-e08d1574fa09
  - [dangling_reference/reasoning] reasoning report 11fb7e72-51f2-4a83-bc18-e48e0d09ae93 references missing entity 705bc448-d1d0-4867-8fba-167689737ca1
  - [dangling_reference/reasoning] reasoning report 11fb7e72-51f2-4a83-bc18-e48e0d09ae93 references missing entity c9a18c65-65f1-43ce-a746-731b17098066
  - [dangling_reference/reasoning] reasoning report 89db78c3-fc61-4ce5-ba7b-fae78b584763 references missing entity 84b5f544-b56f-4c37-afb7-7a6e042a47ce
  - [dangling_reference/reasoning] reasoning report 89db78c3-fc61-4ce5-ba7b-fae78b584763 references missing entity 0caf2fe5-919e-4341-b162-b6240af4d214
  - [dangling_reference/reasoning] reasoning report 89db78c3-fc61-4ce5-ba7b-fae78b584763 references missing entity ecc8f2ea-c404-4306-9f5d-1af432e059dd
  - [dangling_reference/reasoning] reasoning report 89db78c3-fc61-4ce5-ba7b-fae78b584763 references missing entity 8fe8e724-8033-48e2-9088-47a06b330002
  - [dangling_reference/reasoning] reasoning report 89db78c3-fc61-4ce5-ba7b-fae78b584763 references missing entity e9b7ee15-82c2-40f1-82b3-85d3bd63767b
  - [dangling_reference/reasoning] reasoning report bff87ef6-3a29-43cf-b4a2-571eb0feebde references missing entity ecc8f2ea-c404-4306-9f5d-1af432e059dd
  - [dangling_reference/reasoning] reasoning report bff87ef6-3a29-43cf-b4a2-571eb0feebde references missing entity e9b7ee15-82c2-40f1-82b3-85d3bd63767b
  - [dangling_reference/reasoning] reasoning report bff87ef6-3a29-43cf-b4a2-571eb0feebde references missing entity 84b5f544-b56f-4c37-afb7-7a6e042a47ce
  - [dangling_reference/reasoning] reasoning report bff87ef6-3a29-43cf-b4a2-571eb0feebde references missing entity 0caf2fe5-919e-4341-b162-b6240af4d214
  - [sameas_overclaim/gardening] gardening report 4a5f2c7a-ee56-4b4f-8d7e-bb0e019859b8 claims 1 same_as created but graph holds 0 (counts may be cumulative across runs)

## Snapshots

- epoch.forward: `epoch.forward.canonical.json` / `epoch.forward.rich.json`
- epoch.reverse: `epoch.reverse.canonical.json` / `epoch.reverse.rich.json`

## Trend

Comparing run `2026-06-09T09-02-15-350Z` (commit `bc379fa`) vs `2026-06-03T07-41-59-985Z` (commit `8daa8e3`).

- epoch (new arm — no prior):
  - current-state-correctness: - -> 0.38
  - invariant pass-rate: - -> 0.67
  - fact F1 vs gold: - -> 0.14
  - determinism F1 (fact): - -> - 
  - litmus F1 (fact): - -> 0.23
  - throughput ms: - -> 1759472.00
  - predicate-sprawl: - -> 0.00
