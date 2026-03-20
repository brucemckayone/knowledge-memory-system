# Future Concepts & Architectural Alignment

This document provides detailed technical elaborations on future concepts for the Cognitive Platform. It maps "Moonshot Ideas" to the existing Architecture (v2.0), identifies gaps, and proposes technical implementations for future phases.

## 1. Autonomous Research Agent ("The Deep Diver")
*Origins: Idea #2*

### Concept
When a user saves a link or a brief thought (e.g., "CRDTs"), the system shouldn't just index it. It should proactively "research" the topic to build a foundational knowledge graph around it, enabling the system to understand the context *before* the user actively engages with it again.

### Architectural Fit
*   **Current State**: Ingestion pipeline (`W08-W12`) handles basic scraping and parsing.
*   **Target Module**: `Ingestion Pipeline` -> `Enrichment Layer`.
*   **Phase**: Phase 3 (Intelligence/Graph Construction).

### Technical Implementation
1.  **Trigger**: New memory creation with `type: link` or `tag: needs-research`.
2.  **Agent Workflow (Skill**: `research-topic`):
    *   **Step 1 (Query Generation)**: LLM analyzes the content and generates 3-5 Google Search queries (e.g., "CRDT vs OT", "Vector Clocks explained", "CRDT use cases").
    *   **Step 2 (Multi-Fetch)**: Parallel execution of `fetch-webpage` skill on top results.
    *   **Step 3 (Synthesis)**: Summarize fetched content into a "Foundational Context" note.
    *   **Step 4 (Graph Injection)**: Create entities for key terms found (e.g., `Entity: Vector Clock`) and link them to the original memory.
3.  **Schema Impact**:
    *   New `JobType` in `gardener_job_meta`: `deep_research`.
    *   New `Relationship`: `validates` or `provides_context_for`.

### Future Code/System Requirements
*   **Rate Limiting**: Need robust handling for search API quotas (Serper/Google).
*   **Recursive Depth**: Configurable "depth" (e.g., recursion level 1 vs 2).

---

## 2. The Social Whisperer ("Context Injection")
*Origins: Idea #9, #3*

### Concept
Proactive delivery of relationship context before interaction. When opening a chat with "Sarah", the system pushes a briefing: "Last spoke 3 weeks ago about Project X. You owe her a PDF."

### Architectural Fit
*   **Current State**: `Contexts` table and `memories` vector store exist.
*   **Target Module**: `API Layer` -> `Context Awareness`.
*   **Phase**: Phase 4/5 (Proactive Assistance).

### Technical Implementation
1.  **Trigger**:
    *   *Polling*: System detects "User opened chat" (hard with Telegram API limitations).
    *   *Push*: Telegram Bot command `/brief @sarah` or simply typing "Sarah" in a "Brief Me" chat.
    *   *Real-time*: Desktop companion app watching active window (Client V2).
2.  **Query Logic**:
    *   Identify `Entity: Person` from input.
    *   **Graph Query**: Find open tasks where `assignee = Sarah` or `related_to = Sarah`.
    *   **Vector Query**: "Recent conversations with Sarah" + "Promises made to Sarah".
    *   **Synthesis**: LLM compiles bullet points.
3.  **Delivery**: Push notification or private Telegram message.

### Future Code/System Requirements
*   **Latency**: Must be <2s to be useful. Requires highly optimized `hybrid_search` (W19).
*   **Privacy**: Strict filtering to ensure only *your* private notes about "Sarah" are used, not shared data if multitenant.

---

## 3. The Living Curriculum ("Auto-Syllabus")
*Origins: Idea #8*

### Concept
Automatically structuring scattered bookmarks and notes into a coherent learning path (Syllabus).

### Architectural Fit
*   **Current State**: Basic efficient vector search.
*   **Target Module**: `Intelligence Layer` -> `Community Detection` (`W30`).
*   **Phase**: Phase 5 (High-level Intelligence).

