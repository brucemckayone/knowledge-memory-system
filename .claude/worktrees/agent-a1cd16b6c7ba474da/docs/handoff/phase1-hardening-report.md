# Phase 1 Hardening Report — `nmemo-klv.9`

**Date:** 2026-04-20
**Branch:** `feat/reasoning-agent`
**Task:** `nmemo-klv.9` — HARDEN-P1 (evolve Phase 1 test fixtures before implementation)
**Scope:** Fixtures + expected JSONs + scenario state + this handoff report. **No production code changes.**

## Mode of operation

The `test-harden` skill's end-to-end pipeline assumes production code exists so tests can run. Phase 1 code (`nmemo-w4j`) has not landed yet. Per the task prompt, this run operates in **evolve-only mode** executed manually:

- `scenario-state.py init` populated state for each of the 5 scenarios
- The Data Evolver subagent was invoked once per scenario in an isolated context via the `Agent` tool
- Each subagent received only: phase spec excerpts (doc 12), the data-evolver prompt, the existing scaffold where present, adversarial-scenario guidance, and UUID/schema conventions — **never** production code
- Subagent output (SQL + expected JSON) was applied by the orchestrator, with light column-name normalization where the subagent guessed schema details (see "Orchestrator corrections" below)
- Each scenario committed separately (`harden-p1: <scenario> v<N> — <line>`)

SKILL-04 (live `--evolve-only` Data Evolver invocation glue) remains open (`nmemo-klv.8.4`). This run is the manual analogue.

## What landed

5 scenarios, 14 fixtures, 5 expected JSONs:

| Scenario | Level | Main fixture | Adversarial variants (MUST FAIL) | Non-adversarial stressor variants | Complexity |
|---|---|---|---|---|---|
| `simple-mutations` | L1 → evolved to L1.1 | `simple-mutations.sql` | `simple-mutations-timing-attack.sql`, `simple-mutations-empty-reasoning.sql` | — | 14 |
| `concurrent-races` | L1 (new) | `concurrent-races.sql` | `concurrent-races-dup-factid.sql`, `concurrent-races-actor-spoofing.sql` | `concurrent-races-flood.sql` | 32 |
| `actor-escalation` | L2 (new) | `actor-escalation.sql` | `actor-escalation-wrong-actor-for-cascade.sql`, `actor-escalation-unknown-actor.sql` | — | 24 |
| `cascade-writes` | L2 (new) | `cascade-writes.sql` | `cascade-writes-orphan-cascade.sql`, `cascade-writes-cascade-without-parent.sql` | — | 39 |
| `invalid-actors` | L1 adversarial-suite (new) | `invalid-actors.sql` (10-case MUST-FAIL suite) | `invalid-actors-event-type.sql`, `invalid-actors-case-sensitivity.sql` | — | 105 |

**Counts against success criteria:**
- 5 scenarios hardened ✓
- ≥ 2 adversarial variants per scenario (10 total) ✓
- Complexity scored per fixture, header-documented ✓
- Each MUST-FAIL variant has `-- MUST FAIL: <reason>` on line 1 ✓
- Stressor regions tagged `-- STRESSOR: <axis>=<value>` ✓
- Summary report (this file) committed ✓

## Per-scenario notes

### 1. `simple-mutations` v1.0 → v1.1

**Axes pushed:** event-type breadth (3 → 6 of 8 enum values), actor diversity (2 → 7 of 7), FK integrity (reasoning_report_id, causal_event_id non-null rows).

**Rationale:** The L1 scaffold exercised only 3/8 event types and 2/7 actors — insufficient to act as a regression test for the "every actor attributable, every event_type captured" criterion. Pushing to 6 event types and all 7 actors in one fixture is still small enough to keep L1 complexity (14) but is the minimum useful coverage of the fact-lifecycle state diagram in doc 12.

**Adversarials:**
- `timing-attack` exercises the `occurred_at` far-past / far-future scenario from doc 12's adversarial list
- `empty-reasoning` exercises the "empty reasoning rejected at service layer" criterion, including whitespace-only as a separate sub-case (DB NOT NULL does not catch `'   '`)

### 2. `concurrent-races` v1.0 (new)

**Axis:** Concurrency (100 parallel writes) + fan-out (10×10 entity pool).

