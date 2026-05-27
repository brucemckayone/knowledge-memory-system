# Reasoning Layer Hardening — Overview

**Status:** Design complete, implementation not started
**Depends on:** Phases A & B (Graph S + Graph C structural foundations)
**Supersedes:** Portions of `03-graph-c-technical-design.md` §3 (Pattern Detection) and §4 (Query Interface) that were deferred as "future work"
**Date:** 2026-04-20

## Purpose

The dual-graph foundation works. Extraction produces entities, facts, and causal events. The causal agent creates edges with mandatory reasoning. But the **reasoning layer on top** is dormant: edges are insert-only with no audit of changes, `causal_patterns` is a schema with no code, and there is no way to ask "what breaks if this fact changes?"

This document series specifies the next stage of hardening — the work that turns the existing structure into a system that:

- **Traces consequences** — for any fact or edge, show what depends on it and what changes if it's modified
- **Remembers how it thought** — every mutation to a fact or causal edge is auditable, with full reasoning and evidence
- **Surfaces conflicts** — when reasoning chains reach opposing conclusions, flag and resolve
- **Discovers structure** — recurring causal patterns emerge and are promoted through a lifecycle

## Scope

Six phases, one document each. All six together are the hardening stage. Phase 0 is a smoke test (no code); Phases 1–6 are implementation.

| # | Document | Focus | Size |
|---|----------|-------|------|
| — | [10 — Overview](10-reasoning-layer-overview.md) | This doc | — |
| 0 | [11 — Smoke Test](11-smoke-test-reasoning-agent.md) | Validate query/patrol end-to-end | S |
| 1 | [12 — Audit Trail Foundation](12-audit-trail-foundation.md) | `fact_history`, `causal_edge_history`, `actor` threading | M |
| 2 | [13 — Edge Lifecycle](13-edge-lifecycle.md) | Corroboration + confidence decay + cascade invalidation | M |
| 3 | [14 — Source Reference Indexing](14-source-reference-indexing.md) | `edge_source_refs` for reverse lookups | S |
| 4 | [15 — Blast Radius Analysis](15-blast-radius-analysis.md) | `analyzeImpact()`, hypothetical scenarios, severity | M |
| 5 | [16 — Contradiction Detection](16-contradiction-detection.md) | SQL heuristics + agent resolution | M |
| 6 | [17 — Pattern Lifecycle](17-pattern-lifecycle.md) | Detection, promotion, matching, ghost detection | L |
| * | [18 — Test Data Hardening Protocol](18-test-data-hardening-protocol.md) | Cross-cutting — recursive agentic loop for data/test improvement. **Precedes all phases.** | — |

## Dependency Graph

```d2
direction: right

phase0: "Phase 0\nSmoke Test\n(no code)" {
  style.fill: "#e0e0e0"
}

phase1: "Phase 1\nAudit Trail\nFoundation" {
  style.fill: "#cfe8ff"
}

phase2: "Phase 2\nEdge Lifecycle\n(corroboration + decay)" {
  style.fill: "#cfe8ff"
}

phase3: "Phase 3\nSource Ref\nIndexing" {
  style.fill: "#cfe8ff"
}

phase4: "Phase 4\nBlast Radius\nAnalysis" {
  style.fill: "#d4edda"
}

phase5: "Phase 5\nContradiction\nDetection" {
  style.fill: "#d4edda"
}

phase6: "Phase 6\nPattern\nLifecycle" {
  style.fill: "#fff3cd"
}

phase0 -> phase1: "validate\nfoundation"
phase1 -> phase2: "audit prereq"
phase1 -> phase3: "audit prereq"
phase1 -> phase5: "audit prereq"
phase2 -> phase6: "decay signals\npattern staleness"
phase3 -> phase4: "reverse lookup\nrequired"
phase5 -> phase4: "contradiction\nseeds impact"

legend: Legend {
  s1: "Foundation" {
    style.fill: "#cfe8ff"
  }
  s2: "Analysis" {
    style.fill: "#d4edda"
  }
  s3: "Discovery" {
    style.fill: "#fff3cd"
  }
}
```

