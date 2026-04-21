# Test Data Hardening Protocol — Recursive Agentic Improvement Loop

**Parent:** [10 — Reasoning Layer Overview](10-reasoning-layer-overview.md)
**Status:** Foundational — all implementation phases depend on this protocol
**Depends on:** Nothing (precedes Phase 0)
**Blocks:** All phases (they reference specific data sets)

## Purpose

Unit tests with hardcoded inputs prove that *code* does what the test author expected. They do not prove that the *system* works in the presence of realistic data, adversarial inputs, or the emergent behaviour of agentic pipelines.

This document defines the test data strategy for the reasoning layer:

1. **Curated, versioned data sets** — per component, stored in-repo, reviewable in PR
2. **The Recursive Hardening Loop** — an agentic protocol that runs tests, analyses failures, improves data, and re-runs until quality thresholds are met
3. **Benchmark framework** — measurable quality metrics that track improvement across iterations
4. **Progressive complexity** — each data set starts simple and evolves to cover edge cases as earlier ones pass
5. **Component isolation, then integration, then end-to-end** — a stack of test sets that verify increasingly broad scopes

Without this, we ship phases that compile but don't work under real load.

## Why This Matters More for Agentic Systems

Traditional software has deterministic behaviour. Given input X, output Y. Tests assert Y.

Agentic systems have **emergent behaviour**. The reasoning agent decides which tools to call, in what order, with what arguments. Two runs against the same data can produce different tool sequences. A change in prompt wording or tool schema can cascade into completely different reasoning paths.

Unit tests can verify that individual tools behave correctly. They cannot verify that the **agent**, given a question, produces a good answer — that requires evaluating:
- Does it call the right tools?
- Does it use enough tools (not too few, not too many)?
- Does the final answer cite evidence from the graph?
- Does it enrich the graph with justified edges rather than fabricating?
- When presented with contradictory data, does it pick sensibly?

These questions need **labelled data** (input + expected behaviour) and **benchmarks** (aggregate scores across many inputs). That's what this protocol delivers.

## The Recursive Hardening Loop

```d2
direction: down

design: "1. DESIGN DATA SET\nstart simple — cover happy path\nfixtures checked into repo" {
  shape: step
  style.fill: "#cfe8ff"
}

run: "2. RUN TESTS\nagainst current implementation\nrecord pass/fail + metrics" {
  shape: step
  style.fill: "#d4edda"
}

analyse: "3. ANALYSE RESULTS" {
  shape: step
  style.fill: "#fff3cd"
}

branch: "ALL PASS?" {
  shape: diamond
  style.fill: "#e6d9ec"
}

improve_code: "4a. IMPROVE CODE\ntest revealed bug / gap\nfix implementation\n→ back to step 2" {
  shape: step
  style.fill: "#f8d7da"
}

improve_data: "4b. IMPROVE DATA\nadd complexity — edge cases,\nadversarial inputs, scale\n→ back to step 2" {
  shape: step
  style.fill: "#d4edda"
}

benchmark: "5. RECORD BENCHMARK\ndata set version + metrics + date\nin benchmark-reports/" {
  shape: step
  style.fill: "#cfe8ff"
}

nextlevel: "6. GRADUATE\ncomponent → integration\nintegration → pipeline\npipeline → end-to-end" {
  shape: step
  style.fill: "#e6d9ec"
}

design -> run
run -> analyse
analyse -> branch
branch -> improve_code: "no — bug"
branch -> improve_data: "yes — solid"
improve_code -> run
improve_data -> run
improve_data -> benchmark: "complexity\nplateaus"
benchmark -> nextlevel
```

Two failure modes, two fixes:
- **Tests fail → improve the code.** The data exposed a real bug. Fix it. Re-run.
- **Tests pass → improve the data.** The current set is too easy. Add edge cases, increase scale, inject adversarial patterns. Re-run.

The loop terminates when data complexity has plateaued — the agent / code handles increasingly hard scenarios without regression, and adding more complexity yields no new insight.

## Data Set Types

Four levels of test data. Each component or phase produces sets at level 1 first, then ascends.

### Level 1 — Component Data

Targets a single service function or SQL query.

