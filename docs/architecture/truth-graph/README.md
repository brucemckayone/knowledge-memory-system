# Truth Graph Architecture

Technical direction for the Mnemo knowledge graph system — dual-graph architecture with perpendicular causality.

## Reading Order

| # | Document | What It Covers |
|---|----------|----------------|
| 00 | [Position Paper](00-position-paper.md) | Research-grounded proposal for the perpendicular causal graph. Novelty assessment, citations, open problems. Start here for the "why". |
| 01 | [Dual-Graph Architecture](01-dual-graph-architecture.md) | Conceptual design — Graph S + Graph C, emergent ontology, semantic alignment, lifetime-scale. The "how it works". |
| 02 | [Graph S Hardening](02-graph-s-hardening.md) | Immediate bug fixes framed as Graph C prerequisites. Entity dedup, relationship matching, ontology wiring. The "what to fix now". |
| 03 | [Graph C Technical Design](03-graph-c-technical-design.md) | Schema, causal extraction pipeline, pattern detection, query interface. The "what to build next". |
| 04 | [Sparse Branch Design](04-sparse-branch-design.md) | Minimal implementation branch — stripped orchestration, full data infrastructure (PG, Qdrant, Ollama, Anthropic). Synchronous pipeline, Haiku causal agent with tools, store/extract decoupling. D2 diagrams, file inventory, implementation phases. The "how to work on it". |

## Status

- **Graph S:** ~80% built. Critical bugs documented in 02. Fixes are the immediate priority (Phase A of sparse branch).
- **Graph C:** Designed in 03. Build after Graph S hardening (Phase B of sparse branch).
- **Causal Agent:** Haiku with tool-use — agentic reasoning over Graph S + Qdrant + Graph C. Detailed in 03 Section 2.2 and 04 Section 5.
- **Emergent Ontology:** Designed in `docs/design/living-ontology.md`, partially coded. Wiring documented in 02 Section 6.
- **Lifetime-Scale:** Conceptual design in 01 Section 6. No implementation yet.

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
