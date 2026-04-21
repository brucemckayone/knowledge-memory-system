---
name: test-harden
description: Recursive self-improving test loop for the Mnemo reasoning layer. Scans fixtures and benchmark reports, runs tests, analyses results through isolated-context subagents (test-data evolver and code analyser), files bead issues for code bugs, commits fixture evolutions, and self-analyses for skill improvement. Designed to run on cron. Guarded against code/data explosion.
version: 0.2.0
---

# test-harden

Recursive test-hardening loop for the Mnemo reasoning layer.

Full spec: `docs/architecture/truth-graph/20-test-harden-skill-design.md`
Protocol: `docs/architecture/truth-graph/18-test-data-hardening-protocol.md`

---

## Invocation

| Command | Behaviour |
|---------|-----------|
| `/test-harden` | Process ready scenarios across all phases (iteration cap 5) |
| `/test-harden <phase>` | Focus on one phase (e.g. `/test-harden phase1`) |
| `/test-harden <phase> <scenario>` | Single named scenario |
| `/test-harden --dry-run` | Scan + plan, no mutations |
| `/test-harden --analyse-self` | Self-analysis only |
| `/test-harden --auto` | Cron mode: no prompts, commits within guards |

Arguments parse from `$ARGUMENTS` if the skill runner provides them.

---

## When to stop immediately

Before starting, check:

1. `.claude/skills/test-harden/scenario-state/` directory exists — if not, create it.
2. Run `python .claude/skills/test-harden/scripts/guard-check.py` — if hard cap already tripped from uncommitted work, **stop and report**. Don't layer more changes on top.
3. Confirm services: `make health` shows postgres + ml + qdrant up. If not, fail fast with "services required" message.

---

## Execution — Main Loop

The orchestrator processes each ready scenario through this fixed sequence. Use `Bash` for shell helpers, `Read` for fixtures, `Agent` for subagent invocations, `Write` for committing evolved fixtures.

### Step 1 — SCAN

```bash
python .claude/skills/test-harden/scripts/scenario-state.py list-ready
```

Pick up to 5 scenarios in priority order (lowest `consecutive_passes` first, oldest `last_run` as tiebreaker). If the user scoped the invocation to a phase or scenario, filter accordingly.

If there are no ready scenarios (all `plateau` or `parked`), the skill has nothing to do — report summary and exit 0.

For each chosen scenario, note:
- `fixture_path` + `expected_path` + `test_file`
- Current `fixture_version`, `complexity_score`, `consecutive_passes/fails`
- Relevant phase doc (derive from the scenario's phase, e.g. `docs/architecture/truth-graph/12-audit-trail-foundation.md` for `phase1`)

### Step 2 — SEED

Ensure test DB is in a known state. For scenarios that seed data, the test harness typically calls `deleteFromTables()` in `beforeEach`, so fixture seeding happens inside the test. No explicit seeding needed here — the fixture is referenced by the test file via `loadFixture()` or direct SQL literal.

If the fixture file doesn't exist or is stale vs its declared version, **flag as error and skip this scenario** — this is the user's responsibility to reconcile.

### Step 3 — RUN

Record the start timestamp (`date -u +%Y-%m-%dT%H:%M:%SZ`). Then:

```bash
.claude/skills/test-harden/scripts/run-scenario.sh <phase> <scenario>
```

Capture stdout (JSON run result) and the exit code:
- `0` — all assertions passed
- `1` — at least one failure (normal test failure)
- `2` — harness error (test file missing, compile error, DB not up)

If exit code is `2`, record a harness error note, do not change state, move to next scenario.

### Step 4 — COLLECT

Immediately after the test run, pull fresh reasoning_reports written during the run:

```bash
.claude/skills/test-harden/scripts/collect-agent-reports.sh --since <start-ts>
```

The output is a JSON array of reports with `report`, `question`, `actions_taken`, entity/fact/edge IDs.

If the array is empty and the test didn't exercise any agent, that's fine — skip to Step 5.

If the test exercised an agent and the array is empty, that's itself a signal — flag as "agent_silent" in findings.

### Step 5 — ANALYSE

Classify the run result:

- **pass** — all assertions passed, agent reports show no pathological patterns
- **pass with concerns** — assertions passed but reports show signals (tool budget exhausted, same-entity thrashing, contradictions created mid-run). Treat as effective-fail for routing purposes.
- **fail** — assertions failed
- **flaky** — if this is a retry, previous run had different result
- **harness** — test couldn't run (caught in Step 3, don't reach here)

