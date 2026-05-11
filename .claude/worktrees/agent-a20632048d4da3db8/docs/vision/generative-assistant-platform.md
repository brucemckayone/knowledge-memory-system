# Generative Assistant Platform — Self-Authoring Personal Software

> The system doesn't just store your knowledge — it builds the software you need from it.

---

## The Idea

Mnemo already understands your thoughts, your projects, your relationships, your patterns. It has a knowledge graph, a memory timeline, contradiction detection, morning briefings — it *knows things* about your life.

What if it could turn that understanding into software? Not pre-built dashboards you configure, but bespoke applications that the system generates, renders, and maintains — locally, on the fly, from your own data.

You don't install apps. You don't configure views. You describe what you need — or the system infers it — and the software appears. When your data changes, the software evolves. When something breaks, the system diagnoses and heals itself. The entire surface is alive.

This is the convergence of three things Mnemo is already building toward:

1. **Deep contextual understanding** (knowledge graph, KARMA agents, memory system)
2. **Self-healing intelligence** (the Inner Eye — error detection, diagnosis, autonomous fixes)
3. **Dynamic component generation** (LLM-generated UI compiled and rendered at runtime)

Together they create something new: a personal assistant that authors its own interface.

---

## How It Works

### Layer 1: The Brain (Mnemo as it exists)

The knowledge graph and KARMA agents are the foundation. They provide:

- **Entity awareness** — people, projects, concepts, and their relationships
- **Temporal understanding** — what was true when, what changed, what contradicts
- **Pattern detection** — recurring themes, stalled projects, emerging interests
- **Intent memory** — not just *what* you said but *why*, preserved over time

This layer doesn't change. It's the substrate everything else builds on.

### Layer 2: The Renderer (Dynamic Component System)

Adapted from the LLM-generated component architecture, but running locally instead of on Cloudflare Workers:

**Core loop:**
1. Data arrives (from the knowledge graph, a query result, an agent output)
2. The system computes a **shape fingerprint** — the structure of the data, not its values
3. If a component exists for that shape → render it
4. If not → the LLM generates a Svelte component, compiles it in-browser, caches it
5. The component renders with full context — design tokens, user preferences, data bindings

**Local runtime:**
- Components compile in the browser via `svelte/compiler` (pure JS, no server needed)
- Compiled SSR and client builds are cached in the local database (SQLite or PostgreSQL)
- A local service worker or lightweight server handles rendering
- Pre-built component library (tables, charts, forms, cards) gives the LLM building blocks
- Design token system ensures visual consistency without hardcoded styles

**The key insight from the spec that carries over:** Intelligence at creation time, dumb at runtime. The LLM does the hard work once. After that, it's just execution — fast, cacheable, deterministic.

### Layer 3: The Nervous System (Self-Healing Loop)

The Inner Eye concept, extended to cover the entire platform — not just backend errors but the generated UI surface too:

**Error detection:**
- Runtime errors from generated components are captured and fed back into the knowledge graph as `type: error` memories
- Render failures trigger automatic fallback (raw data view) while queuing regeneration
- Stack traces, data shapes, and component versions are preserved as entities with relationships

**Diagnosis:**
- The diagnosis agent correlates errors with recent changes — which component was regenerated, what data shape triggered it, what LLM prompt produced it
- It queries the memory timeline for related past failures — "this shape fingerprint has failed before, here's what fixed it last time"
- Confidence-scored root cause hypothesis

**Resolution:**
- For generated components: automatic regeneration with the diagnosis as additional context in the LLM prompt ("previous version failed because X, avoid Y")
- For platform code: GitHub issue creation with full context, draft PR with proposed fix
- For data issues: flag contradictions or schema drift to the user via the briefing system

**The feedback loop closes:** error → diagnosis → fix → verification → memory. Every failure makes the system smarter. The memory layer means it never makes the same mistake twice in the same way.

---

## What You'd Actually Experience

### Morning

You open the assistant. Your morning briefing isn't a text blob in Telegram — it's a generated dashboard. Tasks due today in a kanban column. A timeline of yesterday's captured thoughts. A chart showing your "infrastructure" knowledge cluster growing. A flag on a stalled project. All of this was generated from your data shape, compiled once, and renders instantly.