Phases 2, 3, 5 can run in parallel after Phase 1. Phase 4 after Phase 3. Phase 6 after Phase 2.

## Design Principles

### 1. Audit First

Every later capability assumes a proper history exists. Build the audit trail **before** anything mutates state beyond INSERT. Without this, corroboration becomes counter arithmetic, decay becomes silent, and contradictions can't show evolution.

### 2. Explicit Over Implicit

Service-layer writes to history tables, not database triggers. Triggers can't access the reasoning context (which agent, which report, why). The cost is boilerplate; the benefit is every history row carries the `actor`, the `reasoning`, and the `reasoning_report_id` that caused it.

### 3. Append-Only History, Mutable Head

`facts` and `causal_edges` hold current state and can be updated in place. `fact_history` and `causal_edge_history` are append-only — never rewrite history rows. This makes the history authoritative and queryable as a timeline.

### 4. Denormalise For Traversal

`source_references` lives in JSONB today. JSONB is fine for storage but unusable for reverse lookups ("what edges cite this fact?"). Extract to a join table (`edge_source_refs`) indexed for bidirectional traversal. Same pattern applies to pattern membership if scale demands it later.

### 5. Separate Detection From Resolution

Cheap mechanisms (SQL heuristics, structural checks) **detect** contradictions and ghosts. The reasoning agent **resolves** them on patrol. Keep detection side-effect-free and fast; keep resolution thoughtful and auditable.

### 6. Tests Encode Acceptance

Every phase ships with a test harness under `platform/src/test/harness/` that fails before implementation and passes after. Acceptance criteria are **what the tests assert**, not what the docs claim. See each phase doc's "Test Design" section.

### 7. Test Data Is First-Class

Unit tests with hardcoded inputs aren't enough for an agentic system. Every phase delivers **versioned, curated test-data fixtures** at component, integration, and pipeline levels, with benchmark metrics that track quality across iterations. See [doc 18](18-test-data-hardening-protocol.md) for the recursive hardening protocol. **No phase is considered complete without its data sets and benchmark baselines.**

## System Model — After All Phases

```d2
direction: down

graph_s: "Graph S — Knowledge" {
  style.fill: "#cfe8ff"
  style.opacity: 0.6
  entities: "entities"
  facts: "facts\n(mutable head)"
  fact_history: "fact_history\n(append-only)" {
    style.fill: "#fff3cd"
  }
}

graph_c: "Graph C — Causality" {
  style.fill: "#d4edda"
  style.opacity: 0.6
  causal_events: "causal_events"
  causal_edges: "causal_edges\n(mutable head)"
  edge_history: "causal_edge_history\n(append-only)" {
    style.fill: "#fff3cd"
  }
  edge_source_refs: "edge_source_refs\n(reverse lookup)"
  causal_patterns: "causal_patterns\n(lifecycle-managed)"
}

reasoning: "Reasoning Layer" {
  style.fill: "#f8d7da"
  style.opacity: 0.6
  reports: "reasoning_reports"
  contradictions: "contradictions"
  impact_api: "analyzeImpact()"
  agent: "Reasoning Agent\n(patrol + query)"
}

graph_s.facts -> graph_s.fact_history: "every mutation"
graph_c.causal_edges -> graph_c.edge_history: "every mutation"
graph_c.causal_edges -> graph_c.edge_source_refs: "sync on create/update"
graph_s.facts -> graph_c.causal_events: "trigger on change"
graph_c.causal_edges -> graph_c.causal_patterns: "match on creation"

reasoning.agent -> graph_s.fact_history: "reads evolution"
reasoning.agent -> graph_c.edge_history: "reads evolution"
reasoning.agent -> reasoning.contradictions: "detects + resolves"
reasoning.agent -> reasoning.impact_api: "checks before destructive action"
reasoning.agent -> graph_s.facts: "create / expire / revise"
reasoning.agent -> graph_c.causal_edges: "create / corroborate / revise"
reasoning.agent -> reasoning.reports: "saves narrative"

reasoning.impact_api -> graph_c.edge_source_refs: "citation traversal"
reasoning.impact_api -> graph_c.causal_edges: "transitive chains"
reasoning.impact_api -> graph_s.facts: "direct dependents"
```

