# Test-Harden Skill — Architectural Design

**Parent:** [18 — Test Data Hardening Protocol](18-test-data-hardening-protocol.md)
**Status:** Design
**Purpose:** Specify the skill that implements the recursive self-improving test loop.

## Purpose

Doc 18 defines the **protocol** (what the loop looks like conceptually). This doc defines the **skill** (how the loop is actually executed by an agent).

The skill is a Claude Code skill, invokable as `/test-harden`, runnable on a cron schedule. It orchestrates subagents with isolated contexts to prevent test-fitting, reads agent reasoning reports to self-improve, and includes guards against runaway code/fixture growth.

## Core Principles

### 1. Isolated Contexts Prevent Test-Fitting

The skill never lets the same agent see both the test fixture AND the production code. Two separate subagents handle these domains:

- **Test-Data Evolver** — sees only: fixture files, expected JSON, benchmark reports, failure descriptions. Never sees the implementation of the code under test.
- **Code Analyser** — sees only: code files, failure stack traces, descriptions of *what* failed. Never sees fixture internals beyond what the test output reveals.

The orchestrator shuttles distilled findings between them, stripping context that would enable test-fitting.

### 2. Agent Reasoning Reports Drive Improvement

When the tests exercise production agents (graph agent, reasoning agent, gardener, reconciliation), those agents already produce `reasoning_reports` rows with their thought process. The skill reads these reports to discover:
- Where the agent found the task difficult
- Which tool calls felt redundant or wasted
- Signals of confusion (e.g., repeated queries for the same entity)
- Gaps in the agent's information that led to weaker conclusions

These findings flow to the Code Analyser (for prompt improvements) and the Test-Data Evolver (for fixture improvements that reproduce the difficulty).

### 3. Self-Analysis Stage

After every run, the skill analyses **itself**: was the loop productive, did guards fire, did decisions prove wrong on the next run, are the subagent prompts producing useful output?

Self-analysis findings update the skill's own helper files (not SKILL.md directly — that needs human review). Changes are logged and can be reviewed before promotion.

### 4. Hard Guards Against Code/Data Explosion

| Resource | Soft Limit | Hard Cap | Behaviour |
|----------|-----------|----------|-----------|
| LoC added per run | 500 | 2000 | Soft → warn; hard → abort |
| Fixtures added per run | 3 | 10 | Soft → warn; hard → abort |
| Iterations per cron fire | 3 | 5 | Soft → next cron; hard → exit |
| Consecutive fails on same scenario | 2 | 3 | Soft → try different angle; hard → file bead and park |
| Subagent tool calls per task | 40 | 80 | Soft → prune and retry; hard → abort |
| Fixture complexity score | 100 | 200 | Complexity = rows × edges × stressors; hard → graduate or stop |

When the hard cap fires, the skill **exits with a review request** rather than continuing. Runaway growth is always reviewable by a human before being accepted.

### 5. Evolving Toward Test Criteria, Not Fitting Them

The data evolver's goal is not "make tests pass" — it's "produce data that exercises the criteria the tests assert." The two are not identical:

- **Fitting:** generate a fixture tailored to current code, passes every time
- **Evolving:** generate a fixture that challenges a criterion (e.g., "concurrent mutations don't lose audit rows"), then report whether code meets criterion

The criteria come from the phase doc's benchmark metrics + adversarial scenarios sections. The skill reads those as its target, not the current code's behaviour.

## Architecture

