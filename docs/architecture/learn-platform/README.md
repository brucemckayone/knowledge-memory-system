# Adaptive Learning Platform — Design Documentation

A demo learning platform built on top of the Nmemo dual-graph system. Demonstrates the wow moment: the system understands *why* a learner is struggling and generates targeted content to address root causes, not symptoms.

## Reading order

| # | Document | What it covers |
|---|----------|----------------|
| 00 | [Vision](00-vision.md) | The "why" — what makes this platform different from a normal learning app, the role of the dual-graph |
| 01 | [v0.1 — MVP Scaffold](01-mvp-scaffold.md) | What's built today: 5 agents, MCP tools, course generation, quiz, gap analysis |
| 02 | [v0.2 — Adaptive Surfaces & Interactive Content](02-v0.2-design.md) | The next major leap: background patrol, dashboard, dynamic components, chat-driven content, cross-course intelligence |

## Status

- **v0.1** — shipped. End-to-end course creation → quiz → gap analysis works.
- **v0.2** — design phase. Beads epics created, implementation pending.

## Key principles (carry through every version)

1. **Graph-first, always.** Every feature must lean on Graph S or Graph C. A feature that doesn't use the graph doesn't belong here.
2. **MCP-first writes.** Agents make targeted, deliberate writes via MCP. Never bulk-ingest noise.
3. **Causal over correlational.** Gap analysis traces causality, doesn't pattern-match symptoms.
4. **Per-learner personalisation.** Canonical course content is shared; learner overlay is unique.
5. **Standalone server.** Learn platform talks to Nmemo only via HTTP. No shared DB.

## Architecture summary

```
┌────────────────────────────────────────────────────────────────┐
│  Browser — vanilla HTML + Preact (htm, no build step)         │
│  Component library + markdown renderer + interactive widgets  │
└──────────────────────────┬─────────────────────────────────────┘
                           │
┌──────────────────────────▼─────────────────────────────────────┐
│  Learn Server (Hono + TypeScript) :3002                        │
│                                                                 │
│  Routes ── Agents (Claude -p) ── MCP Server ── Nmemo HTTP     │
│            ↑                                       │            │
│            └─ Patrol cron: runs every N min, ─────┘            │
│               writes insights to SQLite                        │
│                                                                 │
│  SQLite: courses, sections, questions, attempts,               │
│          insights, flashcards, lesson_versions, notes,         │
│          lesson_overlays, patrol_runs                          │
└──────────────────────────┬─────────────────────────────────────┘
                           │ HTTP only
┌──────────────────────────▼─────────────────────────────────────┐
│  Nmemo Platform :3001  ── Graph S + Graph C                    │
│  Reasoning agent, blast radius, contradictions, patterns       │
└────────────────────────────────────────────────────────────────┘
```