### Working

You're deep in a project. You ask: "Show me everything related to the authentication redesign." The system doesn't return a list of search results — it generates a **project view**. A timeline of related thoughts and decisions. A relationship graph of the people involved. Open tasks grouped by status. Links you saved with your commentary attached. This view didn't exist five minutes ago. It was built from the query result's shape.

### Capturing

You forward an article about CRDTs. The system processes it through the normal KARMA pipeline — entities extracted, relationships mapped, summary generated. But now it also notices: you have 12 other memories about distributed systems. It generates a **knowledge cluster view** — a visual map of everything you know about this topic, with the new article positioned in context. You never asked for this. It appeared because the data warranted it.

### Something Breaks

A generated component throws an error — maybe a data shape drifted after a new entity type was extracted. The system catches it immediately. Renders the fallback. The diagnosis agent runs: "Component `c-a8f3e2` failed on shape `{entities: [{type: 'concept', ...}], relationships: [...]}` because the previous generation assumed `relationships` was a flat array but it's now nested after the KARMA relationship agent was updated." It regenerates the component with corrected assumptions. Next render works. The entire incident is recorded in the memory timeline. You never noticed.

### Evolving

Over weeks, the system learns your patterns. You always expand the "related thoughts" section on project views. You never use the timeline on knowledge clusters. The LLM prompt for your preference profile adjusts. New component generations reflect how you actually work. The UI quietly reshapes itself around your behaviour.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    Local Assistant Surface                    │
│                                                              │
│   ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐   │
│   │ Briefing │  │ Project  │  │ Knowledge│  │ Task     │   │
│   │ Dashboard│  │ View     │  │ Explorer │  │ Board    │   │
│   └────┬─────┘  └────┬─────┘  └────┬─────┘  └────┬─────┘   │
│        └──────────────┴──────────────┴──────────────┘        │
│                          ▲ Generated Components              │
│                          │                                   │
│   ┌──────────────────────┴───────────────────────────────┐   │
│   │              Component Runtime                        │   │
│   │  Shape Fingerprint → Cache Lookup → Render / Generate │   │
│   │  Pre-built Library │ Design Tokens │ Svelte Compiler  │   │
│   └──────────────────────┬───────────────────────────────┘   │
│                          │                                   │
│   ┌──────────────────────┴───────────────────────────────┐   │
│   │              Self-Healing Layer                        │   │
│   │  Error Capture → Diagnosis Agent → Resolution Agent   │   │
│   │  Memory Timeline │ Feedback Loop │ GitHub Integration │   │
│   └──────────────────────┬───────────────────────────────┘   │
│                          │                                   │
├──────────────────────────┴───────────────────────────────────┤
│                                                              │
│                    Mnemo Core (existing)                      │
│                                                              │
│   Knowledge Graph │ KARMA Agents │ Memory System │ Search    │
│   Entity Extraction │ Relationships │ Contradiction Detection│
│   pg-boss Queue │ Qdrant Vectors │ Apache AGE Graph          │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

### Component Generation Flow

```
Data Query Result
       │
       ▼
Shape Fingerprint ──→ Cache Hit? ──yes──→ Render Cached Component
       │                                          │
       no                                         ▼
       │                                   Return HTML + CSS
       ▼
LLM Generation
  • Data shape as context
  • User preference profile
  • Pre-built component library
  • Design token contract
  • Past failures for this shape (from memory)
       │
       ▼
Svelte Compile (in-browser)
       │
       ▼
Cache SSR + Client Builds
       │
       ▼
Render → Return HTML + CSS
```

### Self-Healing Flow

```
Component Render Error
       │
       ▼
Fallback Render (raw data)
       │
       ▼
Error Memory Created
  • Stack trace, data shape, component version
  • Linked to: component record, data source, recent changes
       │
       ▼
Diagnosis Agent
  • Correlate with git history / recent KARMA changes
  • Query memory for past failures on this shape
  • Produce root cause hypothesis
       │
       ▼
Resolution Agent
  ┌────┴────┐
  │         │
  ▼         ▼
Component  Platform
Error      Error
  │         │
  ▼         ▼
Regenerate  GitHub Issue + Draft PR
with        with full context
diagnosis   from memory timeline
  │         │
  ▼         ▼
Verify      Human Review
  │
  ▼
Record fix in memory timeline
```