## Actor Model

Every mutation in the system is attributed to one of seven actors. This is the `actor` field on every history row and resolution record.

| Actor | Who | When |
|-------|-----|------|
| `graph_agent` | Extraction agent (Claude Code CLI with MCP) | During `extract()` — creates facts, causal events, initial edges |
| `reasoning_agent` | Reasoning agent patrol or query mode | During `/api/reason*` — corroborates, revises, creates inferred edges, resolves contradictions |
| `gardener_agent` | Topology gardener | During gardener runs — merges, aliases, structural cleanup |
| `reconciliation_agent` | Reconciliation agent | During `/api/reconcile` — merge candidate resolution |
| `user` | Direct API or UI action | When a human intervenes via endpoints or viz buttons |
| `system_trigger` | Automated periodic job | Decay, SQL heuristic contradiction detection, pattern promotion |
| `cascade` | Downstream effect of another mutation | When expiring fact A cascades to weaken edge B |

Every helper that writes to `fact_history` or `causal_edge_history` requires `actor` as a non-optional parameter. TypeScript's type system enforces this — it's the point.

## Verification — End-to-End Demo

After all six phases are complete, this scenario should run against the MISRA C++ 2023 data loaded today:

```d2
direction: right

step1: "1. Ingest\nMISRA rule summary" {
  shape: step
}
step2: "2. Run patrol\nreasoning agent" {
  shape: step
}
step3: "3. Query impact\nof central rule" {
  shape: step
}
step4: "4. Query mode\nagainst test-bad-code.cpp" {
  shape: step
}
step5: "5. Expire a fact\nvia agent" {
  shape: step
}
step6: "6. Create\ncontradiction" {
  shape: step
}
step7: "7. Detect\npatterns" {
  shape: step
}
step8: "8. Viz\nsanity check" {
  shape: step
}

step1 -> step2 -> step3 -> step4 -> step5 -> step6 -> step7 -> step8
```

Acceptance:
1. **Ingest** — new entities, facts, causal events; history rows with `actor=graph_agent`
2. **Patrol** — reasoning agent finds high-need entities, reads history, creates edges with audit trail, detects contradictions
3. **Impact** — `GET /api/impact/fact/:id` returns full blast radius with severity scores
4. **Query** — agent traces causal chains from bad C++ to MISRA rules, cites evidence from history
5. **Expire** — audit log shows expiry with reasoning and actor; cascade updates downstream edges
6. **Contradiction** — SQL heuristic detects it; reasoning agent resolves on next patrol; resolution audited
7. **Patterns** — detection finds recurring chains, promotes through staging → canonical; ghost detection flags missing links
8. **Viz** — corroboration reflected in edge thickness; contradictions badge shows counts; patterns overlay visible

All operations complete in under 5 seconds for the current data size. All mutations reversible by reading the audit trail.

## Out of Scope (Explicit)

The following are deferred to later stages and must not creep into this plan:

- Epoch detection / hierarchical temporal abstraction (`03-graph-c-technical-design.md` §6)
- Cross-epoch causal bridges
- Adaptive compaction
- Auth / multi-tenancy
- Structured logging migration (console logs remain)
- Load testing at scale (optimise when we feel pain)
- Full UI redesign (viz integrations are additive only)

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| Audit trail inflates DB size | Revisit partitioning at 10K facts. Current scale (~290 facts) is trivially handled. |
| `actor` param threading is invasive | Required. TypeScript forces the change. Accept the churn. |
| Decay formula is a guess | Ship defaults, expose env vars (`DECAY_RATE=0.95`, `DECAY_FLOOR=0.1`, `DECAY_AGE_DAYS=30`), tune with real data. |
| Pattern detection complexity `O(edges^depth)` | Cap chain length (6), lookback window (30 days), result limit (1000). `EXPLAIN ANALYZE` test in CI. |
| Blast radius slow on large graphs | On-demand recursive CTE fine for <5K edges. Materialised view or Redis cache later. |
| Reasoning agent tool budget overrun | Monitor average calls/patrol; raise budget to 150 if needed; prompt prioritises efficient tool use. |
| Contradiction false positives | Start conservative. Let agent dismiss rather than silently suppress. |
| Phase 6 size | Ship detection-only first; defer promotion/matching/ghosts if timeline pressure. |