```d2
direction: down

cron: "cron schedule\n(or manual /test-harden)" {
  shape: cloud
}

orchestrator: "Orchestrator\n(SKILL.md main)" {
  style.fill: "#cfe8ff"
}

scan: "1. SCAN\nload scenario state" {
  shape: step
}

seed: "2. SEED\npre-populate DB\nfrom fixtures" {
  shape: step
}

run: "3. RUN\npnpm vitest run\n<scenario>" {
  shape: step
  style.fill: "#d4edda"
}

agent_feedback: "3a. COLLECT\nreasoning_reports\nfrom agents in test" {
  shape: step
  style.fill: "#fff3cd"
}

analyse: "4. ANALYSE\nclassify result" {
  shape: step
}

data_evolver: "Test-Data Evolver\n(isolated ctx subagent)" {
  style.fill: "#d4edda"
  inputs: "Inputs:\n- fixture files\n- expected JSON\n- failure descriptions\n- agent difficulty reports"
  outputs: "Output:\n- new/mutated fixture\n- updated expected"
}

code_analyser: "Code Analyser\n(isolated ctx subagent)" {
  style.fill: "#f8d7da"
  inputs: "Inputs:\n- code under test\n- failure traces\n- agent difficulty reports"
  outputs: "Output:\n- bead issue text\n- fix suggestion\n- NEVER a fix commit"
}

self_analyser: "Skill Self-Analyser\n(isolated ctx subagent)" {
  style.fill: "#e6d9ec"
  inputs: "Inputs:\n- all run metadata this session\n- prior self-analysis reports"
  outputs: "Output:\n- skill improvement notes\n- guard adjustments\n- subagent prompt tweaks"
}

guard: "5. GUARD CHECK\nlimits + sanity" {
  shape: diamond
  style.fill: "#fff3cd"
}

act: "6. ACT\napply change" {
  shape: step
}

report: "7. REPORT\nbenchmark markdown\nbd updates\ncommit" {
  shape: step
  style.fill: "#cfe8ff"
}

self_update: "8. SELF-ANALYSE\nupdate skill notes" {
  shape: step
  style.fill: "#e6d9ec"
}

cron -> orchestrator -> scan -> seed -> run -> agent_feedback -> analyse
analyse -> data_evolver: "data plateau\nor test bug"
analyse -> code_analyser: "code failure"
data_evolver -> guard
code_analyser -> guard
guard -> act: "within limits"
guard -> report: "hard cap hit\n(exit)"
act -> report
report -> self_update
self_update -> self_analyser: "accumulated data"
self_analyser -> orchestrator: "skill improvement notes\n(next session)"
```

## Subagent Definitions

### Test-Data Evolver

**Purpose:** Propose a harder or more adversarial version of an existing fixture.

**Context it sees:**
- The target fixture file (SQL)
- The expected assertion JSON
- The benchmark report history for this scenario
- A description of the gap to close (e.g., "scenario plateaued — all pass for 3 runs — push complexity")
- Relevant agent difficulty reports (LLM test feedback — redacted of implementation details)

**Context it does NOT see:**
- Any service code implementation
- Test file internals beyond fixture paths
- Code failure stack traces (those go to Code Analyser)

**Outputs:**
- New or mutated fixture SQL
- Updated expected JSON
- A short note explaining what the mutation tests

**Mutation Menu (primitives):**
- Scale: 10× rows, 100× rows
- Concurrency: simulate N parallel writes
- Adversarial structural: malformed embeddings, invalid UUIDs, near-duplicate entities
- Adversarial temporal: events in reverse chronology, overlapping validity windows
- Domain-specific: MISRA-realistic rule chains with deliberately subtle near-matches
- Cross-fixture interactions: introduce a second entity set that competes or conflicts

### Code Analyser

**Purpose:** Given a test failure, classify and propose a fix direction — but never write the fix.

**Context it sees:**
- The source file(s) implicated by the failure
- The failure message + stack trace + assertion details
- Agent reasoning reports from the test run
- The phase doc's acceptance criteria for this scenario

**Context it does NOT see:**
- Fixture SQL internals (beyond filename)
- Expected JSON contents (only the assertion that failed)
- Other fixtures that might pass or fail similarly

**Outputs:**
- Failure classification: `code-bug | test-bug | flaky | environment | external-service`
- Affected file + line number
- Root cause hypothesis (one paragraph)
- Suggested fix direction (one paragraph) — NOT code
- Bead issue text (pre-formatted for `bd create`)

### Skill Self-Analyser