---

## What Makes This Different from Low-Code / No-Code

Low-code tools give you a constrained visual builder. You drag blocks around. The expressiveness ceiling is low and you hit it fast.

This system has no builder. The LLM has the full expressive power of Svelte, constrained only by the services interface and design token contract. The ceiling is whatever the LLM can generate — and that ceiling rises with every model improvement without changing the architecture.

Low-code tools are also **static** — you build a view, it stays that view until you manually change it. This system is **derived** — views are a function of data shape + user preferences + accumulated context. They evolve automatically.

And critically: low-code tools don't know anything about your data. They're generic canvases. This system has the entire Mnemo knowledge graph behind it. It knows your projects, your people, your patterns. A generated "project view" isn't generic — it's shaped by what the system knows about *that specific project* and *how you work*.

---

## The Compounding Effect

Every layer reinforces the others:

- **More knowledge in the graph** → richer context for component generation → more useful views
- **More generated components** → more render history → better few-shot examples for the LLM
- **More errors caught and fixed** → smarter diagnosis agent → fewer errors over time
- **More user interaction patterns** → better preference profiles → more personalised UI
- **Better LLM models** → higher quality components → less manual intervention → more trust in the system

None of this requires architectural changes. It's all emergent from the three layers interacting.

---

## Beyond Screens: The External Services Surface

Generated UI components are one output modality. But the system's understanding of you — your goals, your knowledge gaps, your patterns, your stress levels — is modality-agnostic. The same intelligence that generates a dashboard can drive any external API to produce any kind of artefact.

### The Services Interface Extends Outward

The component system has a controlled `services` interface — `data.load`, `data.save`, `ui.navigate`. The same pattern scales to external APIs. The system gets access to capabilities, not raw HTTP. Each capability is a typed, rate-limited, authenticated skill that agents and generated components can invoke without knowing the provider behind it.

```
services.audio.generate(text, voice, style)    → ElevenLabs, local TTS, etc.
services.image.generate(prompt, dimensions)     → DALL-E, Stable Diffusion, etc.
services.document.render(content, format)       → PDF, EPUB, slide deck
services.calendar.query(range)                  → Google Calendar, iCal
services.music.generate(mood, duration)         → ambient generation
```

The provider is an implementation detail. The system declares intent. Adapters translate. Same pattern Mnemo already uses for LLM providers.

### What This Enables

**Generated audio content.** The system knows you've been collecting thoughts about distributed systems for three months. It synthesises your notes, saved articles, and annotations into a 15-minute podcast episode — narrated by ElevenLabs in whatever voice you prefer — that walks through *your own evolving understanding* of the topic. Not a generic explainer. A personalised synthesis of what you know and what you're still working out.

**Personalised courses.** You told the system you want to learn Rust. It's been tracking what you save, what you ask about, what concepts you've already grasped (entity extraction has been watching). It generates a structured learning path — not from a generic syllabus but from the gaps in *your* knowledge graph. Each module is a generated artefact: a reading with your own saved links woven in, an audio walkthrough of a concept you struggled with, a generated coding exercise that connects to a project you're already working on.

**Guided meditation and reflection.** The system noticed you mentioned "burnout" four times this week. It noticed your task completion rate dropped. It noticed you stopped saving links about the side project you were excited about. It generates a guided reflection — audio, delivered at the time you usually wind down — that walks you through what shifted, gently surfaces the pattern, and helps you decide what to do about it. Not a generic meditation app. A reflection grounded in *your actual life*.

**Goal tracking as a living system.** You set a goal: "Launch the side project by June." The system creates a generated view tracking progress. But it also watches — are you saving relevant links? Are tasks moving? Are you talking about it less? It generates a weekly audio check-in: "Here's where you are relative to June. You made progress on the API layer this week but the frontend hasn't been touched in 12 days. Based on your velocity, here's what needs to happen next week." When you drift, it doesn't nag — it gently steers you back by surfacing the right context at the right time.