## Implementation Playbook

Execute phases in dependency order. Each phase lands in a single PR. Commit small, often.

```d2
direction: down

start: "START HERE" {
  shape: diamond
  style.fill: "#fff3cd"
}

p0_run: "Run P0 smoke test\n(nmemo-dey.1)\nDocument findings"
p0_fix: "Any bugs found?\n→ Fix or defer\n(nmemo-dey.2)"

branch_p1: "Phase 1 — Audit Trail" {
  style.fill: "#cfe8ff"
  p1_mig: "Apply 009_audit_trail.sql\n(backfill verified)"
  p1_drizzle: "Drizzle schema"
  p1_svc: "audit.ts helpers"
  p1_thread: "Thread actor through\nfacts.ts + causal.ts"
  p1_mcp: "MCP tools:\nget_fact/edge_history"
  p1_prompt: "Prompt: read history first"
  p1_test: "audit-trail.test.ts ✓"
  p1_reg: "Regression sweep ✓"
  p1_mig -> p1_drizzle -> p1_svc -> p1_thread -> p1_mcp -> p1_prompt -> p1_test -> p1_reg
}

branch_p2_p3_p5: "Parallel after Phase 1" {
  p2: "Phase 2\nEdge Lifecycle" {
    style.fill: "#cfe8ff"
  }
  p3: "Phase 3\nSource Ref Index" {
    style.fill: "#cfe8ff"
  }
  p5: "Phase 5\nContradictions" {
    style.fill: "#d4edda"
  }
}

branch_p4: "Phase 4 after Phase 3" {
  p4: "Phase 4\nBlast Radius" {
    style.fill: "#d4edda"
  }
}

branch_p6: "Phase 6 after Phase 2" {
  p6: "Phase 6\nPattern Lifecycle" {
    style.fill: "#fff3cd"
  }
}

demo: "End-to-End Demo\n(doc 10 Verification section)" {
  shape: diamond
  style.fill: "#d4edda"
}

start -> p0_run -> p0_fix
p0_fix -> branch_p1.p1_mig
branch_p1.p1_reg -> branch_p2_p3_p5.p2
branch_p1.p1_reg -> branch_p2_p3_p5.p3
branch_p1.p1_reg -> branch_p2_p3_p5.p5
branch_p2_p3_p5.p3 -> branch_p4.p4
branch_p2_p3_p5.p2 -> branch_p6.p6
branch_p4.p4 -> demo
branch_p2_p3_p5.p5 -> demo
branch_p6.p6 -> demo
```

### Critical Path

The longest dependency chain — the minimum time to reach end-to-end demo:

```
P0 → P1 → P2 → P6 → Demo
```

Phases 3, 4, 5 can be parallelised with P2 and P6 by a second developer, but none of them shorten the critical path.

### PR Structure

One PR per phase. Each PR must:
1. Apply its migration (if any) first
2. Land all service/MCP changes
3. Add the test harness
4. Update reasoning agent system prompt if applicable
5. Pass all existing tests
6. Include the `docs/handoff/<phase-name>-findings.md` smoke results where applicable

Never bundle two phases into one PR — the audit trail in place during Phase 2 code review must be the audit trail from Phase 1, merged.

### Migration Application Order

Migrations MUST apply in numerical order. Phases build schema incrementally.

| # | Migration | Phase | Can Skip? |
|---|-----------|-------|-----------|
| 009 | `audit_trail.sql` | 1 | No — all later phases depend on it |
| 010 | `source_ref_index.sql` | 3 | No — Phase 4 depends; Phase 2 cascade uses it |
| 011 | `contradictions.sql` | 5 | Yes — only Phase 5 needs it |
| 012 | `pattern_rejected.sql` | 6 | Yes — only Phase 6 needs it (extends existing constraint) |

