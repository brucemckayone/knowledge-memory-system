# Phase 1 Implementation Kickoff Prompt

Use this prompt to start a fresh Claude Code session that implements Phase 1 (Audit Trail Foundation).

**Prerequisite:** `nmemo-klv.9` (HARDEN-P1) must be closed. The test-harden skill must have evolved Phase 1 fixtures to their v2+ state before implementation begins. If HARDEN-P1 is still open, stop and run the skill first.

Copy everything between the `---` markers into a new Claude Code session.

---

# Implement Phase 1 — Audit Trail Foundation

You are implementing Phase 1 of the Mnemo reasoning layer hardening: a full audit trail for every mutation to facts and causal edges. This is the foundation every later phase depends on.

## Before you start

Run these commands and read their output before touching any code:

```bash
"C:/Users/bruce.mckay/AppData/Local/Programs/bd/bd.exe" prime
"C:/Users/bruce.mckay/AppData/Local/Programs/bd/bd.exe" show nmemo-w4j
"C:/Users/bruce.mckay/AppData/Local/Programs/bd/bd.exe" show nmemo-klv.9
"C:/Users/bruce.mckay/AppData/Local/Programs/bd/bd.exe" ready
```

Verify:
1. `nmemo-klv.9` (HARDEN-P1) shows status `closed`. If not, stop — run the test-harden skill first. You cannot start implementation against unhardened fixtures.
2. `nmemo-w4j` (Phase 1) is unblocked. If blocked, check what else must complete first.
3. The hardened fixtures exist at `platform/src/test/data/phase1-audit/fixtures/` with `fixture_version >= v2`.
4. Acceptance criteria from `bd show nmemo-w4j` are clear.

## Required reading (do not skip)

Read in this order. Do not proceed past reading until you've read them all:

1. `docs/architecture/truth-graph/10-reasoning-layer-overview.md` — the big picture, design principles, actor model, operational concerns
2. `docs/architecture/truth-graph/12-audit-trail-foundation.md` — the full Phase 1 spec (data model, service layer, integration, tests, acceptance criteria)
3. `docs/architecture/truth-graph/18-test-data-hardening-protocol.md` — test data methodology
4. `docs/architecture/truth-graph/19-implementation-runbook.md` — per-phase runbook + checklists
5. `platform/src/test/data/phase1-audit/` — the hardened fixtures you are implementing against. Read every fixture file and its expected JSON.
6. `platform/src/test/data/phase1-audit/benchmark-reports/` — any prior benchmark runs from the hardening task
7. `CLAUDE.md` (repo root) — project conventions, beads workflow, AGE/search_path gotchas
8. Existing code you will modify: `platform/src/services/facts.ts`, `platform/src/services/causal.ts`, `platform/src/services/causal-agent.ts`, `platform/src/db/schema.ts`, `platform/src/pipeline.ts`

## Your job

Implement the Phase 1 sub-tasks in beads, in the order the dependency graph dictates. The sub-tasks are:

```
nmemo-w4j.1   Migration 009_audit_trail.sql with backfill
nmemo-w4j.2   Drizzle schema for history tables
nmemo-w4j.3   audit.ts service — recordFactChange, recordEdgeChange, getFactHistory, getEdgeHistory
nmemo-w4j.4   Thread actor through facts.ts mutation paths
nmemo-w4j.5   Thread actor through causal.ts mutation paths
nmemo-w4j.6   MCP tools get_fact_history + get_edge_history
nmemo-w4j.7   Actor context threading through MCP handlers
nmemo-w4j.8   Reasoning agent prompt — read history before acting
nmemo-w4j.9   audit-trail.test.ts passing
nmemo-w4j.10  Regression sweep — existing tests still pass
```

Use `bd ready` to find the next unblocked sub-task at each step. Use `bd update <id> --claim` before starting. Use `bd close <id>` when a sub-task meets its acceptance criteria.

## Non-negotiable rules