**Scope:** One file of fixtures. Loaded directly into test DB via helpers.
**Format:** JSON or SQL dump checked into `platform/src/test/data/<phase>/<component>/`.
**Verification:** Deterministic. Function F with input I produces output O.
**Examples:**
- `Phase 1 / audit.ts`: a set of fact mutations with expected history row contents
- `Phase 3 / findEdgesCitingReference`: a graph with 5 facts, 3 edges citing fact A, 2 edges citing fact B — verify lookup returns correct subsets
- `Phase 6 / normalise_chain`: 10 concrete chains with expected templates

### Level 2 — Integration Data

Targets a full service or MCP tool invocation.

**Scope:** Multiple services exercised together. DB seeded with a realistic neighbourhood.
**Format:** SQL seed + expected MCP tool response shape.
**Verification:** Mostly deterministic, but may assert on shape rather than exact values.
**Examples:**
- `Phase 2 / createCausalEdge corroboration`: 10-edge graph, create duplicate, assert edge count + corroboration_count + history length
- `Phase 4 / analyzeImpact`: 50-entity graph, run impact from a central fact, assert severity distribution
- `Phase 5 / detectContradictions`: pre-loaded opposing-object scenarios, run detection, assert contradictions table contents

### Level 3 — Pipeline Data

Targets end-to-end ingest → extract → reason flow.

**Scope:** Source documents + expected graph state + expected reasoning report content.
**Format:** `.txt` or `.md` source files + JSON manifest of assertions.
**Verification:** Non-deterministic for agent paths; use property-based assertions (contains X, has >= N edges, no expired-but-cited contradictions).
**Examples:**
- `ingest MISRA rule chapter → expect N entities, M facts, at least 3 causal edges`
- `reasoning patrol on a known neighbourhood → expect contradictions resolved, no fabricated facts`

### Level 4 — End-to-End / Benchmark Data

Targets the full system against realistic workloads.

**Scope:** Curated corpora (MISRA C++ 2023 is anchor; add others over time).
**Format:** Full document set + ground-truth benchmark queries with expected answers.
**Verification:** Benchmark-scored. Compare agent responses against expected via semantic similarity + structured fact matching.
**Examples:**
- `Bad code sample (test-bad-code.cpp) → query: "which MISRA rules does this violate?" → expected: enumerated rule IDs with evidence`
- `Ingest 10 MISRA chapters → detect N patterns, identify X ghosts, resolve Y contradictions`

## Data Set Structure (Repo Layout)

```
platform/src/test/data/
├── README.md                          # protocol summary, how to run
├── common/                            # shared helpers and fixtures
│   ├── entities.json                  # common entity types
│   └── predicates.json                # known predicate categories
├── phase1-audit/
│   ├── fixtures/
│   │   ├── simple-mutations.sql       # level 1
│   │   ├── concurrent-races.sql       # level 1 edge
│   │   └── actor-escalation.sql       # level 2
│   ├── expected/
│   │   └── simple-mutations.expected.json
│   └── benchmark-reports/
│       ├── 2026-04-20-simple.md
│       └── 2026-04-20-concurrent.md
├── phase2-lifecycle/
│   └── ...
├── phase3-sourcerefs/
│   └── ...
├── phase4-blastradius/
│   ├── fixtures/
│   │   ├── small-graph-50.sql         # level 1
│   │   ├── cycle-topology.sql         # level 1 edge
│   │   ├── realistic-neighbourhood.sql # level 2
│   │   └── misra-chapter.sql          # level 3
│   └── expected/
│       └── small-graph-50.expected.json
├── phase5-contradictions/
│   └── ...
├── phase6-patterns/
│   ├── fixtures/
│   │   ├── three-identical-chains.sql     # level 1 — minimum for staging
│   │   ├── noisy-similar-chains.sql       # level 1 edge — near-templates
│   │   ├── pattern-with-ghost-target.sql  # level 2
│   │   └── pattern-emergence-corpus.sql   # level 3
│   └── expected/
│       └── ...
└── integration/
    ├── full-pipeline/                  # level 3
    │   ├── misra-ch6-source.md
    │   ├── expected-entities.json
    │   ├── expected-facts.json
    │   └── expected-reasoning.md
    └── end-to-end/                     # level 4
        ├── bad-cpp-scenarios/
        │   ├── test-bad-code.cpp      # already exists
        │   ├── triple-pointer.cpp
        │   ├── dead-code.cpp
        │   └── expected-violations.json
        └── benchmark-queries.json
```

