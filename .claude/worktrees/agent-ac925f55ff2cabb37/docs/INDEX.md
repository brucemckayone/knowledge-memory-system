# Mnemo Documentation

**Last Updated:** 2026-03-17

---

## Project Status

| Phase | Name | Packets | Status |
|-------|------|---------|--------|
| 0 | Research | — | ✅ Complete |
| 1 | Foundation | W01–W07 | ✅ Mostly Complete |
| 2 | Core Skills & Processing | W08–W15 | ✅ Complete |
| 3 | Entity & Temporal Foundation | W16–W21 | ✅ Mostly Complete |
| 4 | KARMA Agents | W22–W29 | ✅ Complete |
| 5 | Intelligence & Insights | W30–W33 | ❌ Not Started |
| 6 | Multi-Source Ingestion | W34–W42 | ❌ Not Started |

**Key blockers:**
- Phase 3: AGE graph traversal underutilized
- Phase 4: Full pipeline end-to-end hardening needed

---

## Documentation Map

### Architecture
- [Current Architecture](./architecture/current.md) — System design, data flow, component details
- [V2 Design](./architecture/v2-design.md) — Two-layer architecture: Truth Machine + Interpretation Layer
- [Diagrams](./architecture/diagrams/) — D2 diagrams (full system, scaling)

### Work Packets
- [Work Packet Index](./work-packets/INDEX.md) — Full W01–W42 packet listing with per-packet status
- [Improvements](./work-packets/improvements/INDEX.md) — Cross-cutting domain audits
- Phase specs: [Phase 1](./work-packets/phase1/) | [Phase 2](./work-packets/phase2/) | [Phase 3](./work-packets/phase3/) | [Phase 4](./work-packets/phase4/) | [Phase 5](./work-packets/phase5/) | [Phase 6](./work-packets/phase6/)

### Vision
- [Product Concept](./vision/product-concept.md) — Core vision and feature set
- [Cognitive Platform V2](./vision/cognitive-platform-v2.md) — Next-generation platform direction
- [Future Concepts](./vision/future-concepts.md) — Long-term ideas and explorations

### Research
- [Gardener Research](./research/gardener-research.md) — KARMA agent architecture research
- [Model Research](./research/model-research.md) — LLM/embedding model selection
- [Architecture Review](./research/architecture-review.md) — System architecture review
- [System Map](./research/system-map.md) — Component mapping

---

## Quick Links

**New to the project?** Start with [Current Architecture](./architecture/current.md), then browse [Work Packet Index](./work-packets/INDEX.md).

**Working on a packet?** Find it in the [Work Packet Index](./work-packets/INDEX.md) and check the phase README for context.

**Understanding KARMA agents?** Read [Gardener Research](./research/gardener-research.md), then [Phase 4 packets](./work-packets/phase4/).

---

*This file is the single source of truth for project status and documentation navigation. Previously tracked in `TECHNICAL_PLAN.md` (retired) and `work-packets/README.md` (now `work-packets/INDEX.md`).*