## Consolidated Reasoning Agent Prompt Changes

Phases 1, 2, 4, 5, 6 all update `ml-services/app/reasoning_agent.py`. The final accumulated prompt has these additions layered over the existing system prompt:

| Phase | Addition | Section |
|-------|----------|---------|
| 1 | Principle #9: "READ HISTORY BEFORE YOU ACT" | REASONING PRINCIPLES |
| 2 | "Edge Strength and Corroboration" guidance | REASONING PRINCIPLES |
| 4 | "Before Destructive Actions — call analyze_blast_radius" | PATROL MODE phase 3 |
| 5 | PHASE 1.5 CONTRADICTIONS block (investigate, resolve) | PATROL MODE |
| 6 | "find_causal_ghosts" in patrol; "get_active_patterns" in query | PATROL and QUERY modes |

Order of application: Phase N's prompt change lands with Phase N's code. Each phase ships its own self-contained prompt update. Phase 1's update must land first since all subsequent phases reference history tools.

## deleteFromTables Ordering

Tests use `deleteFromTables()` from `platform/src/test/setup.ts` with dependency-ordered table names. As phases land, update the canonical ordering:

```typescript
// After all phases, the canonical ordering (dependents first):
await deleteFromTables(
  'contradictions',              // Phase 5
  'causal_edge_history',         // Phase 1
  'fact_history',                // Phase 1
  'edge_source_refs',            // Phase 3
  'causal_edges',                // existing
  'causal_events',               // existing
  'causal_patterns',             // existing (Phase 6 uses)
  'reasoning_reports',           // existing
  'memory_entities',             // existing
  'entity_aliases',              // existing
  'facts',                       // existing
  'entity_merges',               // existing
  'entities',                    // existing
);
```

Each phase adds its tables to the top (dependents before dependencies). Update `setup.ts` as part of each phase's test file PR.

## Beads Tracking

Work is tracked in beads under the **Reasoning Layer Hardening** epic (`nmemo-8vq`). See individual phase docs for their issue lists.

- Epic: `bd show nmemo-8vq`
- Ready work: `bd ready`
- Per-phase tree: `bd list --parent nmemo-<phase-id>`
- Phase issues block on their predecessors per the dependency graph above.
- Intra-phase sub-task dependencies are wired for all phases.

## Operational Concerns

Cross-cutting issues that apply to multiple phases. Each is worth thinking about once at the system level rather than re-deriving in every phase doc.

### Concurrency

**Edge creation races.** Two concurrent `createCausalEdge()` calls for the same `(cause_event_id, effect_event_id)` pair will race: both see no existing edge, both INSERT, one fails on `idx_causal_edges_unique`. The failing one should gracefully fall through to corroboration path. Wrap corroboration check + INSERT in a transaction with `SELECT ... FOR UPDATE` on the unique key OR catch the constraint violation and retry.

**Fact mutation races.** Less likely given serial pipeline, but possible in direct API paths. Advisory locks on `subject_entity_id` follow the existing pattern from `createEntity()`.

### Transactional Boundaries

Every phase has operations that must be atomic:

- **Phase 1**: `createFact()` INSERT + `recordFactChange()` INSERT + `causal_events` trigger — all in one transaction. If audit write fails, roll back the fact.
- **Phase 2**: Corroboration UPDATE + `recordEdgeChange()` + `syncEdgeSourceRefs` — single transaction.
- **Phase 5**: Contradiction resolution dispatch (`expireFact` + update contradiction row) — single transaction.
- **Phase 6**: `matchEdgeToPattern` is fire-and-forget; not transactional with edge creation. If match fails, edge still exists, try again later.

Use Drizzle's `db.transaction(async (tx) => { ... })` wrapper for each.

### Decay State Reset

`decay_applied` is a one-way flag today. If an edge with `decay_applied = true` gets corroborated, should the flag reset? **Yes** — corroboration resets the decay clock. Set `decay_applied = false` on any corroboration UPDATE. Decay can then run again after another 30 uncorroborated days.

