# Acceptance Criteria

## Learner-State Reads

1. Every POST /api/chat/sessions/:id/messages request pre-fetches learner state via MCP before spawning the agent: get_learner_understanding for each concept in the section's conceptEntityIds, get_learning_gaps(section_topic), find_cross_course_overlaps(). These calls execute in parallel and complete within 5 seconds.

2. The tutor's system prompt includes the LearnerChatContext (concept confidences, recent gaps, cross-course overlaps) as explicit context under a new section "Learner's current state in this section".

3. When the tutor's first turn response is composed, it has access to the pre-fetched state. If state is empty (cold-start learner), the tutor responds without error and does not hallucinate facts.

## Compelled Reads & Tool Exemplification

4. The tutor's system prompt includes a worked example: "If the learner mentions a concept that appears in find_cross_course_overlaps, weave that connection into your response: 'You learned about X in Course A. In Course B, the same idea is called Y, and here's how they map.'"

5. When a learner's message contains a concept name matching sections.conceptEntityIds, the tutor calls at least one of (get_learner_understanding, get_struggle_areas) before composing the response. Verifiable in MCP logs or trace output.

## Tool Calls Captured in nmemoUpdates

6. The tutor's structured JSON response includes a new field `nmemoUpdates: [...]` (array of objects, empty if no writes were made).

7. Each object in nmemoUpdates has the shape: `{ tool: 'record_understanding'|'record_confusion'|'flag_prerequisite_gap'|'update_learning_trajectory', concept: string, confidence?: number, misconception?: string, evidence?: string, factId?: string, recordedAt: ISO8601 }`.

8. When tutor calls record_understanding('closures', 0.8, evidence), the resulting nmemoUpdates entry includes all fields and exactly matches the tool call signature.

9. The route layer (chat.ts) parses the tutor's JSON response, extracts nmemoUpdates, and persists to chatMessages.nmemoUpdates as a JSON string.

10. GET /api/chat/sessions/:id/messages returns each assistant message with nmemoUpdates populated (non-null, valid JSON array or empty array).

## UI Affordance: Chips

11. The chat UI renders a chip strip under any assistant message where nmemoUpdates is non-empty and non-null.

12. Each chip shows: "[tool icon] [concept] ([confidence if applicable])". Example: "📝 closures (0.8)", "🚩 higher-order functions (gap)".

13. Clicking a chip expands an inline detail card showing: tool name, concept, confidence/misconception, evidence snippet, factId, recordedAt.

14. When nmemoUpdates is empty, no chip strip is rendered (no visual clutter).

## Privacy: Writes-Only Surfacing

15. Read tool calls (get_learner_understanding, get_struggle_areas, etc.) are NOT surfaced in the chat UI. Only write calls are visible.

16. If the route layer or agent internally calls a read tool but the tutor does not perform a write, the learner sees no affordance for that read.

## Cross-Course Intelligence

17. When find_cross_course_overlaps() indicates a concept appears in another course, the tutor's response explicitly mentions that overlap and maps the concepts (e.g., "closures" vs "move closures" in Rust vs JavaScript). Verifiable by text search in tutor response.

## Cold-Start Behavior

18. A learner with zero prior facts in the graph (conceptConfidences empty, recentGaps empty) still receives a sensible, error-free tutor response. The response does not mention "no data available" or "learner unknown". Instead it teaches the concept fresh and offers to record the learner's understanding later.

## Hardcoded nmemoUpdates Eliminated

19. The return statement in processChatMessage() no longer contains a hardcoded `nmemoUpdates: []`. Instead, the array is populated from the agent's structured response.

20. If the agent returns plain text (not structured JSON), nmemoUpdates defaults to [] and no error is raised. (Graceful fallback.)

## Edge Cases

21. If a learner message contains multiple concepts, the tutor prioritizes reads and writes for the top 1-2 most relevant concepts to avoid tool-call explosion.

22. If find_cross_course_overlaps() returns no results, the tutor does not force a mention; it only weaves overlap if data exists.

23. If a write tool fails (e.g., recordFact() throws), the tutor's response continues gracefully; the failed update is logged but does not crash the chat.
