# Implementation Runbook — Picking Up a Phase

**Parent:** [10 — Reasoning Layer Overview](10-reasoning-layer-overview.md)
**Purpose:** Practical step-by-step for a developer starting implementation of any phase.

## Before You Start

### Prerequisites

1. **Read in order:**
   - `10-reasoning-layer-overview.md` — full context
   - Your target phase doc (11-17)
   - `18-test-data-hardening-protocol.md` — test data strategy
2. **Claim the phase:** `bd update <phase-id> --claim` (e.g., `bd update nmemo-w4j --claim` for Phase 1)
3. **Read prior reasoning reports:** any previous work on this area lives in `reasoning_reports` table — query for context:
   ```sql
   SELECT mode, question, LEFT(report, 400) FROM reasoning_reports ORDER BY created_at DESC LIMIT 10;
   ```
4. **Verify services running:** `make health`
5. **Check `bd ready`** — work only on unblocked sub-tasks

## Development Loop (per sub-task)

```d2
direction: down

claim: "bd update <id> --claim" {
  shape: step
  style.fill: "#cfe8ff"
}

fixture: "Write / update test fixture\n(if new scenario)" {
  shape: step
}

write_test: "Write failing test\n(TDD style)" {
  shape: step
}

implement: "Implement code\nmigrate DB if needed" {
  shape: step
}

run: "pnpm vitest run\n<your-test>" {
  shape: step
  style.fill: "#d4edda"
}

verify: "All assertions pass?" {
  shape: diamond
  style.fill: "#fff3cd"
}

report: "Write benchmark report\ndocs/benchmark-reports/\nor in-fixture dir" {
  shape: step
}

regression: "Run full test suite\npnpm test" {
  shape: step
}

close: "bd close <id>" {
  shape: step
  style.fill: "#cfe8ff"
}

claim -> fixture -> write_test -> implement -> run -> verify
verify -> implement: "fail — fix code"
verify -> report: "pass"
report -> regression
regression -> close: "no regression"
regression -> implement: "regression found"
```

## Per-Phase Starting Point

### Phase 0 — Smoke Test

Start with `bd show nmemo-dey.1`. Run the playbook in `docs/architecture/truth-graph/11-smoke-test-reasoning-agent.md`. Document findings in `docs/handoff/reasoning-smoke-test-findings.md`. File bugs as `bd create --parent nmemo-dey` sub-tasks. No code until Phase 0 is green.

### Phase 1 — Audit Trail

Start with `bd show nmemo-w4j.1` (migration). Then `.2` (schema). Then `.3` (audit.ts). Then branch: `.4` and `.5` run in parallel.

```bash
# Claim and migrate
bd update nmemo-w4j.1 --claim
pnpm drizzle-kit generate:pg  # after adding migration
pnpm db:migrate

# Verify backfill
psql -h localhost -p 5433 -U postgres mnemo -c "
  SET search_path = ag_catalog, public;
  SELECT count(*) FROM fact_history;
  SELECT count(*) FROM causal_edge_history;
  SELECT count(*) FROM facts;  -- should equal fact_history with event_type='created'
"

bd close nmemo-w4j.1
```

### Phase 2 — Edge Lifecycle

Start with `bd show nmemo-e2i.1`. Corroboration must work before decay — decay needs accurate `corroboration_count` to skip corroborated edges.

Critical: **Phase 2.4 (cascade) is blocked by Phase 3.4 (findEdgesCitingReference)**. Build Phase 3 in parallel or before committing Phase 2 cascade.

### Phase 3 — Source Reference Indexing

Start with migration, backfill, then the `findEdgesCitingReference` service function. Multiple downstream phases depend on this — ship it fast.

### Phase 4 — Blast Radius

Depends on Phase 3 being complete. Start with `impact.ts` skeleton and direct dependents, then transitive chains (reuse recursive CTE pattern from `traceCauses`), then citations via Phase 3, then severity, then hypothetical.

### Phase 5 — Contradictions

Independent of Phases 2-4 but needs Phase 1. Start with migration + schema, then all four SQL heuristics in parallel (each is independent), then resolver, then MCP tools.

### Phase 6 — Patterns

Biggest phase. Start with chain collection CTE (reuse pattern from `traceCauses`), then normalisation, then clustering/upsert. Promotion + matching + ghosts come after detection is working on Level 1 fixtures.