### Migration Safety

All migrations are `CREATE TABLE IF NOT EXISTS` + idempotent backfills. Running twice is safe. Rolling forward is safe. **Rolling back is not** — once history rows are written, dropping the table loses audit. If a phase ships a bug, fix forward rather than revert.

**Exception:** If a buggy migration is caught before production, `DROP TABLE IF EXISTS` is fine. Document this as "dev-only rollback" in the migration file.

### Performance Targets

| Operation | Target | Scale |
|-----------|--------|-------|
| `recordFactChange` / `recordEdgeChange` | <10ms | single row |
| `getFactHistory` / `getEdgeHistory` | <50ms | up to 500 rows |
| `applyConfidenceDecay` | <200ms per 100 eligible edges | batched |
| `cascadeFactExpiry` | <500ms | 100 edges affected |
| `syncEdgeSourceRefs` | <10ms | 1-10 refs |
| `findEdgesCitingReference` | <50ms | 1000-edge graph |
| `analyzeImpact` | <500ms | 1000-edge graph, depth 3 |
| `detectContradictions` | <2s | full graph scan |
| `detectCausalPatterns` | <2s | 1000 chains examined |
| `matchEdgeToPattern` | <200ms | fire-and-forget |
| `findCausalGhosts` | <300ms | 10 canonical patterns |

Targets are loose upper bounds. Phase tests enforce them with timing assertions where feasible.

### Handling Large Graphs (Future)

At ~290 facts today, all queries are trivial. At 10K facts:
- Partition `fact_history` and `causal_edge_history` by month (`PARTITION BY RANGE (occurred_at)`)
- Consider materialised views for `analyzeImpact` hot paths
- Batch `applyConfidenceDecay` to avoid long-running transactions

Revisit when `SELECT count(*) FROM facts` returns > 10K. Until then, clarity over cleverness.

### Observability

Each phase adds logging:

- `recordFactChange` / `recordEdgeChange`: `console.log('[audit] fact <id> <event_type> by <actor>')` — quiet by default, gated on `LOG_AUDIT=1`
- `applyConfidenceDecay`: summary line only (`[decay] <n> decayed, <n> expired`)
- `cascadeFactExpiry`: summary line only
- `detectContradictions`: per-type counts
- `detectCausalPatterns`: chains examined, new staging, promoted

No structured logging framework until pain is felt. Revisit at Phase 6 completion.

### Testing Against Real Data

Every phase's tests use `deleteFromTables` to start fresh. But the real validation is running the `/api/reason/query` flow against the loaded MISRA data and seeing correct behaviour end-to-end. This is the demo in doc 10's Verification section — treat it as acceptance for the entire series, not any single phase.

Phase 0 establishes the baseline. Later phases should re-run it as regression.

## Design Decisions & FAQ

Likely questions a developer will hit when implementing this. Each answer explains the rejected alternative and the reason we didn't pick it.

### Why service-layer audit writes, not triggers?

Triggers can fire at INSERT/UPDATE but cannot see the reasoning context: which agent made the call, what justification they gave, which `reasoning_report_id` is the parent. We could stash that in session variables or temp tables, but every mutation path would need to set them first — that's more invasive than just passing `actor` and `reasoning` in the service params. The service-layer approach gives us compile-time enforcement (`actor` is required) and explicit callsites. Triggers are great for simple invariants (e.g., `causal_events` auto-created on fact change); they're wrong for narrative audit.

### Why two history tables (`fact_history`, `causal_edge_history`), not one `mutations_log`?

Considered a single polymorphic audit table with `entity_type` + `entity_id` columns. Rejected because:
1. **Different fields matter.** Facts track confidence and bi-temporal timestamps; edges track strength and reasoning text. A polymorphic table would have 20+ nullable columns.
2. **Query patterns diverge.** "Show the full history of fact X" is common; cross-type queries are rare.
3. **Schema evolution is easier.** When Phase 2 adds edge-specific semantics (corroboration, decay), we don't bloat the fact audit shape.