### Fixture Format — SQL Seeds

Deterministic, version-controlled. One file per scenario.

```sql
-- platform/src/test/data/phase1-audit/fixtures/simple-mutations.sql
-- Scenario: three facts created by graph_agent, one revised by reasoning_agent

BEGIN;
SET LOCAL session_replication_role = 'replica';  -- skip triggers for fast load

INSERT INTO entities (id, canonical_name, entity_type, embedding, confidence)
VALUES
  ('00000000-0000-0000-0000-000000000001', 'John', 'person', random_embedding(), 1.0),
  ('00000000-0000-0000-0000-000000000002', 'Acme', 'company', random_embedding(), 1.0);

INSERT INTO facts (id, subject_entity_id, predicate, object_entity_id, confidence, valid_at)
VALUES
  ('10000000-0000-0000-0000-000000000001',
   '00000000-0000-0000-0000-000000000001', 'works_at',
   '00000000-0000-0000-0000-000000000002', 0.8, NOW());

COMMIT;
```

### Expected Format — JSON Assertions

```json
{
  "scenario": "simple-mutations",
  "description": "Fact created by graph_agent, revised by reasoning_agent",
  "assertions": [
    {
      "type": "fact_history_count",
      "fact_id": "10000000-0000-0000-0000-000000000001",
      "expected": 2,
      "because": "one 'created' + one 'confidence_raised'"
    },
    {
      "type": "fact_history_sequence",
      "fact_id": "10000000-0000-0000-0000-000000000001",
      "expected": ["created", "confidence_raised"],
      "ordering": "reverse_chronological"
    },
    {
      "type": "actor_distribution",
      "expected": { "graph_agent": 1, "reasoning_agent": 1 }
    }
  ]
}
```

### Benchmark Report Format

One markdown file per run, named `YYYY-MM-DD-<scenario>.md`:

```markdown
# Phase 1 Audit — simple-mutations (2026-04-20)

## Setup
- Data set version: v1
- Fixture: platform/src/test/data/phase1-audit/fixtures/simple-mutations.sql
- Code commit: <git sha>

## Results
- Tests passed: 8 / 8
- Duration: 342ms
- DB state after: 2 entities, 1 fact, 2 history rows

## Metrics
| Metric | Value | Target | Pass |
|--------|-------|--------|------|
| Mutation → audit latency | 7ms | <10ms | ✓ |
| History query (100 rows) | 23ms | <50ms | ✓ |
| Correct actor attribution | 100% | 100% | ✓ |

## Findings
None. All assertions passed. Recommendation: graduate to complexity v2 (concurrent-races scenario).

## Next Iteration
- Add concurrent-races scenario
- Target: 100 concurrent createFact calls, verify no lost audit rows
```

## Benchmark Framework — Quality Metrics

Each test level has quantitative quality metrics. These are the **qualifiers for improvement** — a new data set version must not regress against previous benchmarks.

### Level 1 Metrics (Component)

| Metric | Definition | Target |
|--------|-----------|--------|
| Correctness rate | % of assertions passing | 100% |
| Latency p50 | median operation time | component-specific (see doc 10) |
| Latency p99 | 99th percentile | component target × 3 |

### Level 2 Metrics (Integration)

Level 1 + :

| Metric | Definition | Target |
|--------|-----------|--------|
| Shape correctness | JSON structure matches schema | 100% |
| Value correctness | Key field values match expected | 100% (deterministic) or ≥ threshold (probabilistic) |
| Cross-component consistency | No orphan refs, no drift | 100% |

### Level 3 Metrics (Pipeline)

| Metric | Definition | Target |
|--------|-----------|--------|
| Entity recall | % of expected entities appearing in output | ≥ 90% |
| Entity precision | % of output entities that match expected | ≥ 85% |
| Fact triple F1 | F1 on (subject, predicate, object) matches | ≥ 0.80 |
| Causal edge F1 | F1 on created causal edges | ≥ 0.70 |
| No-fabrication rate | % of outputs with zero invented facts | 100% |
| End-to-end latency | full ingest + reason | ≤ 30s per chunk |