## Test Data Workflow

For every code sub-task, check if corresponding test data exists under `platform/src/test/data/phase<n>-*/`:

- **No fixture?** Write one first. Reference `phase1-audit/fixtures/simple-mutations.sql` as format.
- **Fixture exists but no expected?** Write expected JSON. Reference `phase1-audit/expected/simple-mutations.expected.json`.
- **Both exist?** Good — run test, measure, write benchmark report.

After any phase work, update its benchmark report with new metrics.

## Migration Safety Checklist

Every migration sub-task MUST:

- [ ] Use `IF NOT EXISTS` on all CREATE statements
- [ ] Include explicit `public.` schema qualifier (per AGE search_path gotcha)
- [ ] Back-fill existing data idempotently (ON CONFLICT DO NOTHING)
- [ ] Be testable via `test/setup.ts` infrastructure (deleteFromTables must handle new tables)
- [ ] Document the migration in its file header (what + why)

## MCP Tool Addition Checklist

When adding new MCP tools (e.g., `get_fact_history`, `analyze_blast_radius`):

- [ ] Add tool schema to `GRAPH_TOOLS` in `platform/src/services/causal-agent.ts`
- [ ] Add handler in the `switch (name)` block of `handleToolCall`
- [ ] Verify MCP health endpoint returns the new tool: `curl localhost:3001/api/mcp-health`
- [ ] Add test that calls the tool via `handleToolCall()` directly
- [ ] Update reasoning agent system prompt if the tool changes agent behaviour
- [ ] Update tool count mentioned in `11-smoke-test-reasoning-agent.md` acceptance criteria

## Actor Threading Checklist

Every service mutation function must:

- [ ] Accept `actor: Actor` as a required parameter
- [ ] Accept optional `reasoningReportId?: string`
- [ ] Accept `reasoning: string` where the change is semantic (not just CRUD)
- [ ] Pass all three to `recordFactChange()` or `recordEdgeChange()`
- [ ] Never default `actor` — the type system rejects missing values at compile time

MCP tool handlers set `actor` from their invocation context:
- `invokeGraphAgent` → `graph_agent`
- `invokeReasoningAgent` → `reasoning_agent`
- `invokeGardenerAgent` → `gardener_agent`
- `invokeReconciliationAgent` → `reconciliation_agent`
- Direct HTTP endpoint handlers → `user`
- Periodic triggers (decay, detection) → `system_trigger`
- Cascade paths (called from another mutation) → `cascade`

## Common Pitfalls

### Forgetting session search_path

AGE requires `ag_catalog` in search_path. Both the database-level setting AND migration files need it:

```sql
-- Wrong: implicit search_path
CREATE TABLE facts_history (...);  -- might land in ag_catalog!

-- Right: explicit schema
CREATE TABLE public.facts_history (...);
```

### Forgetting to update deleteFromTables order

When adding a new table, update `platform/src/test/setup.ts`'s `deleteFromTables` to include it in the correct dependency order (dependents before dependencies). Otherwise tests fail with FK violations.

### Running tests against dirty DB

Every test uses `deleteFromTables` in `beforeEach`. Don't assume a clean state — always clear.

### Async audit writes

The audit write MUST be in the same transaction as the mutation. Do NOT use fire-and-forget for `recordFactChange` / `recordEdgeChange`. If the main write succeeds but audit fails, the system is inconsistent.

### Over-eager cascade

Cascade invalidation should be bounded. Don't recursively cascade further than 2-3 hops — leave the rest to the reasoning agent on next patrol. Unbounded cascade can expire large portions of the graph in a single API call.

## Closing a Phase

When all sub-tasks are closed:

1. Run full test suite: `pnpm test`
2. Generate final benchmark report for each scenario
3. Update phase doc with "Delivered" section listing actual commits/PRs
4. `bd close <phase-id>`
5. Announce to stakeholders via handoff doc `docs/handoff/phase<n>-complete.md`

Phase is **not closed** if:
- Any sub-task is open or blocked
- Benchmark metrics fall below targets without explanation
- Regression in an earlier phase's tests

## Related Docs

- `10-reasoning-layer-overview.md` — big picture
- Each phase doc (`11-17`) — detailed specs
- `18-test-data-hardening-protocol.md` — test data methodology
- `CLAUDE.md` (root) — project instructions and conventions
