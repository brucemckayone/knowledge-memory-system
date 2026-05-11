# Multi-Source Processing Architecture

> **Cross-cutting design for source-aware ingestion, conversation context, project association, and processing profiles.**
> Referenced by: W32, W34, W37, W38, W43, W44, W45

---

## Motivation

Mnemo's downstream pipeline (envelope → message processor → ML services → KARMA agents) is already source-agnostic. But treating all content identically is wrong. A Teams chat message, a meeting transcript, a personal Telegram thought, and a forwarded article require fundamentally different processing strategies:

- **A Teams chat message** like "sounds good" is noise in isolation but a recorded decision when understood in context of the preceding discussion.
- **A meeting transcript** needs speaker attribution, action item extraction, and a holistic summary — not per-sentence entity extraction.
- **A personal Telegram thought** is self-contained and needs general-purpose entity/relationship extraction.
- **An email thread** about a project needs commitment tracking, follow-up detection, and project association.

This document defines the architecture for handling these differences.

---

## Three-Level Meaning Model

Every piece of content entering Mnemo is understood at three levels:

```
Level 1: ATOMIC — the individual message
  Stored, embedded, indexed. Searchable immediately.
  Every message gets this treatment regardless of source.

Level 2: CONTEXTUAL — the message understood within its surroundings
  Decisions, agreements, action items, and relationships emerge
  only when a message is processed with its conversation context.
  "sounds good" becomes "Bob confirmed the React decision" at this level.

Level 3: AGGREGATE — the conversation over time
  Rolling summary, project narrative, topic evolution.
  "The Phoenix team discussed architecture for 3 weeks and decided on React
  with a GraphQL API. Key decision-makers: Alice, Bob. 12 action items created."
```

The current system only operates at Level 1. This architecture adds Level 2 (via the Conversation Context Service, W44) and Level 3 (via periodic rollup summaries).

---

## Processing Profiles (W43)

A processing profile determines **what extractors run, what prompts they use, and how content is chunked** for a given piece of content. Profiles are resolved in three layers:

### Layer 1: Source-Type Defaults (static)

Every source type has a hardcoded default profile. These work out of the box with zero configuration.

| Source Type | Default Extractors | Chunking Strategy |
|-------------|-------------------|-------------------|
| `telegram` | entities, relationships, tasks, general classification | standard (4k windows) |
| `teams-chat` | decisions, action items, mentions, topics | by-speaker-turn |
| `email` | summary, follow-ups, commitments, recipients | per-message in thread |
| `transcript` | summary, action items, decisions, attendees, topics | by-speaker-turn |
| `document` | summary, key facts, references, structure | by-section/heading |
| `markdown` | summary, wikilinks as entities, tags, structure | by-heading |
| `audio` | (post-transcription) same as transcript | by-speaker-turn |

### Layer 2: Channel Refinement (learned + overridable)

After processing N messages from a specific channel/source, the system observes patterns and adjusts:

- **Observation-based:** If 30% of messages in `#phoenix-dev` contain JIRA patterns (`PHOE-xxx`), boost the JIRA extractor. If 0% contain technical terms in `#social-committee`, reduce technical extraction sensitivity.
- **User-overridable:** User can hint "this is an engineering channel" and the profile adapts. Hints bias the profile but don't hard-lock it — chats bleed into other topics.
- **Storage:** Channel profiles stored in `channel_profiles` table, updated by the Processing Profile agent.

This is simple frequency analysis, not ML. Count pattern occurrences, adjust extractor weights.

### Layer 3: Project Context Boost (dynamic)

When a conversation is associated with a project (see Project Association below), extraction prompts receive project-specific context:

- *"This message is from #phoenix-dev, associated with Project Phoenix. Look for references to Phoenix milestones, team members ({Alice, Bob, Carol}), and architecture decisions."*
- Project entity summary and known team members are injected into extraction prompts.
- This makes entity resolution more accurate — "Alice" in a Phoenix channel resolves to the Alice who works on Phoenix, not another Alice.

### Profile Resolution

```
resolve(message) → profile:
  1. Start with Layer 1 default for message.sourceType
  2. If channel_profiles[message.channelId] exists, merge overrides
  3. If project association exists for this channel, inject project context
  4. Return merged profile
```

---

## Conversation Context Service (W44)