Two tables with clear columns > one table with a union of all possibilities.

### Why append-only history, not `valid_at`/`invalid_at` on the history rows?

History is a timeline of **observations about the fact**, not a timeline of the fact's validity. The fact itself has bi-temporal validity already. History rows say "at time T the agent observed X and acted on it" — that observation is frozen. If the observation was wrong, a new history row records the correction, not a mutation of the original.

### Why does `decay_applied` reset on corroboration?

`decay_applied` is a flag for "this edge has been through the decay clock at least once." If corroboration re-asserts the edge, the clock restarts. Without reset, a once-decayed edge that gets corroborated 10 times would still be marked as decayed, losing a useful signal. The field is a lifecycle state, not a permanent tombstone.

### Why 30 days as the decay age threshold?

Round number, easy to reason about. Tunable via `DECAY_AGE_DAYS` env var. The goal is "fade edges that haven't received reinforcement in a reasonable time" — 30 days feels right for a system that ingests data weekly, but should be shortened (e.g., 7 days) for systems ingesting hourly. Phase 2 ships 30 as default and lets production tune it.

### Why 3 instances for pattern staging?

Below 3 is noise; patterns at 2 are coincidences. 3 is the minimum where "recurrence" carries signal. Threshold tunable via `PATTERN_STAGING_THRESHOLD`. Higher thresholds (e.g., 10) wait longer but surface more stable patterns; lower thresholds (e.g., 2) surface more noise. 3 is a defensible starting point.

### Why not embed causal edges in the AGE graph with mutations?

AGE edge properties don't persist via SET in our version (documented in CLAUDE.md). The AGE `causal_graph` is a **traversal index**, not authoritative state. Canonical state lives in `public.causal_edges`; AGE gets synced via triggers on INSERT. For mutations (corroboration, decay, expiry), we update the PostgreSQL row and let AGE lag. Cypher traversal reads from AGE; detail lookup reads from Postgres.

### Why not use Graph C's `causal_graph` AGE store for blast radius?

Could use AGE Cypher for the recursive chain walk. Rejected because:
1. **Postgres recursive CTE is fast enough** at current scale
2. **Citation dependents aren't in AGE** — they're in `edge_source_refs` (Postgres join table)
3. **Severity scoring needs Postgres data** (corroboration counts, source references)

Mixing Cypher + Postgres would add complexity for no benefit. Keep it in SQL.

### Why reasoning agent for contradiction resolution, not automated SQL?

SQL heuristics detect mechanical contradictions (opposing_object, temporal_impossible). They CAN'T decide which side is right — that requires reasoning over evidence. Some contradictions should resolve to `both_valid` (temporal windowing explains both). An SQL-only resolver would force a binary pick and lose information. The reasoning agent reads both sides' histories and sources, then chooses. Every resolution is auditable via `resolution_reasoning`.

### Why does pattern matching fire-and-forget from `createCausalEdge`?

Matching is expensive (query 10+ patterns, check template alignment). Blocking edge creation on it would slow ingestion. If the match fails due to a bug or race, the edge still exists — pattern detection will pick it up on the next scan. Losing a match is acceptable; losing the edge is not.

### Why Haiku for pattern naming, not user-provided?

Pattern naming is a good Haiku job: structured input (template + metrics), structured output (name + description), low creativity threshold. A user could provide names, but patterns emerge faster than anyone can name them. Haiku-first with human override (update via direct SQL or a future endpoint) is the pragmatic default.

### What if the reasoning agent creates contradictory edges during a single patrol?

A real risk. Mitigations:
1. The agent reads `get_edge_history` before mutating — sees prior reasoning
2. Contradiction detection runs on the pipeline counter, catches the result on next cycle
3. Patrol tool budget (100) limits how many edges a single run can create

If the agent is actively working against itself, the prompt needs fixing, not the schema. Instrument via the `reasoning_reports.actions_taken` field and review for anti-patterns.

### How do I test Phase 6 when there's no graph data yet?

Each Phase 6 test builds synthetic chains via `setupTypedChain()` helpers. Tests don't require real MISRA data. The end-to-end demo does — but that runs after all phases ship, against the live graph.