### Technical Implementation
1.  **Mechanism**:
    *   **Community Detection**: The `W30` worker identifies a tight cluster of nodes around "Rust Programming".
    *   **Curriculum Agent**:
        *   Prompt: "Organize these 50 items into a step-by-step learning path from Beginner to Advanced."
        *   Gap Analysis: "Identify missing key concepts based on the standard 'Rust' ontology."
2.  **Outcome**:
    *   Create a new `Epic` or `Context` called "Learning Rust".
    *   Create `Tasks` for reading/watching specific items in order.

### Future Code/System Requirements
*   **Knowledge Standard**: The system needs a "Teacher" prompt persona that understands pedagogical ordering (e.g., "Variables before Generics").

---

## 4. Predictive Pre-Fetch ("Minority Report")
*Origins: Idea #11*

### Concept
Anticipating information needs based on calendar/schedule and pushing context *before* it is asked for.

### Architectural Fit
*   **Current State**: `Morning Briefing` (`W32`) is the primitive version (daily).
*   **Target Module**: `Event Bus` / `Chronods`.
*   **Phase**: Phase 4 (Integrations).

### Technical Implementation
1.  **Integration**: Calendar Feed (iCal/Google implementation).
2.  **Lookahead Job**:
    *   Runs every 15 mins.
    *   Checks events in `[now, now + 30m]`.
    *   Extracts keywords/participants from Event Title/Description.
3.  **Execution**:
    *   Runs `Context Generation` pipeline (same as Social Whisperer) for the event topic.
    *   Delivers via Telegram: "Meeting 'Project Phoenix Review' in 15m. Here is the summary of the last decision log."

### Future Code/System Requirements
*   **Calendar Polling**: Need a reliable `calendar-sync` service (Part of `Ingestion`).

---

## 5. The Sleep Cycle ("Dream Clean Up")
*Origins: Idea #6*

### Concept
Using "downtime" (night) to compress detailed, fragmented memories into high-level summaries and "clean" the graph.

### Architectural Fit
*   **Current State**: `Nightly Gardener` (`W21`) is explicitly designed for this.
*   **Target Module**: `Gardener` -> `Summarizer` & `Concept Merging`.
*   **Phase**: Phase 3 (Maintenance).

### Technical Implementation
1.  **Process**:
    *   **Cluster**: Find memories created today.
    *   **Compress**: If >5 memories relate to "Topic X", synthesize into one "Daily Summary: Topic X".
    *   **Archive**: Mark original fragments as `archived` (still searchable, but lower weight).
2.  **Graph Maintenance**:
    *   Prune weak edges.
    *   Merge duplicate entities (e.g., "JS" and "Javascript").

### Future Code/System Requirements
*   **Token Management**: Heavy LLM usage at night. Need batch processing optimization to manage costs/local GPU load.

---

## 6. Anti-Echo Chamber ("Devil's Advocate")
*Origins: Idea #4, #W33*

### Concept
Proactively surfacing past contradictions to challenge current thoughts.

### Architectural Fit
*   **Current State**: Planned `Contradiction Scheduler` (`W33`).
*   **Target Module**: `Intelligence Layer` -> `Conflict Resolution`.
*   **Phase**: Phase 5.

### Technical Implementation
1.  **Trigger**: New thought entering the system.
2.  **Check**:
    *   LLM checks for *Semantic Contradiction* against the Vector Store.
    *   "User said 'I love React' today. Vector search finds 'I hate React intensity: high' from 2023."
3.  **Action**:
    *   Flag as `contradiction`.
    *   Agent questions the user: "Perspective Shift Detected. You changed your mind on X. Why?"

---

## 7. Idea Collider ("Tinder for Thoughts")
*Origins: Idea #7, #12*

### Concept
A serendipity engine that presents two random or loosely related ideas and asks the user to find the connection.

### Architectural Fit
*   **Current State**: None.
*   **Target Module**: `UI` / `Gamification`.
*   **Phase**: Client V2.

