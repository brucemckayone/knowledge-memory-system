# Architecture V2: Two-Layer Design

**Status:** Design Discussion (2026-03-16)
**Participants:** Bruce + Claude

---

## Core Insight

The system has two fundamentally different concerns that should be architecturally separated:

1. **The Truth Machine** — establishing and maintaining a coherent, well-structured knowledge base
2. **The Interpretation Layer** — deciding what to do with that knowledge (workflows, surfacing, actions)

The current system mashes these together in the message processor and hardcoded workflow routing. This design separates them.

---

## Layer 1: The Truth Machine

### Purpose
A deterministic enrichment pipeline followed by an LLM-powered "brain step" that ensures knowledge base coherence. It doesn't decide what to *do* with knowledge — it decides what's *true*.

### Enrichment Chain (deterministic, runs on everything)

```
Raw content arrives (any source)
    ↓
Reader        → + content_type, structure, mentions, dates, links, tags
    ↓
Summarizer    → + summary, key_points
    ↓
Entity        → + entities[], entity_types, confidence
Extraction
    ↓
Relationship  → + relationships[], facts[], bi-temporal data
Extraction
    ↓
Schema        → + normalized_predicates, aligned_types
Alignment
    ↓
Conflict      → + contradiction_flags, candidate_conflicts
Detection
    ↓
Brain Step (see below)
    ↓
Events emitted → consumed by Layer 2
```

Each agent decorates the content with metadata. This part is deterministic — it always runs, on every piece of content, regardless of source or type.

### The Brain Step (LLM with bounded agency)

After the enrichment chain completes, an LLM inspects what was produced and reasons about it. It has tools:

| Tool | Purpose |
|------|---------|
| `searchKB()` | Query the knowledge base for related facts, entities, history |
| `searchWeb()` | Verify facts against external sources |
| `searchLocal()` | Search local codebases, folders, documents |
| `askUser()` | Emit a question to the user when uncertain |

**The brain step can:**
- Do nothing — "this is routine, everything is consistent, move on"
- Investigate — "this contradicts an established fact, let me search for corroboration"
- Resolve — "web search confirms the new information, supersede the old fact"
- Escalate — "I can't resolve this, ask the user"
- Surface — "this is relevant to an active project, flag for daily review"

