# Truth Graph Architecture

Technical direction for the Mnemo knowledge graph system — dual-graph architecture with perpendicular causality.

## Reading Order

### Foundations (00–09)

| # | Document | What It Covers |
|---|----------|----------------|
| 00 | [Position Paper](00-position-paper.md) | Research-grounded proposal for the perpendicular causal graph. Novelty assessment, citations, open problems. Start here for the "why". |
| 01 | [Dual-Graph Architecture](01-dual-graph-architecture.md) | Conceptual design — Graph S + Graph C, emergent ontology, semantic alignment, lifetime-scale. The "how it works". |
| 02 | [Graph S Hardening](02-graph-s-hardening.md) | Immediate bug fixes framed as Graph C prerequisites. Entity dedup, relationship matching, ontology wiring. |
| 03 | [Graph C Technical Design](03-graph-c-technical-design.md) | Schema, causal extraction pipeline, pattern detection, query interface. |
| 04 | [Sparse Branch Design](04-sparse-branch-design.md) | Minimal implementation branch — stripped orchestration, synchronous pipeline, Haiku causal agent with tools. |
| 05 | [Temporal Pipeline Redesign](05-temporal-pipeline-redesign.md) | Two-phase ingestion — parallel extract, sequential commit. |
| 06 | [Graph Meta Layer](06-graph-meta-layer.md) | Entity resolution via source vector centroids + memory overlap + structural similarity. |
| 07 | [Graph Agent Workflow](07-graph-agent-workflow.md) | Unified 5-phase extraction: Orient → Extract → Relate → Cause → Verify. |
| 08 | [Visualization Techniques](08-visualization-techniques.md) | D3 force-directed graph, temporal scrubber, multi-layer rendering. |
| 09 | [Graph Quality Issues](09-graph-quality-issues.md) | Catalogued bugs and resolution tracking. |

### Reasoning Layer Hardening (10–17) — Current Focus

| # | Document | Phase |
|---|----------|-------|
| 10 | [Reasoning Layer Overview](10-reasoning-layer-overview.md) | Roadmap — anchor for 11-17 |
| 11 | [Smoke-Test Reasoning Agent](11-smoke-test-reasoning-agent.md) | Phase 0 — validate end-to-end (no code) |
| 12 | [Audit Trail Foundation](12-audit-trail-foundation.md) | Phase 1 — `fact_history`, `causal_edge_history`, actor threading |
| 13 | [Edge Lifecycle](13-edge-lifecycle.md) | Phase 2 — corroboration + decay + cascade |
| 14 | [Source Reference Indexing](14-source-reference-indexing.md) | Phase 3 — reverse lookup index |
| 15 | [Blast Radius Analysis](15-blast-radius-analysis.md) | Phase 4 — impact trees + hypothetical scenarios |
| 16 | [Contradiction Detection](16-contradiction-detection.md) | Phase 5 — SQL heuristics + agent resolution |
| 17 | [Pattern Lifecycle](17-pattern-lifecycle.md) | Phase 6 — detection, promotion, matching, ghosts |
| 18 | [Test Data Hardening Protocol](18-test-data-hardening-protocol.md) | Recursive agentic test-data improvement loop — required for every phase |
| 19 | [Implementation Runbook](19-implementation-runbook.md) | Step-by-step for picking up and closing a phase. Checklists for migration, MCP tools, actor threading, pitfalls. |

### Cycle synthesis (31)

| # | Document | What It Covers |
|---|----------|----------------|
| 30 | [MCP Transport](30-mcp-transport.md) | Canonical two-transport contract for the agent flows. MCP path (Claude Code subprocess + stdio MCP server) vs Pi bridge path (HTTP). LLM_PROVIDER env-var switch, parity contract, write-tool serialisation, health-probe semantics, server-identity invariant. T1 / T9 / T11 / T13 cure (bead `nmemo-2yv.125`). |
| 31 | [Review Cycle Synthesis](31-review-cycle-synthesis.md) | Cross-feature synthesis of Reviews #1–#13 (May 2026). Themes (T1/T7/T8/T9/T10/T11/T12/T13 + transport divergence), compose gaps, cross-cutting findings, prioritised landing roadmap. Read this after any per-feature arch doc to understand the cross-cutting context. |
| 32 | [Compute-trigger registry](32-compute-trigger-registry.md) | Canonical list of every graph compute (graph_stats / topology / clustering / drift / cross_cluster / gardener / reconciliation / reasoning_patrol / pattern_detection / decay) with its trigger condition, cadence, runs table, and source code path. PR contract: new computes must add a row in the same PR. T12 cure (bead `nmemo-2yv.131`). |

> **README catalogue is stale beyond doc 19** — docs 20–30 exist on disk but aren't yet listed here. See nmemo-2yv for cleanup tracking. (Doc 32 IS listed above; the catalogue stub from doc 20 onwards needs a separate sweep.)

## Status

- **Graph S:** Hardened. Frankenstein regression passing. Entity resolution + merge lifecycle working.
- **Graph C:** Structural foundation built (Phase B). Causal events emit on fact changes; edges can be created with reasoning + source_references.
- **Reasoning Layer:** Currently being hardened via 10–17 (this series). Audit trail is the bedrock; lifecycle, blast radius, contradictions, and patterns layer on top.
- **Reasoning Agent:** Patrol + query modes built, the full `GRAPH_TOOLS` catalogue via the MCP / Pi transports (see [doc 30](30-mcp-transport.md)), never smoke-tested end-to-end (Phase 0 of this series).
- **Lifetime-Scale:** Conceptual design in 01 Section 6. No implementation yet — deferred until reasoning layer is stable.

## Key Decisions

1. **Causality is perpendicular.** Graph C is a separate data structure, not embedded in Graph S. Different node types, different query patterns, different evolution.
2. **Causal extraction is agentic.** Haiku with tool-use actively queries the graph, vector store, and existing causal chains. It does not just parse text for causal markers — it reasons over the full history.
3. **Every causal edge is auditable.** Detailed reasoning + structured source references (memories, facts, entities) on every edge. Non-negotiable.
4. **Ontology is emergent.** No predefined schema for entities, predicates, or causal patterns. Everything converges from data. Deterministic patterns become apparent as graphs are built out.
5. **Semantic vectors for alignment.** Entity resolution, cross-epoch alignment, and pattern similarity all use the same embedding-based mechanism.
6. **Fix Graph S first.** Graph C built on a fragmented state graph is worthless. Entity dedup and relationship matching are non-negotiable prerequisites.
7. **Infrastructure stays, orchestration goes.** The sparse branch strips the KARMA agent framework, pg-boss, Telegram bot, and Hono server. It keeps PostgreSQL, Qdrant, Ollama, Python ML services, and Claude Code CLI.

## Related Documents

- `docs/design/living-ontology.md` — Predicate intelligence benchmarks and three-layer design
- `docs/architecture/v2-design.md` — Two-layer architecture (Truth Machine + Interpretation Layer)
- `docs/handoff/truth-graph-findings.md` — Frankenstein test results and bug catalogue
- `docs/research/gardener-research.md` — KARMA agent research and bi-temporal model