**Rationale:** The benchmark metric "No lost audit rows under concurrent load — 100%" has no sitting fixture. Main fixture pre-seeds a pool and declares a harness contract (100 workers, distinct fact UUIDs, predicate pool). Stressor variant `concurrent-races-flood.sql` takes the mutation axis to 1000 on a single fact (this is a hardening stressor, not adversarial — all writes MUST survive). Adversarials probe the two named-and-likely failures: (a) duplicate fact_id under collision (99 losers must raise), (b) direct-INSERT actor spoofing (`'attacker_script'` → CHECK rejection).

### 3. `actor-escalation` v1.0 (new)

**Axis:** Domain-realistic + cross-actor sequence.

**Rationale:** doc 12 lists `multi-actor.sql` (L1) and `actor-escalation.sql` (L2). This single L2 fixture folds both by pre-seeding only the first actor's row (`graph_agent`/`created`) and declaring a 7-step harness-driven sequence that cycles through all remaining actors. Tests actor attribution under handoff and the `cascade`-actor requires-causal_event_id business rule.

**Adversarials:**
- `wrong-actor-for-cascade` — cascade row with NULL causal_event_id AND NULL reasoning_report_id (business-rule violation; DB may allow, test layer must catch)
- `unknown-actor` — direct DB-level CHECK rejection of `actor='hacker'`

### 4. `cascade-writes` v1.0 (new)

**Axis:** Cascade fan-out + selectivity (2-of-3).

**Rationale:** The Phase 1 cascade path (expiring an upstream fact → cascade edge_history rows with `actor=cascade`) has no fixture. The seed constructs three edges with different citation patterns (upstream-only, mixed, independent-only) so a single `expireFact` call exercises each selectivity outcome. Asserts `reasoning_report_id` flows from parent fact mutation through to child cascade rows — a frontend for the atomicity criterion.

**Adversarials:**
- `orphan-cascade` — cascade row with a phantom `reasoning_report_id` → FK violation (SQLSTATE 23*)
- `cascade-without-parent` — NULL `reasoning_report_id` + no upstream mutation → business-rule assertion failure (DB allows NULL; test layer must flag)

### 5. `invalid-actors` v1.0 (new — adversarial-first)

**Axis:** Adversarial-structural, entirely. Main fixture is itself a 10-case MUST-FAIL suite because a positive-path fixture wouldn't exercise the "DB constraints reject invalid event_type/actor" criterion.

**Structure:** Each case is wrapped `BEGIN; INSERT…; ROLLBACK;` with `-- CASE N` + `-- EXPECTED:` markers the harness parses and runs independently. Covers: unknown actor, SQL-injection, VARCHAR(32) overflow, unknown event_type, whitespace reasoning, NULL reasoning, empty-string actor, TAB-prefixed actor, NULL actor, case-variant actor.

Variants `event-type` and `case-sensitivity` isolate their specific failure surface so a regression in one axis can't be hidden by a pass on another.

## Orchestrator corrections (light normalization)

The Data Evolver subagents necessarily guessed schema details without reading code. The orchestrator made narrow, mechanical corrections before writing, matching the known-good scaffold (`simple-mutations.sql` v1.0) as the column-name reference:

- `entities.name` → `entities.canonical_name`; added `embedding` column (`ARRAY(SELECT random() FROM generate_series(1,768))::vector`)
- `facts.subject_id` / `facts.object_id` → `facts.subject_entity_id` / `facts.object_entity_id`
- `facts.valid_from` / `facts.valid_to` → `facts.valid_at` / `facts.invalid_at`
- `facts.object_text` (invalid-actors) → `facts.object_entity_id` + a second seeded object entity
- `causal_events` given explicit `fact_id` column in seeds
- `reasoning_reports` slimmed to `(id, summary, created_at)`; the `actor` column some subagents speculated was dropped (unverified)
- Source-reference JSONB normalized to the `{type, id, relevance}` shape declared in `audit.ts` in doc 12 rather than subagent-invented `{source, offset, length}` or `{memory_id, span}` shapes
- Cascade variants had `[... identical seed block ...]` placeholders expanded to full SQL

No subagent output contained leaks of production code names, paths, or symbols — redaction layer not needed.

## Patterns noticed across scenarios