**The brain step cannot:**
- Decide what workflows to run (that's Layer 2)
- Take actions outside the knowledge base (send messages, create reports)
- Ignore the enrichment chain's output

### Events Emitted

The truth machine emits events that Layer 2 consumes:

| Event | Meaning |
|-------|---------|
| `fact.established` | High-confidence new fact added |
| `fact.superseded` | Old fact replaced by newer information |
| `fact.conflict.resolved` | Contradiction resolved autonomously (via search/reasoning) |
| `fact.conflict.unresolved` | Couldn't resolve, question sent to user |
| `entity.discovered` | New entity added to the graph |
| `entity.merged` | Duplicate entities resolved |
| `topic.active` | Sustained activity detected on a topic |
| `question.pending` | Truth machine asked user, awaiting answer |

### User Authority

User-stated facts (e.g., "John's birthday is March 5th") are high-confidence by default. The truth machine treats direct user input as authoritative. Override only with user confirmation — people don't like telling things twice.

### Truth Machine Workflows (fixed `.md` files)

The truth machine has its own workflow definitions that ship with the system. These are not user-editable — they define how the enrichment chain and brain step operate. They describe:
- When the brain step should investigate vs. move on
- Confidence thresholds for autonomous resolution vs. user escalation
- What sources to search for different types of contradictions

---

## Layer 2: The Interpretation Layer

### Purpose

Decide what to *do* with knowledge. React to truth machine events. Run scheduled tasks. Surface information to the user. This layer is flexible and user-configurable.

### User-Defined Workflows (`.md` files)

Users can define workflows as markdown files. These are instructions for an LLM reasoner that has access to:
- The knowledge base (via truth machine events and direct queries)
- Plugins (shared tools)
- User context (active projects, preferences, schedule)

Example workflows:
- **Daily Review** (default, cron-scheduled): Look at what happened today. Surface questions. Update task list. Remind about birthdays, events, deadlines.
- **Meeting Transcript Processing**: When a transcript is ingested, extract action items, decisions, attendees. Link to project entities.
- **Code Change Tracking**: When a code diff arrives, extract what changed and why. Link to project/person entities.
- **Project Status**: On demand or scheduled. Aggregate recent activity for a specific project.

### Scheduled Tasks

User-configurable cron jobs that trigger workflow execution:
- Daily review at 8am (default)
- Weekly project summary on Monday
- Custom schedules per workflow

### Plugins (shared toolbox)

Plugins provide tools that both the truth machine and user workflows can use:
- Web search
- Codebase/folder search
- Calendar integration
- Telegram messaging
- MCP tool access
- API calls

Plugins register tools. Workflows reference tools by name. A plugin can be used across any number of workflows.

---

## How They Connect

```
Content arrives (any source: Telegram, file drop, API, MCP, Obsidian)
    ↓
Layer 1: Truth Machine
    ├── Enrichment Chain (deterministic agents)
    ├── Brain Step (LLM with tools — searchKB, searchWeb, searchLocal, askUser)
    └── Emits events
           ↓
Layer 2: Interpretation Layer
    ├── Event-triggered workflows (react to truth machine events)
    ├── Scheduled workflows (cron — daily review, weekly summary)
    └── On-demand workflows (user asks a question, requests a report)
           ↓
Output: Telegram messages, task updates, daily reviews, surfaced insights
```

---

## Relationship to Current KARMA Agents

The current 7 KARMA agents map to the enrichment chain:

| Current Agent | Role in V2 |
|---------------|------------|
| Reader | Enrichment chain — content parsing, metadata |
| Summarizer | Enrichment chain — content condensation |
| Entity Extraction | Enrichment chain — NER, entity resolution |
| Relationship | Enrichment chain — fact extraction |
| Schema Alignment | Enrichment chain — type normalization |
| Conflict Resolution | Enrichment chain — contradiction detection (deterministic part) |
| Context-Linker | **Needs rethinking** — currently doing interpretive work (deciding what's related), may belong in Layer 2 or brain step |

**What agents are missing today:**
- Tool access (searchKB, searchWeb, searchLocal, askUser)
- Content-type awareness (everything gets same treatment)
- The brain step (LLM reasoning over enrichment output)

**What agents don't need to change:**
- The per-agent enrichment model (each decorates with different metadata)
- pg-boss job queue orchestration
- Typed error hierarchy
- Tier-based scheduling for the enrichment chain

---

## Open Questions

1. **Context-Linker placement:** Is temporal linking a truth concern (Layer 1) or an interpretive concern (Layer 2)? It's making judgments about relevance, which feels like Layer 2. But temporal co-occurrence is arguably factual.

2. **Brain step implementation:** Is this a single LLM call after enrichment? Or a loop that can make multiple tool calls? How do we bound its cost/latency?

3. **Plugin registration:** How do plugins advertise their tools? A manifest file? Auto-discovery? Manual registration?

4. **Workflow `.md` format:** What's the spec? Free-form instructions for an LLM? Structured with frontmatter (triggers, schedule, tools required)? Both?

5. **Event delivery:** Pub/sub? Database table? pg-boss queue? How does Layer 2 subscribe to truth machine events?

6. **Content-type routing:** Should the enrichment chain adapt based on content type (skip summarizer for short messages, use different entity extraction for code), or always run everything?

---

## What This Means for Current Work

- **KARMA agents stay** — they're the enrichment chain, roughly correct
- **Agents need tools** — standard interface for KB search, web search, local search, user questions
- **Brain step is new** — needs design and implementation
- **Workflow engine is new** — replaces hardcoded routing in message-processor.ts
- **Plugin system is new** — provides shared tools
- **Event system is new** — truth machine → Layer 2 communication
- **Current hardcoded routing gets replaced** — message-processor.ts `if/else` goes away

This is not a rewrite — it's a refactor that separates existing concerns and adds the missing brain step and workflow layer.
