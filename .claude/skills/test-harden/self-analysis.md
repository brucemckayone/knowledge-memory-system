# Test-Harden Skill — Self-Analysis Log

Append-only log of the skill's self-analysis stage. One section per session, dated.

The skill reads this file on every run to spot recurring patterns and avoid re-proposing the same improvements.

---

## Initial state — 2026-04-20

Skill scaffolded. No runs yet. No baseline metrics.

**Known limitations at scaffold:**
- Subagent prompts are first-draft, unused in real runs
- Orchestrator logic not implemented
- Guard implementations not implemented
- Scenario-state reader/writer not implemented

**First-run targets:**
- Phase 1 `simple-mutations` (exists as reference fixture)
- Establish baseline benchmark
- First self-analysis of the skill

Sessions begin recording here after the first live run.

---

## Session — 2026-04-27 (first end-to-end run)

**Trigger:** Manual `/test-harden phase1 simple-mutations` invocation, scoped to `klv.8.10` ("First end-to-end run on phase1 simple-mutations").

**Pipeline outcome:** pass — 29/29 audit-trail assertions in 6.3s. No agent reports during run window. `consecutive_passes` 0 → 1, `total_runs` 0 → 1, no plateau yet.

**Subagent invocations this session:**
- 1× Test-Data Evolver (plateau-mode smoke fire) — produced a v1.2 mutation along the concurrency axis (race-burst + collision); validated against `cognitive_test` schema via the apply pipeline's DB check. Applied as a *dry-run* only — `simple-mutations.sql` on disk is still v1.1.
- 1× Code Analyser (synthetic-failure smoke fire) — produced a well-formed bead, filed `nmemo-w4j.11` under `nmemo-w4j`, then closed it as a smoke-test artifact.

**Helper-script defects surfaced and patched in-session** (not skill-prompt issues — actual bugs in scripts shipped under earlier `klv.8.x` tickets):
1. `run-scenario.sh` passed bash-form `/c/Users/...` paths into a native Python `open()` — fixed by routing through `cygpath -m` when available.
2. `run-scenario.sh` filtered tests via `--testNamePattern="$SCENARIO"`, but the Phase 1 test file structures suites by feature, not scenario, so vitest 4 marked all 29 tests as `pending`. Filter dropped; runs whole file. Scenario-to-test mapping is now an open question for future skill iterations.
3. `run-scenario.sh`'s embedded JSON-extraction regex was greedy and choked on the 850-line vitest console output. Rewrote to scan line-by-line for the single `numTotalTests`-bearing JSON document, stripping ANSI colour escapes first.
4. `collect-agent-reports.sh` defaulted to `postgres/postgres/mnemo` credentials but the live test DB is `cognitive/cognitive/cognitive_test`; added a docker-exec fallback path so the script works without a host `psql` binary.
5. `apply-evolver-output.py` (newly written this session) piped non-ASCII fixture comments through cp1252 by default, hanging the psql subprocess on Windows. Forced UTF-8 encoding on stdin + `PGCLIENTENCODING=UTF8`. Also extended `strip_outer_transaction` to skip leading SQL-comment header banners before looking for the opening `BEGIN;`.

**Real finding surfaced by the apply-pipeline DB validator (worth a follow-up bead, not yet filed):**
- The v1.1 `simple-mutations.sql` references `causal_events.event_type` but the live schema column is `transition_type`, with a different CHECK enum (`'created' | 'strengthened' | 'weakened' | 'expired' | 'invalidated'`, not `'supersede'`). The fixture has never been executed by a live test (audit-trail tests build their data inline), so the bug stayed invisible until the apply pipeline ran the full file through `psql`. The skill caught a real, dormant fixture/schema drift on its first end-to-end run — exactly the value proposition described in `docs/architecture/truth-graph/20-test-harden-skill-design.md` §1.

**Recommendation queue (not auto-applied — review gate):**
- Wire one of the audit-trail tests to load `simple-mutations.sql` via `loadFixture()` so the scenario actually exercises the fixture. Without this, `consecutive_passes` increments are uninformative — the skill is timing audit-trail tests over inline data, not over the fixture under management.
- Reconcile the `causal_events` columns in v1.1 (`event_type` → `transition_type`, value `'supersede'` → `'invalidated'`) before any future Evolver pass touches that fixture; otherwise the Evolver inherits the broken rows and every DB check fails on baseline.
- Consider a `--filter-by` knob on `run-scenario.sh` so future test files structured by scenario can opt into name-pattern filtering without inheriting the broken default.

**Skill-prompt diff proposals:** none this session — the subagent prompts produced clean output on first contact with both real fires.

**Guards fired:** none. LoC delta was 0 against the canonical fixture (dry-run only). No fixtures committed. Iteration count was 1 of 5.

**Next session targets:**
- Address the `loadFixture()` wiring above before the next plateau push, so a v1.2 race-burst mutation can actually be observed.
- File the `causal_events.event_type` finding as a tracked bead (it isn't a regression — it's an original-implementation gap).
- Run `phase1/concurrent-races` for the first time once its test wiring exists.