1. **Subagents over-reach on columns they can't see.** When asked to produce fixture SQL, each subagent extrapolated plausible-but-wrong schema details (`name`, `valid_from`, `object_text`). The reference-fixture + spec-doc inputs were insufficient. For future runs, the orchestrator should pass a concrete, authoritative schema DDL excerpt — not just the doc-12 prose — or a link to the scaffold and say "match this exactly." The scaffold is a better schema source than doc 12.
2. **"MUST FAIL" is sharp; "hardening stressor" is blurry.** Several subagents produced a stressor fixture (1000 writes that must all pass) and initially mis-labelled it `MUST FAIL`. The Data Evolver prompt needs an explicit disambiguation: MUST FAIL = the code under test MUST reject this; hardening stressor = the code under test MUST succeed at this scale. Adding this to `data-evolver.md` would stop the drift.
3. **Expected JSON drifted into planning docs.** A couple of expected JSONs included `service_call` strings describing what the harness *should call* rather than strictly invariant assertions. Not wrong, but expanding scope. Fine here because no test code exists yet — implementer reads them as hints. Should be pruned to invariants-only when the test file lands.
4. **Complexity scores concentrated in `invalid-actors`.** At 105, that single adversarial-suite fixture is near the SOFT complexity cap (100). Guard soft-warned but hard cap is 200. If any more adversarial cases are added there, split into another variant file first.
5. **Actor-diversity assertion is a natural regression target.** Three scenarios (simple-mutations v1.1, actor-escalation, cascade-writes via cross_actor_chain) assert the full 7-actor enum is exercised. If a future PR silently drops an actor from the enum, all three fail simultaneously — strong signal.

## Scenarios requiring multiple passes

None. All five scenarios completed in a single Data Evolver invocation each. Guard checks passed (one pre-existing SOFT warning unrelated to this work: 1784 LoC uncommitted in tracked files on the current branch from other in-flight work — not introduced by this task).

## Open questions for the Phase 1 implementer

1. **`reasoning_reports` schema.** Fixtures assume columns `(id UUID PK, summary TEXT, created_at TIMESTAMPTZ)`. If the real schema has additional NOT NULL columns (e.g. `actor`, `mode`), the seed `INSERT`s will fail. Implementer should either (a) extend the fixture seeds at implementation time, or (b) file a bead describing the actual `reasoning_reports` shape.
2. **`causal_events` schema.** Fixtures assume `(id, fact_id, event_type, description, occurred_at)`. Phase B's existing `002_causal_graph.sql` is authoritative — if it diverges, seed columns may need trimming.
3. **Harness contract for concurrency/flood.** `concurrent-races.sql` and `concurrent-races-flood.sql` declare harness contracts in header comments (100/1000 parallel workers, UUID patterns, predicate pools). The harness code that parses these hints doesn't exist yet — `audit-trail.test.ts` will need to implement it. A good `nmemo-w4j.9` sub-task is: "implement fixture-comment-driven concurrency-harness loader" before the main test body.
4. **`-- CASE N` parser for `invalid-actors`.** Each case is a standalone `BEGIN; …; ROLLBACK;` block. The harness must parse `-- CASE N` / `-- EXPECTED:` comment markers, execute each block in its own transaction, and assert the raised SQLSTATE matches. A helper like `loadFixtureCases(path): Array<{id, sql, expected}>` would be clean.
5. **Business-rule assertions that DB doesn't enforce.** `cascade-writes-cascade-without-parent` and `actor-escalation-wrong-actor-for-cascade` rely on test-layer assertions for cascade invariants (DB permits NULL `reasoning_report_id`). The phase doc does not specify whether this should become a service-layer validator. Worth flagging when writing the service — if it becomes a service check, the "MUST FAIL" classification stays stable; if not, the tests stay at assertion layer.
6. **Length-overflow (`CASE 3` in `invalid-actors`).** VARCHAR(32) overflow in Postgres 15 raises SQLSTATE `22001` on INSERT. Confirm this matches doc 12's spec of `VARCHAR(32)` on `actor`; if the schema instead uses `TEXT`, CASE 3 will silently succeed and the fixture will falsely pass — a schema regression signal.
7. **Orphan-retention invariant.** `simple-mutations.expected.json` asserts that deleting a `public.facts` row leaves its fact_history rows intact. Requires the FK on `fact_history.fact_id` to have `ON DELETE NO ACTION` (or `RESTRICT` / omitted). The spec in doc 12 shows `REFERENCES public.facts(id)` without a cascade clause, which defaults to NO ACTION — but worth verifying in the migration.

## What's next

- `nmemo-klv.9` → close
- `nmemo-w4j` (Phase 1 implementation) → unblocked
- Phase 1 implementer should read this report plus doc 12 before starting, and confirm the six open questions above

`bd ready` after close should show `nmemo-w4j` as the next unblocked epic.
