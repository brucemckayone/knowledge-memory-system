# Notes, Risks, Open Questions

## Risks

### Over-eager writes amplifying noise
If the tutor records understanding for every slight signal ("the learner said 'ok'"), the graph will fill with low-confidence, low-evidence facts. Mitigation: system prompt explicitly says "Only call when there is clear evidence" and caps confidence levels (0.3-0.5 for weak signals, 0.7-0.9 for strong). Consider a secondary gate: route layer could soft-delete updates where confidence < 0.4 and evidence length < 50 chars.

### Tool-call capture brittle if Claude CLI flags change
If the CLI changes --output-format json output shape or stops including result in a future version, the parser breaks. Mitigation: Option C (structurally embed nmemoUpdates in tutor response) is more resilient. The tutor controls the output format, not the CLI.

### Chip clutter if too many writes per message
A single tutor message might perform 3-4 writes. Rendering 3-4 chips could overwhelm the UI. Mitigation: group chips by tool type. Example: "📝 Recorded (3): closures, higher-order functions, recursion" with one click to expand all three.

### Pre-fetch timeout or MCP service unavailability
If get_learner_understanding(concept) times out or the MCP server is down, the entire chat POST hangs or fails. Mitigation: pre-fetch calls must timeout gracefully after 3 seconds with partial results; if all fail, fall back to empty context and log the error. Chat must not be blocked.

## Open Questions

### Should writes be debounced if 3+ in one message?
Currently: every write is persisted immediately. Concern: rapid-fire writes might be noise. Alternative: buffer writes in the message, deduplicate on (tool, concept), only persist unique ones. Recommendation: defer to v1; monitor and decide based on data.

### How to attribute facts to chat session vs section?
Currently: facts record Learner understands X with evidence from chat. But facts live globally in the graph; there's no "chat_session_id" field in a fact. If learner revises understanding later (records new confidence for same concept), old fact is not deleted—just new fact is added. This is correct for the graph (immutable log) but means chat UI shows only writes, not the full fact history. Clarification: nmemoUpdates captures only the writes this chat session made, not prior facts. Accept this; it's the right scoping.

### Version compatibility: what if sections.conceptEntityIds is empty?
Many older sections may not have conceptEntityIds populated. In those cases, pre-fetch skips concept-specific reads and only calls get_learning_gaps(section_topic), which is broader. Tutor still responds (no concept-specific context, but section context available). This is fine; sections will get retroactively enriched over time.

### Should highlight popover (explainer agent) also surface graph writes?
Currently: explainer popover is separate from chat sidebar. If learner asks "what's a closure?" via popover, does that update get surfaced in the chat sidebar? Recommendation: defer. Popover and chat are different affordances; popover writes go to graph but not visible in chat. Keep them decoupled for v1.

## Alternatives Considered

### Alternative 1: Structured multi-tool calls instead of free-form agent
Instead of letting the tutor decide which tools to call, define a rigid sequence: (1) call get_learner_understanding for top 3 concepts, (2) call flag_prerequisite_gap if needed, (3) respond. Pro: deterministic, predictable. Con: inflexible; tutor can't adapt to learner's question. Rejected: agent approach is more natural.

### Alternative 2: Log tool calls via a separate audit table
Store MCP tool calls in a separate audit_log table keyed by session_id + timestamp. Route layer queries that table post-response and merges into nmemoUpdates. Pro: audit trail independent of chat messages. Con: adds coupling; two sources of truth. Rejected: Option C (embed in response) is simpler.

### Alternative 3: UI surface ALL tool calls (reads + writes)
Show the learner every tool call the tutor made, including reads. Pro: radical transparency. Con: noisy; learner doesn't care what the tutor read internally. Rejected: writes-only is correct.

## Code Paths & Follow-Ups

### Immediate (v1 scope)
1. `learn/src/routes/chat.ts`: Pre-fetch LearnerChatContext before spawning agent. Inject into prompt. Parse nmemoUpdates from response.
2. `learn/src/agents/chat-tutor.ts`: Update system prompt with LearnerChatContext section and cross-course worked example. Modify response shape to include nmemoUpdates. Extend parseStructuredBlocks to validate nmemoUpdates array.
3. `learn/src/db/schema.ts`: No changes needed; nmemoUpdates column already exists.
4. `learn/viz/`: Add NmemoUpdateChips component. Render under chat messages with nmemoUpdates. Click to expand detail.
5. Tests: add 4-6 integration tests (pre-fetch fires, tool calls captured, chips render, cold-start works).

### Follow-Up (v0.3+)
- Monitor write frequency: if tutor averages >2 writes per message, consider debouncing or teach tutor to batch related concepts.
- Add "Undo" affordance to chips: click to soft-delete fact from graph (record a negative predicate).
- Extend lesson_overlays: if tutor generates a component via edit_lesson_section, that also goes into nmemoUpdates for auditability.
- Harvest: once 100+ chat sessions exist with nmemoUpdates, run queries on fact creation patterns to optimize prompt guidance.

### Deferred / Out of Scope
- Multi-learner support (stays deferred; this platform is single-learner).
- API endpoint to query tool-call traces post-hoc (nice-to-have; not critical for v1).
- Side-by-side fact-history UI (learner sees all understanding facts for a concept across time).
- Collaborative editing: when learner and tutor co-author a fact, both are credited (stays deferred).

## Metrics / Success Indicators

- Pre-fetch latency: target <3 seconds for a 5-concept section.
- Tutor writes per message: target 0.5–1.5 average (not overeager).
- Chip render latency: target <100ms (client-side, instant).
- Cold-start failure rate: target 0% (graceful empty state always works).
- Cross-course mention frequency: expect 10-20% of tutor messages to mention an overlap (tutor judgment).

## Testing Strategy

Run integration test suite against a real learn instance with seeded learner facts in Nmemo. Validate:
1. Pre-fetch calls land and return expected shape.
2. Agent receives context in prompt and acknowledges it ("Based on your prior understanding...").
3. nmemoUpdates array is parsed, validated, and persisted.
4. Chips render and expand correctly.
5. Cold-start learner (no facts) doesn't error.
6. Partial failures (one pre-fetch call times out) degrade gracefully.