**Content that compounds.** Every generated artefact — podcast, course module, reflection — feeds back into the knowledge graph. The system remembers that it generated a Rust module for you on ownership semantics, that you listened to it twice, that you subsequently saved three articles on the same topic. Next generation is better because it knows where you are now.

### The Pattern

The system already has the hard parts:

1. **Deep contextual understanding** — it knows what you know, what you care about, what's changing
2. **Proactive intelligence** — KARMA agents and the briefing system already decide what's worth surfacing
3. **Plugin architecture** — the `CognitivePlugin` interface already supports `on_schedule`, `on_memory_created`, `on_demand` triggers

External APIs are just new skills in the same framework. An `AudioPlugin` that triggers `on_demand` or `on_schedule`, calls `services.audio.generate`, and stores the output as a new memory with relationships back to its source material. A `CoursePlugin` that triggers when a knowledge cluster reaches critical mass. A `ReflectionPlugin` that triggers when the pattern detection agent notices a shift in your behaviour.

The generated UI surface and the generated audio/content surface are two outputs of the same intelligence. The system doesn't just show you things — it *creates things for you*, in whatever modality serves the moment.

---

## Adaptive Learning and Mastery Tracking

The system doesn't just deliver knowledge — it knows whether you've absorbed it.

### The Knowledge Graph Knows What You Know

Mnemo already tracks entities and your relationship to them. Extend that with a **mastery dimension**: for every concept the system has taught you or you've engaged with, it maintains a confidence score — not self-reported, but observed.

**Signals that build the mastery model:**

- You saved an article about ownership in Rust → you've been *exposed*
- You listened to the generated audio module on it → you've *engaged*
- You later saved your own note explaining it in your own words → you *understand*
- You used the concept correctly in a conversation about a project → you've *applied*
- Weeks later, you accurately reference it without prompting → you've *retained*

The system tracks this progression passively. Every interaction with a concept — saves, searches, notes, questions, generated content consumed — updates the mastery estimate. No quizzes needed to build the baseline.

### But Quizzes Too

When the system detects a concept sitting at "engaged" but not yet "understood" — or when enough time has passed that retention is likely decaying — it generates assessments. Not generic flashcards. Contextual challenges drawn from your own knowledge:

**Scenario-based.** "You're building the authentication service for Project Phoenix. The current design stores session tokens in a cookie. Based on what you've learned about stateless auth, what's the risk and what would you change?" The question is grounded in *your actual project*, not a textbook example.

**Connection-based.** "You saved a note about CRDTs last month and an article about event sourcing this week. What's the relationship between these two approaches to distributed consistency?" The system knows these are in your graph but not yet linked — the question is also a prompt to form the connection.

**Spaced repetition, personalised.** The timing of review isn't a fixed algorithm — it's informed by how quickly you've retained similar concepts in the past, how actively you've been engaging with related material, and whether the concept is relevant to something you're currently working on. Active relevance extends the retention window. Idle concepts get reviewed sooner.

### The Learning Loop

```
Knowledge Graph (what you know)
       │
       ▼
Gap Detection (what you don't)
       │
       ▼
Content Generation (course, audio, reading list)
       │
       ▼
Engagement Tracking (did you consume it?)
       │
       ▼
Assessment Generation (do you understand it?)
       │
       ▼
Mastery Update (how well do you know it now?)
       │
       ▼
Retention Monitoring (are you forgetting it?)
       │
       └──→ back to Gap Detection
```

Every loop iteration sharpens the model. The system learns your learning patterns — you pick up systems concepts quickly but struggle with mathematical foundations; you retain things you've applied in projects but forget pure theory. The content generation adapts: more practical examples for you, more spaced repetition on the theoretical gaps, more project-grounded assessments rather than abstract ones.

### Progress as a First-Class View

This feeds directly back into the generated UI surface. The system can produce:

- A **mastery map** — your knowledge graph coloured by confidence. Dense green clusters where you're strong. Fading yellow at the edges where understanding thins. Red gaps where you have related material saved but haven't engaged with it.
- A **learning velocity chart** — how fast you're progressing in each domain, overlaid with your goals. "You wanted to be production-ready in Rust by June. At current velocity, you're on track for the systems programming modules but behind on async/concurrency."
- A **daily challenge** — woven into the morning briefing. One question, contextual, tied to something you're working on or at risk of forgetting. Not homework. A single sharp prompt that keeps the edge.

