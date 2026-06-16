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
| 29 | [Integrations layer](29-integrations-layer.md) | Canonical design for the three platform-side boundary modules: `ml-client.ts` (TS→Python ML service), `qdrant.ts` (TS→Vector DB), `pi-agent-bridge.ts` (Python→TS HTTP server). Process topology + port table, TS→Python→TS round-trip, startup ordering, per-module contracts (retry policy, dimension invariant, write-tool serialisation, timeout race), and how the boundary checks compose into `/health` + `validateStartup`. Bead `nmemo-2yv.110`. |
| 30 | [MCP Transport](30-mcp-transport.md) | Canonical two-transport contract for the agent flows. MCP path (Claude Code subprocess + stdio MCP server) vs Pi bridge path (HTTP). LLM_PROVIDER env-var switch, parity contract, write-tool serialisation, health-probe semantics, server-identity invariant. T1 / T9 / T11 / T13 cure (bead `nmemo-2yv.125`). |
| 31 | [Review Cycle Synthesis](31-review-cycle-synthesis.md) | Cross-feature synthesis of Reviews #1–#13 (May 2026). Themes (T1/T7/T8/T9/T10/T11/T12/T13 + transport divergence), compose gaps, cross-cutting findings, prioritised landing roadmap. Read this after any per-feature arch doc to understand the cross-cutting context. |
| 32 | [Compute-trigger registry](32-compute-trigger-registry.md) | Canonical list of every graph compute (graph_stats / topology / clustering / drift / cross_cluster / gardener / reconciliation / reasoning_patrol / pattern_detection / decay) with its trigger condition, cadence, runs table, and source code path. PR contract: new computes must add a row in the same PR. T12 cure (bead `nmemo-2yv.131`). |
| 34 | [Architectural principles](34-architectural-principles.md) | Three cross-cutting rules: (1) users invoke agents only, (2) the DB drives background cadences, (3) the viz app is a debugging surface. Decision boundaries for new cadences, viz features, and manual-vs-auto endpoints. Upstream principle that doc 32 enforces. Bead `nmemo-2yv.73`. |
| 35 | [Reconciliation Agent](35-reconciliation-agent.md) | Canonical design for the post-extraction identity-resolution agent. Three trigger surfaces (pipeline auto-trigger via `.61`, drift-driven via `.83`, manual `/api/reconcile`), three terminal verdicts (same_as / merge / distinct), tool roster (15 tools, 50-call budget), reasoning + source-evidence invariants. Absorbs the deleted `RECONCILIATION_AGENT_REVIEW.md` from repo root. Bead `nmemo-2yv.70`. |
| 36 | [Gardener Agent](36-gardener-agent.md) | Canonical design for the topology-exploring maintenance agent. Two trigger surfaces (pipeline counter every-N-runs, manual `/api/garden`), four-phase workflow (MAP / INVESTIGATE / ACT / REPORT), locked merge-vs-same-as criteria, full tool roster (80-call budget). Open audit gaps: `.66` createdBy attribution + `.67` auto-trigger persistence. Bead `nmemo-2yv.70`. |
| 37 | [Entity Living Summary](37-entity-living-summary.md) | Canonical design for the agent-authored `entity_meta.summary` feature. Names the sole writer (causal agent's `update_entity_summary` tool), the readers (agent in-loop tools + `entity-profile.ts` assembler + `/api/viz/unified`), the T8 prompt-safety contract (cap, sanitise, delimited wrapper, system clause), the optimistic-locking semantics (`summary_updated_at` precondition post-`.55`), and the staleness model (per-column timestamp distinct from `entity_meta.updated_at`). Cross-link from doc 06 §`entity_meta`. Bead `nmemo-2yv.59`. |
| 38 | [Graph-Anchored Fallback Retrieval](38-graph-anchored-fallback-retrieval.md) | Fallback retrieval path that fires when flat vector search fails: anchor on a known node, walk the entity/fact graph, fetch unit-grained evidence behind neighbours' facts, re-rank against the query. Recovers recall a flat search structurally can't reach. Booster-not-guarantee + unit-grained invariants. Epic `nmemo-0wq`. |
| 39 | [Natural-Language Graph Querying](39-natural-language-graph-querying.md) | Discussion / position doc (hardened via a fleet review — code grounding + SOTA research + adversarial critique). Reframes the query path: the LLM orchestrates + narrates, it does NOT translate NL→Cypher (verified — templated Cypher in `graph.ts`); retrieval/traversal is already deterministic. Proposes a tiered model (Tier 0 no-agent vector-anchor + structured-filter + traversal, Tier 1 synthesis on request, Tier 2 full agent), routed by confidence-gated escalation. Key code-grounded facts: fact embeddings are **already shipped** (`facts.fact_embedding`, `searchFacts()`); no structured fact-query API exists yet to consume Tier 0 constraints (`getEntityFacts` hardcodes `NOW()`); Tier 0 can be confidently wrong on a mis-grounded constraint. Cites LazyGraphRAG / LightRAG / HippoRAG 2 / CRAG / Adaptive-RAG. No bead yet. |

> **README catalogue is stale beyond doc 19** — docs 20–30 exist on disk but aren't yet listed here. See nmemo-2yv for cleanup tracking. (Docs 32, 34, 35, 36, 37 ARE listed above; the catalogue stub from doc 20 onwards needs a separate sweep.)

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