Manages the sliding context window, extraction rollups, and rolling conversation summaries for ongoing conversation streams (Teams chats, group chats, email threads).

### Adaptive Context Window

The context window for a message is built from three sources, merged by relevance:

1. **Temporal:** Last 30 minutes of messages in the same conversation (recency).
2. **Semantic:** Vector search against the conversation's history for messages similar to the current one (relevance). This catches the dashboard discussion from 2 hours ago when someone now asks about "color scheme," even if lunch happened in between.
3. **Project backdrop:** If the conversation has a project association, the project's rolling summary provides high-level context.

```
buildContextWindow(message, conversation):
  temporal  = messages in conversation where timestamp > (now - 30min), max 30
  semantic  = qdrant.search(message.embedding, filter={conversation_id}, limit=5, min_score=0.7)
  project   = getProjectSummary(conversation.projectAssociation) or null

  return deduplicate(temporal + semantic) + project backdrop
```

The window is bounded: max 30 messages + 5 semantic matches + project summary. This keeps extraction prompt size predictable.

### Extraction Strategy: Pattern-Triggered + Periodic Rollup

Not every message needs full contextual extraction. The strategy:

```
Message arrives
    │
    ├── ALWAYS: store, embed, index (Level 1 — cheap, every message)
    │
    ├── Lightweight trigger scan (regex/keyword, NO LLM call)
    │   ├── Decision patterns: "let's go with", "agreed", "decided", "approved"
    │   ├── Action patterns: "I'll", "will create", "action item", "TODO", "by [day]"
    │   ├── Artifact patterns: "JIRA", "PROJ-", "PR #", "ticket", "RFC"
    │   ├── Escalation patterns: "blocker", "deadline", "urgent", "heads up"
    │   │
    │   ├── MATCH → immediate contextual extraction with adaptive window (Level 2)
    │   └── NO MATCH → defer to rollup
    │
    └── Every N messages or M minutes (whichever first):
        ROLLUP — single comprehensive extraction over accumulated window (Level 2 + 3)
        ├── Extract any missed decisions, actions, facts
        ├── Update rolling conversation summary (Level 3)
        └── Update project association confidence scores
```

**Why this hybrid:**
- Every-message extraction: 200 LLM calls for a 200-message chat. Wasteful.
- Pattern-only: Misses subtle agreements. "sounds good" after an architectural debate = a decision, but doesn't match patterns. The rollup catches it.
- Rollup-only: Delays time-sensitive action items. If Bob says "I'll create the JIRA by EOD" the trigger catches it immediately.

### Rolling Conversation Summary

Each active conversation maintains a living summary, updated at every rollup:

```
ConversationSummary {
  conversationId: string
  title: string                   // Inferred or user-set
  currentTopics: string[]         // Active discussion topics
  participants: string[]          // Active speakers
  decisions: Decision[]           // Extracted decisions with context
  openActionItems: ActionItem[]   // Unresolved items
  projectAssociations: { projectId: string, confidence: number }[]
  lastUpdated: Date
  messageCount: number
  summaryText: string             // LLM-generated narrative summary
}
```

The summary is stored in both Postgres (structured fields) and Qdrant (embedded for semantic search). This enables: *"What has the Phoenix team been discussing this week?"* — searches conversation summaries by semantic similarity to the query + project filter.

---

## Project Association (W45)

### Philosophy

Projects are amorphous. Communication bleeds across channels. A Phoenix discussion might happen in `#phoenix-dev`, spill into `#engineering-general`, get followed up in email, and produce JIRA tickets. The system must discover project associations organically, not require explicit binding.

### Association Mechanism

Project association is probabilistic, not binary. A memory can be 80% Phoenix, 40% Infrastructure. Three signals feed the association:

1. **Entity co-occurrence:** If a memory mentions entities that are known facts about Project Phoenix (team members, technologies, milestones), it gets associated.
2. **Vector proximity:** If a memory's embedding is close to Phoenix's entity embedding (or to other memories already associated with Phoenix), it gets associated.
3. **Source binding (soft):** User hints like "this channel is mostly about Phoenix" provide a prior. New messages from that channel start with a baseline association score.