**Purpose:** Review the skill's own performance across recent runs. Find wasted effort, wrong decisions, patterns in what the subagents produce.

**Context it sees:**
- All benchmark reports from this session
- All bead issues filed by Code Analyser
- All fixtures added by Test-Data Evolver
- Previous self-analyser reports (skill's memory)
- The skill's current SKILL.md and subagent prompts

**Context it does NOT see:**
- Production code
- Raw fixtures (only summaries)

**Outputs:**
- **Skill improvement notes** (appended to `.claude/skills/test-harden/self-analysis.md`)
- Recommended guard adjustments (e.g., "raise LoC cap from 500 to 800 because analysis shows typical productive run is 600")
- Recommended subagent prompt tweaks (as diffs — applied only after human review gate)
- Meta-metrics (time wasted on flaky tests, % of filed beads that turned out to be test-bugs, etc.)

## The Orchestrator's Decision Tree

```d2
direction: down

start: "scenario + result\nloaded" {
  shape: circle
}

failed: "test failed?" {
  shape: diamond
}

flaky: "flaky signals?\n(inconsistent across retries)" {
  shape: diamond
}

consecutive: "3rd consecutive\nfail?" {
  shape: diamond
}

code_hypothesis: "failure has\nstack trace\nin our code?" {
  shape: diamond
}

is_plateau: "3 consecutive\nclean runs?" {
  shape: diamond
}

complexity_budget: "complexity\nbudget left?" {
  shape: diamond
}

call_code_analyser: "→ Code Analyser" {
  style.fill: "#f8d7da"
}

call_data_evolver: "→ Test-Data Evolver" {
  style.fill: "#d4edda"
}

park: "Park scenario\nfile review bead\nexit" {
  style.fill: "#fff3cd"
}

retry: "Retry N times\nthen classify" {
  shape: step
}

graduate: "Graduate\nscenario to\nnext level" {
  style.fill: "#cfe8ff"
}

stable: "Exit — stable" {
  shape: circle
  style.fill: "#d4edda"
}

start -> failed
failed -> flaky: "yes"
failed -> is_plateau: "no"
flaky -> retry: "yes"
flaky -> consecutive: "no"
consecutive -> park: "yes"
consecutive -> code_hypothesis: "no"
code_hypothesis -> call_code_analyser: "yes"
code_hypothesis -> call_data_evolver: "no"
retry -> consecutive: "still inconsistent"
is_plateau -> complexity_budget: "yes"
is_plateau -> stable: "no (< 3 runs)"
complexity_budget -> call_data_evolver: "yes"
complexity_budget -> graduate: "no"
```

## Data Flow — Agent Feedback Loop

Many tests invoke agents. Their feedback is gold:

```d2
direction: right

test: "test runs graph_agent\nor reasoning_agent\nagainst fixture" {
  shape: step
}

report_db: "reasoning_reports\ntable row written\nwith actions_taken + report" {
  shape: cylinder
}

orchestrator: "orchestrator\nreads report" {
  shape: step
}

redact: "redact\nimplementation refs\n(entity IDs, file paths)" {
  shape: step
  style.fill: "#fff3cd"
}

route_evolver: "route to\nData Evolver" {
  shape: step
  style.fill: "#d4edda"
}

route_analyser: "route to\nCode Analyser\n(if code implicated)" {
  shape: step
  style.fill: "#f8d7da"
}

test -> report_db -> orchestrator -> redact
redact -> route_evolver: "agent found task\ncanonically hard"
redact -> route_analyser: "agent pattern suggests\ncode ambiguity"
```

Example feedback patterns:
- Agent queried the same entity 5 times in one run → prompt ambiguity (Code Analyser)
- Agent couldn't find enough source material to reach confidence → missing fixture data (Data Evolver)
- Agent produced contradictory assertions within one run → genuine bug (Code Analyser + file bead)
- Agent took 80 of 100 tool calls before answering → efficiency regression (Code Analyser → prompt)

## Guards — Concrete Implementation

### LoC Budget

Before committing any change:
```bash
git diff --stat HEAD | tail -1  # summary line
# parse "N files changed, +L -D"
# If L > 500 → warn; if L > 2000 → abort
```

### Fixture Count Budget

Before commit:
```bash
git status --porcelain | grep "^?? platform/src/test/data/" | wc -l
# If > 3 new → warn; if > 10 → abort
```

### Complexity Score

For a fixture file, parse SQL AST-ish:
```
complexity = rows_inserted + edges_inserted * 2 + stressor_count * 10
```
Stressors identified by comment markers (`-- STRESSOR: concurrency=100`).
Cap at 200.

### Consecutive Failure Tracking

Maintain `scenario-state.json` per scenario:
```json
{
  "scenario": "simple-mutations",
  "last_result": "fail",
  "consecutive_fails": 2,
  "total_runs": 15,
  "last_run_at": "2026-04-20T12:34:56Z"
}
```

After 3 consecutive fails on same scenario: park, file bead, do not retry.

### Iteration Cap

Per cron fire, process at most 5 scenarios. The rest carry to next fire.

## Skill Invocation

### Manual

```bash
/test-harden                          # default: process ready scenarios across all phases
/test-harden phase1                   # focus on phase 1 scenarios
/test-harden phase1 simple-mutations  # single scenario
/test-harden --dry-run                # scan + report plan, no mutations
/test-harden --analyse-self           # force self-analysis stage
```

### Cron

```bash
# Once the skill is stable:
0 */6 * * *  /test-harden --auto  # every 6h, automated, no confirmation
```

Starts narrower (e.g., once per day) and widens as trust grows.

## Output Surfaces

- **Benchmark reports:** `platform/src/test/data/<phase>/benchmark-reports/YYYY-MM-DD-<scenario>.md`
- **Bead issues:** filed via `bd create --parent <phase-id>` with classification
- **Self-analysis log:** `.claude/skills/test-harden/self-analysis.md` (appended)
- **Fixture commits:** one commit per scenario change, message `test-harden: <scenario> v<N> — <one-line>`
- **Skill prompt updates:** diffs in `.claude/skills/test-harden/proposed-updates/<timestamp>.diff` — NEVER auto-applied to SKILL.md

## Open Questions to Decide As We Build

1. **How does the skill pick which scenario to run next?** Options: round-robin, priority-weighted (younger scenarios first), or triggered-by-code-change (only scenarios touching recently-changed files).
2. **What happens when Data Evolver and Code Analyser disagree?** e.g., Evolver says "fixture is fine, code is wrong"; Analyser says "code is fine, fixture is malformed." Orchestrator arbitration needed.
3. **How is domain knowledge (MISRA rules, compliance hierarchies) passed to the Evolver without leaking into Code Analyser?** Proposal: `platform/src/test/data/common/domain-kb.json` that Evolver can reference; Code Analyser cannot.
4. **How does the skill know when a scenario is truly "done"?** Proposal: 5 consecutive plateau runs with no new mutations surfaced.

## Relationship to Existing Agents

The skill does NOT replace existing agents:
- **Graph agent / reasoning agent / gardener / reconciliation** — continue to do their real job. The skill runs them against fixtures and reads their reports.
- **Beads** — the skill uses `bd create` to file issues, `bd show` to read context, `bd close` when it verifies a previous issue is resolved.
- **Claude Code** — the skill is a Claude Code skill; uses Haiku by default (per CLAUDE.md haiku-first preference).

## Beads Tracking

Epic: **nmemo-klv** (Test Data Hardening)
Skill-specific sub-tasks will be created under `nmemo-klv.8` (TEST-SKILL-INTEG):
- Orchestrator scaffolding
- Test-Data Evolver subagent
- Code Analyser subagent
- Skill Self-Analyser subagent
- Guard implementation
- Scenario state tracking
- Cron invocation mode
- First end-to-end run on Phase 1 `simple-mutations`