The system becomes a tutor that knows exactly where you are, what you're struggling with, what you've mastered, and what you're about to forget — because it's been watching, not asking.

---

## Implementation Phases

### Phase A: Static Generated Views (Near-term)

- Morning briefing rendered as a generated dashboard component instead of text
- Single data shape (briefing output) → single generated component
- Manual trigger via editor, cached indefinitely
- Proves the compile-in-browser → cache → render loop works locally

### Phase B: Query-Driven Generation (Medium-term)

- Search results and knowledge graph queries produce shape-fingerprinted views
- Component cache grows organically as new data shapes appear
- Pre-built component library (DataTable, StatCard, Timeline, RelationshipGraph)
- User preference profiles influence generation

### Phase C: Self-Healing Loop (Longer-term)

- Error ingestion from generated components feeds back into KARMA pipeline
- Diagnosis agent correlates failures with component and data history
- Automatic regeneration with failure context
- GitHub integration for platform-level issues
- Full memory timeline of error → diagnosis → fix chains

### Phase D: Proactive Surface (Moonshot)

- System generates views before you ask — "you have a growing cluster here, I built a view for it"
- Natural language view editing: "make the timeline horizontal, highlight overdue items"
- Per-user UI that quietly reshapes over weeks based on usage patterns
- The assistant surface becomes fully self-authored

---

## Economics: Intelligence Routing and Cost Architecture

The system's viability depends on not sending every task to the most expensive model. The adapter pattern Mnemo already uses for LLM providers becomes an economic routing layer — matching task complexity to the cheapest model that can handle it.

### The Four Tiers

**Tier 1 — Local (Ollama, $0 marginal cost)**

Embeddings, classification, basic extraction. This is what Mnemo already does and it's the correct default.

| Task | Model | Performance |
|------|-------|-------------|
| Embeddings | nomic-embed-text | ~12,000 tok/s on RTX 4090, ~9,000 on Apple Silicon |
| Classification | Llama 3.1 8B (Q4) | 30-80 tok/s, good enough for routing and tagging |
| Basic extraction | Qwen 2.5 7B (Q4) | Fast, handles structured output well |

Hardware cost is a one-time investment. An RTX 4090 ($1,600-$2,000) or Mac Studio M4 Max ($2,000-$4,600) handles all of this with headroom. Power draw under bursty workloads: $10-30/month.

**Tier 2 — Cheap API ($3-5/month)**

Entity extraction, task extraction, relationship detection. High volume, medium quality requirements.

| Provider | Model | Input/1M | Output/1M |
|----------|-------|----------|-----------|
| DeepSeek | V3.2 | $0.28 | $0.42 |
| Google | Gemini 2.5 Flash-Lite | $0.10 | $0.40 |
| OpenAI | GPT-4.1 Nano | $0.10 | $0.40 |
| OpenAI | GPT-4o-mini | $0.15 | $0.60 |

At 500 messages/day (~7.5M input + 3M output tokens/month): **~$3-5/month**.

**Tier 3 — Quality API ($10-20/month)**

Summaries, briefings, course content, component generation, contradiction detection. Lower volume, high quality matters.

| Provider | Model | Input/1M | Output/1M |
|----------|-------|----------|-----------|
| Google | Gemini 2.5 Pro | $1.25 | $10.00 |
| OpenAI | GPT-4o | $2.50 | $10.00 |
| Anthropic | Claude Sonnet 4.6 | $3.00 | $15.00 |

At 50 generation tasks/day (~1.5M input + 750K output tokens/month): **~$10-16/month**.

**Tier 4 — Premium reasoning ($1-10/month)**

Diagnosis, contradiction arbitration, debate protocol, complex content synthesis. Rare but high-stakes.

| Provider | Model | Input/1M | Output/1M |
|----------|-------|----------|-----------|
| DeepSeek | R1 | $0.50 | $2.18 |
| OpenAI | GPT-5 | $1.25 | $10.00 |
| Anthropic | Claude Opus 4.6 | $5.00 | $25.00 |

At 10 complex tasks/day (~600K input + 300K output tokens/month): **~$1-11/month** depending on provider.