### Level 4 Metrics (End-to-End Benchmark)

| Metric | Definition | Target |
|--------|-----------|--------|
| Question-answer accuracy | semantic similarity to expected answer | ≥ 0.80 |
| Evidence grounding | % of answers citing graph facts/edges | ≥ 90% |
| Rule citation recall | % of MISRA rules correctly identified in violation queries | ≥ 75% |
| Graph coherence | no orphaned entities, no contradictions at end of run | 100% |

### Progression Gate

A data set is **graduated** (stable at its current level) when:
- All metrics meet target
- Last 3 consecutive runs on different random seeds pass
- At least one edge-case fixture added since last graduation passes

Until then, the protocol keeps iterating.

## Agentic Data-Improvement Skill (Future)

The user is building a skill that automates the loop. Rough shape:

```d2
direction: right

skill: "test-harden skill" {
  inputs: "Inputs:\n- component name\n- current data set version\n- previous benchmark"
  outputs: "Outputs:\n- new data set version\n- new benchmark report\n- issues found"
}

step1: "1. Generate\ncomplexity bumps" {
  shape: step
}

step2: "2. Run tests\non enhanced data" {
  shape: step
}

step3: "3. Analyse\nfailures" {
  shape: step
}

step4a: "4a. Propose\ncode fix issues\n(beads)" {
  shape: step
  style.fill: "#f8d7da"
}

step4b: "4b. Approve\nnew data tier" {
  shape: step
  style.fill: "#d4edda"
}

step5: "5. Commit\ndata + benchmark" {
  shape: step
}

skill -> step1 -> step2 -> step3
step3 -> step4a: "failures"
step3 -> step4b: "all pass"
step4a -> step5
step4b -> step5
step5 -> skill: "next iteration"
```

Required capabilities for the skill (listed here so phase docs can reference them):

1. **Fixture generation** — produce SQL seeds from a scenario description (e.g., "graph with 5 entities, 3 cycles, 1 high-corroboration edge")
2. **Assertion generation** — given fixture + code path, predict expected output
3. **Test execution** — run `pnpm vitest run <file>` and parse results
4. **Metric extraction** — aggregate pass/fail + timing into benchmark format
5. **Complexity escalation** — given passing set, produce a harder variant (more data, adversarial cases, injected faults)
6. **Failure analysis** — given a failure, classify as: data bug, test bug, code bug, prompt bug
7. **Issue creation** — use `bd create` to log code-bug findings
8. **Report writing** — produce the benchmark markdown

The skill is out of scope for the reasoning-layer docs. But **every phase doc must specify its data sets**, because the skill needs them as input.

## Per-Phase Data Set Requirements

Each phase ships with at least Level 1 and Level 2 fixtures. Level 3 integration fixtures span multiple phases. Level 4 is anchored by MISRA.

| Phase | Level 1 Fixtures | Level 2 Fixtures | Level 3 Scope |
|-------|-----------------|------------------|---------------|
| 1 — Audit | simple mutations, concurrent races, invalid actors | actor-escalation, cascade writes | ingest-then-audit flow |
| 2 — Lifecycle | single corroboration, repeated corroborations, boundary-age decay, cascade from expired | realistic graph with mixed-age edges | ingest loop with reasoning patrols |
| 3 — Source refs | single ref, multi-ref, duplicate ref | 1000-edge reverse lookup stress | edge creation → index sync → query |
| 4 — Blast radius | small graph (5 nodes), cycle topology, orphan node | 500-entity realistic neighbourhood | MISRA chapter impact analysis |
| 5 — Contradictions | each of 4 heuristic types, near-contradictions, exclusive predicates | reasoning resolution scenarios | full patrol with contradiction resolution |
| 6 — Patterns | 3 identical chains, noisy similar chains, partial chains for ghost detection | pattern emergence over time | MISRA corpus for ghost detection |

Details in each phase doc's "Test Data Requirements" section (to be added by Phase docs).

## Adversarial / Hardening Scenarios