1. **Tests before code.** For every service function you write, the failing test (sourced from the hardened fixtures) exists first. Run the test, see it fail, then write the implementation, then run it green.
2. **`actor` is required everywhere.** Every mutation function accepts `actor: Actor` as a non-optional parameter. TypeScript must reject missing values at compile time. Never add a default value.
3. **Every mutation writes audit atomically.** `recordFactChange` / `recordEdgeChange` run in the same transaction as the mutation. If audit fails, roll back the mutation. Never fire-and-forget audit writes.
4. **No Co-Authored-By lines on commits.** See `CLAUDE.md` and user memory — never add AI attribution.
5. **Respect AGE search_path.** All new DDL uses explicit `public.` schema qualifier. Session search_path is `ag_catalog, public, "$user"` — do not change it.
6. **Haiku-first during dev.** If you add any LLM-driven feature, default to Haiku. Verify functionality without relying on Sonnet/Opus.
7. **Use beads, not TodoWrite.** Task tracking goes in beads. Use `bd remember` for cross-session knowledge, not memory files.
8. **Match existing patterns.** Look at `003_graph_meta.sql`, `005_reconciliation.sql`, etc. for migration style. Look at `causal-schema.test.ts` for test file layout. Look at `createEntity` in `entities.ts` for advisory-lock patterns.

## Verification at each sub-task

Before `bd close <sub-task>`:

- [ ] The specific acceptance criteria in `bd show <sub-task> --notes` are met
- [ ] The tests driven by the hardened fixtures pass
- [ ] No regressions in existing test suites (`pnpm test`)
- [ ] Git diff matches what the sub-task's description claimed
- [ ] Actor threading verified via compile-time check (try removing `actor` — compile should fail)

## Verification at end of phase

When all sub-tasks closed:

1. Run full test suite: `pnpm test` — all green
2. Generate final benchmark reports for each Phase 1 scenario
3. Write `docs/handoff/phase1-complete.md` summarising what landed
4. Manually verify via psql that:
   - `fact_history` and `causal_edge_history` tables exist
   - Every row in `facts` has at least one `fact_history` row
   - Every row in `causal_edges` has at least one `causal_edge_history` row
   - Sample a row: confirm actor, reasoning, and previous/new values populated correctly
5. Query `reasoning_reports` to verify the reasoning agent can now call `get_fact_history` and `get_edge_history` (ask it a question that requires reading history)
6. `bd close nmemo-w4j`

## Cross-cutting checklists from the runbook

Before closing any sub-task touching the database:
- [ ] Migration uses `IF NOT EXISTS`
- [ ] Explicit `public.` schema qualifier
- [ ] Idempotent backfill
- [ ] `deleteFromTables` order updated in `platform/src/test/setup.ts`
- [ ] Migration documented in its file header

Before closing any sub-task adding MCP tools:
- [ ] Tool schema registered in `GRAPH_TOOLS`
- [ ] Handler in `handleToolCall` switch
- [ ] MCP health returns the new tool count
- [ ] Test calls the tool via `handleToolCall()` directly
- [ ] Reasoning agent prompt updated if relevant

Before closing any sub-task touching mutation paths:
- [ ] `actor` parameter required
- [ ] Optional `reasoningReportId` accepted
- [ ] `reasoning` accepted where semantic
- [ ] All three passed to audit helpers
- [ ] No default `actor` value anywhere

## When you hit trouble

- **Test fails but code looks right** → check if the fixture is hardened-state or scaffold-state. If fixture is still scaffold, stop and run the skill first.
- **Can't figure out actor for a path** → check doc 10's Actor Model table. If still unclear, file a bead and ask — don't guess.
- **AGE/search_path error** → check `CLAUDE.md` AGE gotchas section.
- **Something else** → save what you know via `bd remember`, file a bead describing the stall, move to the next ready sub-task.

## Commit discipline

- One commit per closed sub-task. Message format: `w4j.N: <one-line>`
- Never `--amend` unless asked
- Never `--no-verify`
- Never `git push --force`
- Commit only specific files — never `git add -A`

## When you're done

1. All sub-tasks `nmemo-w4j.1` through `.10` closed
2. Phase 1 epic `nmemo-w4j` closed
3. `docs/handoff/phase1-complete.md` committed
4. Post a summary in this session: what landed, what you noticed, any gaps for Phase 2 to address

Do not start Phase 2 or any other phase in this session. Phase 1 only.

---

## Notes for the user running this prompt

- **Recommended session model:** Opus (1M context) — Phase 1 touches many files; you want the big context window.
- **Expected duration:** 1-2 multi-turn sessions for a careful TDD pass. Don't rush.
- **Before running:** Verify `nmemo-klv.9` is closed (`bd show nmemo-klv.9`). If not, run the test-harden skill first.
- **After running:** The agent will have closed `nmemo-w4j`. Verify manually via `bd stats` and spot-check a couple of the closed sub-tasks.
- **If the session runs out of context mid-phase:** The agent should have committed each sub-task as it closed. A fresh session can resume by running `bd ready` and reading the last committed handoff doc.
