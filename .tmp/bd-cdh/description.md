# Lesson Agents WebSearch + Ingest: Close the Loop

## Problem

The lesson pipeline (outliner → prose writer → artifact generator → composer) currently relies entirely on Claude's parametric knowledge. For technical and rapidly evolving topics (WebGPU browser support, new framework releases, current event analysis), this caps lesson accuracy and currency. Learners receive guidance grounded in training data cutoffs, not real-world state.

Parametric-only knowledge forces pedagogical compromises:
- Prose writers cite features/APIs from outdated versions.
- Outliner skips topics too recent for the model to have learned.
- Artifact generators produce visualizations of concepts that have since evolved.
- No way to surface current implementations, working code, or live documentation.

## Opportunity

The loop: **external research → integrated into lesson → ingested into graph → reused**.

When lesson agents have access to web sources:
1. **Accuracy closes**: Prose blocks cite current documentation, real code examples, working APIs.
2. **Graph grows**: Every URL pulled into a lesson is ingested via /ingest — entities, relationships, and facts flow into Nmemo. Future lesson generations reuse the same ontology.
3. **Cross-course synthesis**: Content ingested from Lesson A automatically surfaces when generating Lesson B on a related topic; the patrol agent and gap analyzer benefit from the same sources.

## Available Primitives

**Claude Code's WebSearch & WebFetch** are already available via the --tools flag in the Claude CLI. The gent.ts service (line 50, 	ools?: 'none' | 'mcp' | string) accepts a string parameter — we extend this to permit 'WebSearch,WebFetch' alongside the existing 'mcp' and 'none' values.

**Nmemo ingest pipeline** is already in place:
- 
memo-client.ingestContent(text, source) POST to /ingest (platform/src/index.ts:27–32)
- Returns { memoryId, entities, facts } — the ingested content immediately populates the graph

**Lesson block schema** already supports citations (LessonBlock is extensible; we add citations: {url, title}[] to markdown blocks).

## Scope

**In scope**: WebSearch + ingest for outliner (breadth), prose writer (accuracy on factual claims), artifact generator (only when freeform; fixed components are too constrained). Per-lesson cost/latency caps. Graceful degradation when web tools fail.

**Out of scope**: Chat tutor integration (has its own bead). Course generation (separate concern). Async ingest queue (sync only). Browser/JavaScript artifact sandboxing enhancements (existing iframe already limits network).

## Outcome

Lessons on current topics become possible. Graph grows richer with curated web content tied to pedagogical moments, not just raw ingestion. The patrol agent and cross-course intelligence see the same reference material used in lessons.