### Technical Implementation
1.  **Algorithm**:
    *   **Random Walk**: Pick Node A. Walk 3 steps. Pick Node B.
    *   **Dissimilarity Search**: Pick Node A. Find Node B with vector distance > 0.5 but < 0.8 (related but distinct).
2.  **UI**: "Swipe to Connect". User input creates a new `edge` in the Knowledge Graph describing the relationship.

---

# Architectural Glue & Plugin System

To prevent these concepts from becoming a tangled mess of spaghetti code, they must be implemented as **Plugins** that hook into a central **Event Bus** and **Registry**.

## The "Glue": Event-Driven Plugins

Every concept above follows a pattern: `Trigger` -> `Action` -> `Optimization`. In our architecture, this maps to:
1.  **Hooks (Trigger)**: Listening for specific events (`onMemoryCreated`, `onSchedule`, `onMessage`).
2.  **Skills (Action)**: Atomic tools that the agent can execute (`search_web`, `graph_query`, `send_telegram`).
3.  **Agents (Optimization)**: The brain that decides *which* skills to use.

### The Unified Plugin Interface

We will extend the `ProcessorPlugin` from `ARCHITECTURE.md` to support this holistic view.

```typescript
type TriggerType = 
  | 'on_memory_created'   // Deep Diver, Echo Chamber
  | 'on_message_received' // Social Whisperer
  | 'on_schedule'         // Pre-Fetch, Sleep Cycle
  | 'on_demand';          // Living Curriculum, Idea Collider

interface CognitivePlugin {
  id: string;
  name: string;
  
  // 1. Triggers: When does this plugin run?
  triggers: {
    type: TriggerType;
    filter?: (payload: any) => boolean; // e.g. "Only type:link" for Deep Diver
  }[];

  // 2. Capabilities: What tools does it add to the system?
  skills: SkillDefinition[]; 

  // 3. Execution: The "Brain" of the plugin
  // Can be a simple function or a full Agent
  execute(context: PluginContext): Promise<void>;
}

interface SkillDefinition {
  name: string;             // e.g. "fetch_calendar_events"
  description: string;      // "Get events for next 30 mins"
  parameters: JsonSchema;
  handler: (args: any) => Promise<any>;
}
```

## Integrating The Concepts

Here is how each concept acts as a Plugin:

| Concept | Plugin Type | Trigger | New Skills (Tools) |
| :--- | :--- | :--- | :--- |
| **Deep Diver** | `ResearchPlugin` | `on_memory_created` (if type=link) | `recursive_search_web`<br>`generate_graph_nodes` |
| **Social Whisperer** | `ContextPlugin` | `on_message_received` (if new chat) | `get_person_history`<br>`get_open_promises` |
| **Living Curriculum** | `EducationPlugin` | `on_demand` (User asks) | `find_knowledge_clusters`<br>`generate_syllabus` |
| **Pre-Fetch** | `CalendarPlugin` | `on_schedule` (Every 15m) | `get_upcoming_events`<br>`push_notification` |
| **Sleep Cycle** | `MaintenancePlugin` | `on_schedule` (At 3 AM) | `cluster_memories`<br>`merge_entities`<br>`archive_memories` |
| **Echo Chamber** | `ContradictionPlugin` | `on_memory_created` (All) | `find_contradictory_facts`<br>`challenge_user` |

## How Tool Calling Works

The system is designed for **Agentic Tool Use**.
1.  **Registry**: At startup, `PluginManager` loads all plugins and registers their `skills` into a global `SkillRegistry`.
2.  **Orchestration**:
    *   When the **Deep Diver Agent** wakes up, it is given the system prompt: "You are a Researcher." AND access to the `recursive_search_web` tool provided by its own plugin.
    *   It *calls* the tool via the standard `Envelopes` system.
    *   The tool runs (potentially in Python/Service layer) and returns data.
    *   The Agent decides what to do next.

## Summary of Architectural Requirements