Check scenario state for "plateau candidate" — if `consecutive_passes >= 3` and no concerns, the scenario is stable; this is a graduation trigger rather than a data-evolution trigger.

### Step 6 — ROUTE

Decision tree:

- If **fail** with stack trace pointing into production code → **Code Analyser**
- If **fail** with test setup errors (fixture load, assertion shape mismatch) → **Test-Data Evolver** (with "fix-mode" flag — task is to correct the malformed fixture, not evolve)
- If **pass with concerns** → both: **Code Analyser** to interpret agent signals + **Test-Data Evolver** to generate a fixture that reproduces the difficulty
- If **pass** and plateau candidate → **Test-Data Evolver** in "push-complexity" mode
- If **pass** and not yet plateau → record result, move on (no subagent call needed)
- If **flaky** → retry once; if still flaky, park scenario and file bead

#### Invoking the Test-Data Evolver

Use the `Agent` tool with `subagent_type: general-purpose`. Construct the prompt by:

1. Reading `.claude/skills/test-harden/subagents/data-evolver.md` verbatim
2. Appending an "Inputs" block with:
   - Fixture content (read via `Read`)
   - Expected JSON content
   - Scenario state summary
   - Recent benchmark reports (last 3 for this scenario)
   - **Redacted** agent reports (pass through `redact-report.py` first):
     ```bash
     echo '<reports-json>' | python .claude/skills/test-harden/scripts/redact-report.py -
     ```
   - Gap description: "plateau push", "reproduce difficulty X", "correct malformed assertion"

3. Request output in the format specified in `data-evolver.md`

#### Invoking the Code Analyser

1. Read `subagents/code-analyser.md`
2. Append inputs:
   - Failure output (from run-scenario.sh)
   - Source file(s) implicated by the top of the stack trace (use `Read` on those paths)
   - Agent reports (NOT redacted — Code Analyser gets full detail)
   - Phase doc acceptance criteria for this scenario (read from the phase doc)
3. Parse classification + root cause + bead text from output

### Step 7 — GUARD

Before applying any change from the subagent, run:

```bash
python .claude/skills/test-harden/scripts/guard-check.py --phase <phase> --scenario <scenario> --verbose
```

Exit code:
- `0` — apply the change
- `1` — soft warning; apply but log the warning in the benchmark report
- `2` — **HARD CAP HIT** — do NOT apply the change. File a review bead:
  ```bash
  "C:/Users/bruce.mckay/AppData/Local/Programs/bd/bd.exe" create \
    --title="test-harden review: <scenario> hard-cap" \
    --type=task --priority=2 --parent nmemo-klv \
    --description="Guard hard-cap hit while processing <scenario>. Proposed change saved but not applied. See .claude/skills/test-harden/proposed-updates/<timestamp>-<scenario>.txt for details. Human review required."
  ```
  Save the proposed change as a text file under `proposed-updates/` with a descriptive filename. Move to next scenario.

### Step 8 — ACT

Apply the change from the subagent:

- **Data Evolver output** → `Write` the updated fixture + expected JSON files. Bump `fixture_version` in scenario state.
- **Code Analyser bead text** → file via `bd create`. Record the bead ID in scenario state's `filed_beads` array.

Never modify production code as part of this skill. Code Analyser produces bead text only; actual fixes live in the phase's implementation issues.

### Step 9 — REPORT

```bash
python .claude/skills/test-harden/scripts/write-benchmark.py <phase> <scenario> <result-json> "<findings-text>"
```

This creates `platform/src/test/data/phase<N>-*/benchmark-reports/YYYY-MM-DD-<scenario>.md`.

Then update scenario state:

```bash
python .claude/skills/test-harden/scripts/scenario-state.py record-result <phase> <scenario> <pass|fail|flaky>
```

Record any stressors added:

```bash
python .claude/skills/test-harden/scripts/scenario-state.py update <phase> <scenario> stressors_applied '["concurrency=10", "near-duplicates"]'
python .claude/skills/test-harden/scripts/scenario-state.py update <phase> <scenario> complexity_score 55
```

### Step 10 — SELF-LOG

Append a line to `.claude/skills/test-harden/session-log.jsonl`:

```json
{"ts":"2026-04-20T15:30:00Z","phase":"phase1","scenario":"simple-mutations","result":"pass","action":"plateau-push","fixture_version_before":"v1.0","fixture_version_after":"v1.1","beads_filed":[],"subagent_calls":2}
```

Then move to the next scenario.

---

## After All Scenarios — Self-Analysis

Only run if the invocation wasn't `--dry-run` and at least one scenario completed.

1. Collect session data:
   - All benchmark reports written this session (from session-log.jsonl)
   - All bead issues filed (from session-log.jsonl)
   - All fixture commits (`git log --since="<session start>"`)
   - Updated scenario-state files

2. Invoke **Skill Self-Analyser** subagent:
   - Read `subagents/self-analyser.md`
   - Pass session data + current `self-analysis.md` + current `SKILL.md` + subagent prompts as inputs
   - Request output per the self-analyser's specified format

3. Append the analyser's report to `self-analysis.md` (never overwrite — always append)

4. For any proposed-updates diffs the analyser produces, `Write` them to `.claude/skills/test-harden/proposed-updates/<timestamp>-<area>.diff`. These are NOT auto-applied.

5. If the skill's `--auto` mode is on and the analyser's recommendations are all "tune X by small amount" (no structural changes), flag for human review via bead but do not apply.

---

## Cron Mode Differences

`--auto` skips:
- User prompts
- Interactive "continue?" confirmations
- Proposing structural skill changes

`--auto` still enforces:
- All guards (hard caps exit cleanly)
- Bead filing on code bugs
- Self-analysis at end of session
- Proposed updates saved but not applied

A cron-scheduled invocation typically processes 3-5 scenarios per fire. The iteration cap means long-running work spans multiple fires.

---

## Subagents

Three isolated-context subagents. Prompts in `subagents/`:

- `data-evolver.md` — proposes fixture mutations; never sees code
- `code-analyser.md` — diagnoses test failures; never sees fixture internals
- `self-analyser.md` — reviews skill performance; proposes diffs never auto-applies

Each has a self-audit checklist it runs before returning output. The orchestrator runs a second verification pass on subagent output (e.g. Data Evolver fixture shouldn't reference any function name from the source code — the redaction layer should have caught this, but verify).

---

## Scripts

All executable helpers live in `scripts/`:

| Script | Role |
|--------|------|
| `scenario-state.py` | CRUD for scenario-state JSON files |
| `guard-check.py` | Run all guard thresholds, exit code signals severity |
| `redact-report.py` | Strip implementation refs from agent reports |
| `run-scenario.sh` | Execute vitest on a scenario, return structured JSON |
| `collect-agent-reports.sh` | Pull reasoning_reports from DB since timestamp |
| `write-benchmark.py` | Render benchmark markdown report |

Scripts are idempotent and safe to re-run.

---

## First Invocation

The first run of this skill against a new scenario requires initialising its state:

```bash
python .claude/skills/test-harden/scripts/scenario-state.py init \
  phase1 simple-mutations \
  platform/src/test/data/phase1-audit/fixtures/simple-mutations.sql \
  platform/src/test/data/phase1-audit/expected/simple-mutations.expected.json \
  platform/src/test/harness/audit-trail.test.ts
```

After init, `/test-harden phase1 simple-mutations` runs the full pipeline.

Before any scenario can be processed, the corresponding test file must exist. For Phase 1's `simple-mutations`, that means `audit-trail.test.ts` ships as part of Phase 1 implementation (`nmemo-w4j.9`).

---

## Status

v0.2.0 — orchestrator logic defined, scripts implemented, subagent prompts written.

Pending (tracked in beads under `nmemo-klv.8`):
- First live run against any scenario (`nmemo-klv.8.10`)
- Iteration on the skill after real-world data

Safe operations right now:
- `--dry-run` — will scan and report even without test files
- `scenario-state.py summary` — inventory
- `guard-check.py` — test the guards

---

## Related

- `docs/architecture/truth-graph/18-test-data-hardening-protocol.md` — protocol spec
- `docs/architecture/truth-graph/20-test-harden-skill-design.md` — full design
- `platform/src/test/data/README.md` — fixture conventions
- `self-analysis.md` — skill's evolution memory
- Beads epic `nmemo-klv`, sub-issues under `nmemo-klv.8`