At each level, include adversarial fixtures — inputs designed to expose weaknesses:

- **Audit**: mutation flood (1000 updates to same fact), actor spoofing attempts, timing attacks on `occurred_at`
- **Lifecycle**: corroboration storm (same edge asserted 100 times), decay timer manipulation, cascade from multi-cited facts
- **Source refs**: duplicate refs with different relevance text, refs to non-existent IDs, JSONB corruption
- **Blast radius**: deep cycles (depth 20+), fan-out explosion (node with 1000 citations), hypothetical chain attacks
- **Contradictions**: contradictions that arrive in specific orderings, resolutions that create new contradictions, exclusive-predicate edge cases
- **Patterns**: pattern-poisoning chains (identical-but-meaningless), ghost-flooding (request ghosts for high-fan-out entity), promotion race conditions

Each adversarial fixture is **isolated in its own file** with a description of what it targets. When a test uncovers a real bug, the fixture becomes a permanent regression test.

## Domain Anchor — MISRA C++ 2023

The test corpus for Level 3/4 is grounded in MISRA C++ 2023 because:
1. It's the data currently loaded (~159 entities, ~290 facts)
2. The structure is known and bounded — finite rules with clear hierarchies
3. `test-bad-code.cpp` exists as an adversarial input
4. Expected violations are specifiable — each MISRA rule has clear trigger conditions

Future corpora (for diversity): NASA JPL coding standards, MIL-STD-498 documentation, medical device regulations. Each adds different causal patterns and relationship structures.

## Beads Issues

Not yet created in beads — this protocol needs to be reviewed and refined before per-phase data work is scoped.

**Template epic:** `TEST-EPIC-RLH` — Test Data Hardening for Reasoning Layer

**Template per-phase child:** `TEST-Pn-DATA` — Data set iteration for Phase n (replace n)

Each per-phase child contains sub-tasks:
- `TEST-Pn-L1` — Level 1 fixtures + benchmarks
- `TEST-Pn-L2` — Level 2 fixtures + benchmarks
- `TEST-Pn-L3` — Level 3 fixtures + benchmarks (if applicable)
- `TEST-Pn-HARDEN` — Adversarial fixtures

## Acceptance for This Protocol

This document is not "done" when written — it's done when:

- [ ] A Level 1 fixture exists for every phase (minimum)
- [ ] A benchmark report template is checked into `platform/benchmark-reports/`
- [ ] At least one phase has demonstrated the recursive loop end-to-end (design → run → analyse → improve → benchmark)
- [ ] The test-harden skill exists and has been used once to graduate a Level 1 set to Level 2
- [ ] The skill's output format (benchmark markdown, beads issues) is fixed

Until those are met, this is a specification — not yet a running process.

## Relationship to Individual Phase Docs

Each phase doc's "Test Design" section currently specifies unit test coverage. **It must be extended** to also specify:
- Required Level 1 fixtures (with filenames)
- Required Level 2 fixtures
- Expected benchmark metrics
- Adversarial scenarios specific to that phase

A follow-up update pass will add this to phase docs 12-17.

## Open Questions

1. **Where do benchmark reports live?** Proposal: `platform/benchmark-reports/reasoning-layer/<phase>/`. Check in every report. PR comments surface regressions.
2. **How is ground truth maintained for probabilistic metrics?** Answer: human-curated at Level 3, versioned, reviewed in PR.
3. **What's the threshold for graduating a level?** Proposal: 3 consecutive clean runs on different seeds + one edge-case fixture passing.
4. **Do agents need their own test sets?** Yes — "reasoning agent patrol quality" is its own benchmark, distinct from any single phase's tests. To be defined as the skill matures.
5. **How do we version data sets?** Proposal: `v1`, `v2`, ... semver-ish. Breaking changes (fixture rename, assertion change) bump major; adding fixtures bumps minor.

## Next Actions

1. Review this protocol (current iteration)
2. Add "Test Data Requirements" section to each phase doc (subsequent iterations)
3. Create beads tracking for per-phase data work
4. User writes the test-harden skill (out of scope here; runs in parallel)
5. First phase to adopt the protocol: Phase 1 (audit) — smallest scope, clearest metrics