### Total Cost Envelope

| Strategy | Monthly | Notes |
|----------|---------|-------|
| All local (current Ollama setup) | $10-30 | Electricity only. Limited to 7-8B quality for generation. |
| Local + DeepSeek across the board | $15-35 | Best cost. China-hosted API (data residency consideration). |
| Local + Gemini Flash (extraction) + Sonnet (generation) | $25-50 | Good quality/cost balance. Multi-provider. |
| Local + multi-provider optimised | $25-45 | Best quality/cost. Route each task to cheapest adequate model. |
| All cloud API (no local hardware) | $50-100+ | Adds embedding costs. Removes hardware dependency. |

**The sweet spot for a personal system: $15-40/month** on top of hardware you already own.

### Serverless GPU as a Middle Path

For workloads that need better-than-8B quality but shouldn't hit a commercial API (privacy, cost, latency):

| Provider | Model | Approach | Cost |
|----------|-------|----------|------|
| Modal.com | Any open model | Per-second billing, scale to zero | H100: ~$3.95/hr active, $0 idle |
| RunPod | Any open model | Serverless or dedicated | A100: ~$1.33/hr |
| Together.ai | Llama 3.1 70B | Hosted inference | $0.88/M tokens |
| Groq | Any supported | LPU, lowest latency | $0.05-$1.00/M tokens |

This matters for the content generation use case — generating a personalised podcast script or course module using a 70B model on Modal might cost $0.02 per generation and keep the data off third-party API servers.

### The Intelligence Router

The adapter pattern becomes an economic decision engine:

```
Task arrives
    │
    ▼
Classify complexity + quality requirement
    │
    ├── Embedding/classification → Tier 1 (local, free)
    ├── Structured extraction    → Tier 2 (cheapest API that meets quality bar)
    ├── Content generation       → Tier 3 (quality API, or serverless GPU for privacy)
    └── Complex reasoning        → Tier 4 (premium, only when needed)
```

The system can also learn routing decisions over time — if a Tier 2 model consistently produces good enough summaries for a particular data shape, stop sending that shape to Tier 3. If a Tier 1 model's entity extraction quality drops below threshold for medical terms, escalate that category to Tier 2. The routing itself becomes adaptive.

### Cost at Scale (Multi-User Product)

If Mnemo becomes a product serving multiple users, the economics shift:

- **Local tier disappears** — you're hosting, not users. Replaced by serverless GPU or dedicated instances.
- **Batch APIs become critical** — Anthropic, OpenAI, and Groq all offer 50% batch discounts. Background agents (KARMA, diagnosis, content generation) are inherently batchable.
- **Caching compounds** — prompt caching (Anthropic: fraction of input price, Google: 90% off, DeepSeek: 90% off) matters when many users generate similar extraction prompts against similar data shapes.
- **Per-user cost target**: $5-15/month at scale, well within a viable subscription price point.

---

## Open Questions

- **Local rendering runtime** — SvelteKit dev server? Electron? Tauri? Browser-only with service worker? The original spec targets Cloudflare Workers but this is local-first.
- **Component sandboxing locally** — the original spec uses a zero-binding Worker for isolation. Locally, do we use iframes, Web Workers, or trust the constrained services interface?
- **LLM latency for generation** — local models (Ollama) may be too slow for complex component generation. Hybrid approach (local for simple, cloud for complex)?
- **Design token source** — who defines the token system? Auto-derived from user preferences, or a base theme with overrides?
- **Persistence format** — SQLite (simpler, single-file) vs reusing the existing PostgreSQL for component storage?

---

## Relationship to Other Vision Docs

- **product-concept.md** — this is the "v3: Expansion" surface described there, but generated rather than hand-built
- **cognitive-platform-v2.md** — the proactive agent system becomes the intelligence that decides *what* to generate and *when*
- **future-concepts.md §8 (The Inner Eye)** — the self-healing layer described here is the same concept, extended to cover the generated UI surface
- **future-concepts.md (Plugin System)** — each generated view type could be a plugin: `BriefingPlugin`, `ProjectViewPlugin`, `ClusterExplorerPlugin`

---

*The endgame isn't software you use. It's software that builds itself around you.*