### Can I skip Phase 5 if contradictions aren't urgent?

Yes. Phase 5 is parallel to Phase 2, 3; only Phase 4 (blast radius) and Phase 6 (patterns) have dependents. Ship Phase 1 → 3 → 4 → 6 first, add 2 and 5 later. Phase 5's `expired_but_cited` detection can be backfilled anytime.

### What's the minimum shippable subset?

Phase 0 + 1 + (2 OR 3) is the smallest useful deliverable. Phase 1 alone gives audit trail. Adding Phase 2 gives the lifecycle story. Adding Phase 3 enables Phase 4 later. Phase 5 and 6 are valuable but not critical for the first milestone.

## Auto-trigger for the reasoning patrol (bead nmemo-2yv.71)

The reasoning patrol is **scheduled (time-driven) with a freshness gate**. The decision space and the choice are:

| Anchor | Why rejected |
|---|---|
| Post-ingest counter (mirror gardener) | Patrol is ~minutes wall-clock (Claude Code subprocess, 40-70 MCP calls). Cheap signals like "facts since last patrol" don't capture whether the graph has actually moved in a way that matters for reasoning. |
| Contradiction-detection event | Reactive, but misses the broader "graph has gained mass; look for new structure" case that patrol is for. Useful as a future targeted-query trigger (see open question below); not the right primary anchor. |
| Composite | Multiplies moving parts before evidence of need. |
| **Scheduled + freshness-gated (chosen)** | Reuses the existing `src/scheduler.ts` (bead `.84`) infrastructure. The cadence is the spawn-storm guard. The freshness gate (entity_meta + reasoning_reports) prevents wasted spawns when the graph is quiet. |

**Cadence and cooldown.** `REASONING_PATROL_INTERVAL_MIN` (default 30 minutes) is both the cadence and the cooldown — node-cron only fires the next tick after the interval elapses. `REASONING_PATROL_CRON` (raw 5-field expression) overrides the convenience knob when set. Both knobs follow the same precedence as `DRIFT_PATROL_CRON` / `DRIFT_PATROL_INTERVAL_MIN`.

**Freshness gate.** `src/scheduler.ts:checkReasoningFreshness()` reads three rollups and skips the fire when nothing has moved:

- `max(entity_meta.last_mentioned_at)` — bumped by extraction
- `max(entity_meta.last_reasoned_at)` — bumped by `save_reasoning_report`
- `max(reasoning_reports.created_at)` — bumped by every patrol or query pass

Fire iff `max_mentioned > max(max_reasoned, last_report_at)`. Strict `>` so a patrol that touches the same entity doesn't self-retrigger. Cold-start (no mentions yet) → skip. First-ever patrol (mentions exist, no prior reasoning anchor) → fire. DB failure on the gate → fail-open (fire) — better to over-spend on patrol than to silently stop running it.

**Retention of manual paths.** `POST /api/reason` and `POST /api/reason/query` remain functional as debug surfaces (per the architectural principle that viz is a debug surface — doc 34 §3). The scheduler invokes the same `/api/reason` endpoint over the in-process port, so manual and scheduled fires share the same logging, invocation_id minting, and timeout-to-504 path.

**Open question deferred to a follow-up bead.** Whether a newly-detected contradiction should fire a *targeted* `mode='query'` pass on the implicated entities (in addition to contributing to the patrol cadence) is not decided here. The contradiction-detection path remains untouched by `.71`. See `nmemo-2yv.72` for the related decoupling work on pattern-detection cadence.

**Cross-reference.** Doc 32 §2 reasoning_patrol row reflects this decision; doc 32 §3 lists it under the Scheduled taxonomy.

## Related Documents

- `03-graph-c-technical-design.md` — original causal layer design (this series hardens it)
- `06-graph-meta-layer.md` — entity resolution signals (separate track, already shipped)
- `09-graph-quality-issues.md` — bugs found during earlier hardening
- `issues/06-reasoning-agent.md` — reasoning agent design (this series builds on it)
