# Chat Tutor Depth: Compel Learner-State Reads, Full MCP Toolset, Surface Tool Calls

## Three Concrete Problems

### 1. State reads are optional, not compelled
The system prompt suggests calling `get_learner_understanding` and `get_struggle_areas` but does not enforce them. In practice, the tutor responds with generic teaching without consulting the learner's prior facts, contradictions, or gaps. This violates the core principle (graph-first) that knowledge state must inform every response. The tutor operates disconnected from what the learner knows, has struggled with, or is missing.

### 2. MCP updates are fire-and-forget with no persistence
When the tutor calls `record_understanding`, `record_confusion`, or `flag_prerequisite_gap`, the agent has no way to surface that those writes happened. The return from `processChatMessage()` hardcodes `nmemoUpdates: []` on line 316–328 of chat-tutor.ts. Even though the agent made targeted graph updates, the route layer and UI have no record of them. The learner sees a tutor that "just knows them" but cannot see what the tutor learned.

### 3. Cross-course context is underused
The MCP toolset includes `find_cross_course_overlaps` and `get_decay_candidates`, but the system prompt does not exemplify or encourage their use. The tutor has access to the full cross-course graph but treats each section in isolation. When a learner encounters a concept that appears in multiple courses, the tutor has no prompt signal to weave that connection into the response.

## Available Primitives

- **Schema:** `chatMessages.nmemoUpdates` column exists (JSON, nullable) but is never populated.
- **MCP toolset:** Full 20+ tools available, including 8 write tools (`record_*`, `flag_*`, `update_learning_trajectory`) and 10+ read tools (including cross-course, causal, decay analysis).
- **Agent infrastructure:** Claude CLI wrapper (`agent.ts`) runs with `--output-format json` and can capture structured output; currently does not parse tool-call traces.
- **Route layer:** `chat.ts` persists the result but does not extract tool calls; it already has the `nmemoUpdates` column.
- **UI layer:** Existing chat-message rendering in `viz/index.html` can add a chip strip under each message.

## Desired End State

1. **Every tutor response is grounded:** Pre-fetch learner facts before the agent starts composing; pass them as context. The tutor must call read tools if they are missing from that pre-fetch.
2. **Tool writes are surfaced:** The agent's `record_understanding(X, 0.8)` call becomes a visible affordance in the chat UI: "📝 recorded: you understand X (0.8)". Reads remain internal (too noisy to surface).
3. **Cross-course pulls are exemplified:** The system prompt includes a worked example: "if the learner mentions a concept, call find_cross_course_overlaps; if it appears in another course they've touched, weave that into your response."
4. **Cold-start tutor works:** A learner with no prior facts in the graph still gets a useful response; the pre-fetch returns empty, the tutor handles that gracefully, and the first writes populate the graph for next time.

## Success Criteria

- Tutor always has concept confidences and recent gaps for the current section before responding.
- At least 1 read tool call fires per conversation turn (get_learner_understanding or equivalent).
- When the tutor makes a write call, it appears in `chatMessages.nmemoUpdates` and renders as a chip in the UI.
- Prompt includes a concrete example of calling find_cross_course_overlaps and weaving overlap into the response.
- No hardcoded `[]` for nmemoUpdates; the array reflects actual tool calls.