```
associateWithProject(memory):
  scores = {}

  // Signal 1: Entity overlap
  memoryEntities = getEntitiesInMemory(memory.id)
  for project in activeProjects:
    projectEntities = getEntitiesForProject(project.id)
    overlap = intersection(memoryEntities, projectEntities)
    scores[project.id] += overlap.size * ENTITY_WEIGHT

  // Signal 2: Vector proximity
  for project in activeProjects:
    similarity = cosineSimilarity(memory.embedding, project.embedding)
    scores[project.id] += similarity * VECTOR_WEIGHT

  // Signal 3: Source binding prior
  if channelBinding = getChannelBinding(memory.conversationId):
    scores[channelBinding.projectId] += BINDING_WEIGHT

  // Threshold: only associate if confidence > 0.3
  return scores.filter(s => s > 0.3)
```

### Confirm on Ambiguity

When the system can't confidently associate content (multiple projects equally likely, or no project above threshold), the ambiguous items are accumulated and surfaced in the **daily digest** (see W32 Morning Briefing). The user reviews and confirms, and the system retroactively updates associations.

Retroactive update uses the bi-temporal model: the association existed from the memory's creation time (valid_at), but we only learned about it now (created_at).

### Materialized View: `project_associations`

Rather than computing project associations live on every query, a KARMA agent (W45) periodically materializes a `project_associations` table:

```sql
CREATE TABLE project_associations (
  memory_id    UUID NOT NULL,
  project_id   UUID NOT NULL REFERENCES entities(id),
  confidence   REAL NOT NULL,
  sources      TEXT[] NOT NULL,  -- ['entity_overlap', 'vector', 'user_confirmed', 'channel_binding']
  computed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (memory_id, project_id)
);

CREATE INDEX idx_project_assoc_project ON project_associations(project_id, confidence DESC);
CREATE INDEX idx_project_assoc_memory ON project_associations(memory_id);
```

This enables efficient cross-source project queries:

```sql
-- "Everything about Phoenix, ordered by relevance"
SELECT m.*, pa.confidence, pa.sources
FROM project_associations pa
JOIN memories m ON m.id = pa.memory_id
WHERE pa.project_id = $phoenixId
  AND pa.confidence > 0.5
ORDER BY pa.confidence DESC, m.created_at DESC;
```

The view is refreshed by the Project Association Agent on a periodic schedule (nightly) and incrementally for new memories as they arrive.

---

## Cross-Source Querying

With the above pieces in place, *"Show me everything about Project Phoenix"* works as:

```
1. Resolve "Phoenix" → entity ID (entity resolution)
2. Query project_associations WHERE project_id = phoenixId
3. Enrich with:
   - Facts where Phoenix is subject or object
   - Conversation summaries associated with Phoenix
   - Graph traversal: entities connected to Phoenix (team members, technologies)
4. Present results grouped by source type and sorted by relevance:
   - Teams discussions (conversation summaries)
   - Decisions made (extracted from rollups)
   - Action items (open and closed)
   - Related entities (people, technologies)
   - Source memories (individual messages, with source attribution)
```

---

## Ambiguity Surfacing: Daily Digest (W32)

Unresolved ambiguities from the day — project associations the system couldn't confidently make — are accumulated and presented in the morning briefing:

```
🔍 Needs Your Input

  These items could belong to multiple projects:
  • "Let's revisit the auth approach" (from #engineering-general)
    → Phoenix (62%) or Infrastructure (48%)?

  • Meeting transcript "API review 2026-03-18"
    → Phoenix (55%) or Platform Core (51%)?

  Reply with the number to confirm, or ignore to let the system decide.
```

User confirmations feed back into the association model as high-confidence signals, improving future inferences.

---

## Impact on Existing Work Packets

| Packet | Change |
|--------|--------|
| W32 (Morning Briefing) | Add ambiguity digest section |
| W34 (Source Adapter Framework) | Add processing profile resolution to IngestRouter |
| W37 (Document & Transcript ML) | Add conversation-aware extraction prompts |
| W38 (Meeting Capture) | Reference conversation context service for meeting streams |
| Phase 6 README | Add W43–W45, update dependency graph |

---

## New Work Packets

| Packet | Name | Dependencies |
|--------|------|-------------|
| W43 | Processing Profile System | W34 |
| W44 | Conversation Context Service | W34, W43 |
| W45 | Project Association Agent | W44 |

---

## Related Documents

- [Phase 6 README](../work-packets/phase6/README.md)
- [W34: Source Adapter Framework](../work-packets/phase6/W34-source-adapter-framework.md)
- [Architecture: Current](./current.md)