To support this "Plug-and-Play" future:
1.  **Event Bus**: We need a robust event emitter (likely `EventEmitter` for local, or `pg-boss` for async) that broadcasts `onMemoryCreated`.
2.  **Plugin Loader**: A mechanism to dynamically load these modules so we can add "The Deep Diver" without rewriting the core `Server.ts`.
3.  **Agent Runtime**: A standard way to spin up a temporary LLM agent, give it a specific subset of Tools, and let it run a loop.

This structure allows you to build "The Deep Diver" completely independently as a folder in `plugins/deep-diver/` containing its own Logic, Tools, and Prompts, without touching the core platform code.

---

## 8. Self-Healing Codebase ("The Inner Eye")

### Concept

Mnemo turns its own intelligence inward. By interfacing with GitHub and its own error logging/detection systems, the platform can analyse its own codebase — detecting errors, diagnosing root causes, and autonomously creating GitHub issues and PRs with proposed fixes. The memory system maintains a context-aware timeline of errors, fixes, and the intentions behind every change, keeping the project on track and building institutional knowledge about its own evolution.

### Why This Matters

Most error-to-fix cycles are reactive and context-poor: a log line fires, someone investigates from scratch, and the reasoning behind the fix lives only in the developer's head. If Mnemo can observe its own runtime errors, correlate them with recent changes (via git history), understand the original intent behind the code (via its own memory/knowledge graph), and propose targeted fixes — the entire feedback loop tightens dramatically. The memory layer means it never loses context: it knows *why* a piece of code exists, what past errors looked like, and what was tried before.

### Architectural Fit

- **Current State**: KARMA agents already perform background analysis and enrichment. The memory system stores entities, relationships, and context.
- **Target Module**: `Interpretation Layer` -> `DevOps Plugin` (new).
- **Phase**: Phase 6+ (Self-Awareness).

### Technical Implementation

1. **Error Ingestion**:
   - New source adapter for application logs (structured JSON logs from platform + ml-services).
   - Runtime error events feed into the standard ingestion pipeline, creating `memory` entries with `type: error`.
   - Stack traces, request context, and environment metadata are captured as entities.

2. **Diagnosis Agent**:
   - Triggered `on_memory_created` when `type: error`.
   - Correlates the error with recent git commits (`git log`, `git blame`).
   - Queries the knowledge graph for related past errors, fixes, and the original intent behind the affected code.
   - Produces a diagnosis: root cause hypothesis, confidence level, affected components.

3. **Resolution Agent**:
   - Takes the diagnosis and generates a proposed fix.
   - Creates a GitHub issue with full context (error, diagnosis, affected files, related past incidents).
   - Opens a draft PR with the fix, linking back to the issue.
   - Records the entire error→diagnosis→fix chain in the memory system as a connected subgraph.

4. **Context Timeline**:
   - The memory system maintains a living timeline: `error → diagnosis → fix → PR → merge → verification`.
   - Each node links to the intent behind the original code, the intent behind the fix, and any related past incidents.
   - This timeline is queryable — "what errors have we seen in the ingestion pipeline?" returns a full narrative, not just log lines.

### Plugin Shape

| Aspect | Detail |
| :--- | :--- |
| **Plugin Type** | `SelfHealingPlugin` |
| **Triggers** | `on_memory_created` (type=error), `on_schedule` (periodic log scan) |
| **New Skills** | `analyse_error`, `correlate_with_history`, `generate_fix`, `create_github_issue`, `create_github_pr`, `record_fix_timeline` |

### Future Code/System Requirements

- **GitHub Integration**: Authenticated GitHub API access for issue/PR creation (likely via GitHub App or PAT).
- **Log Structured Format**: Platform and ml-services need consistent structured logging to enable reliable error parsing.
- **Safety Rails**: Human-in-the-loop approval before any PR is merged. The system proposes, a human disposes.
- **Feedback Loop**: When a human modifies a proposed fix before merging, the system learns from the delta — improving future diagnoses.
