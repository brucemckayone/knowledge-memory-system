# Work Packet W22b: Context-Linker Agent

**Status:** ✅ Complete
**Dependencies:** W21 (Gardener Scheduler)
**Tier:** Frequent

---

## Objective

Implement the Context-Linker Agent, a KARMA agent that processes expired ingestion sessions to detect meaningful relationships between temporally-close items from the same user. This agent was created to absorb the session-grouping responsibilities originally planned for the Ingestion Agent (W22), which was retired.

---

## Responsibilities

- Process expired ingestion sessions (2+ members)
- Compute entity overlap from `memory_entities`
- Generate context summaries via LLM and re-embed members with context prepended
- Create CO_TEMPORAL knowledge graph edges (bi-temporal facts)
- Cross-link members in Qdrant (`related_to` payload)
- Propagate shared tags across session members
- Close single-member sessions without enrichment
- Chain to conflict-resolution agent when new facts are created

---

## Schema

Migration `011_ingestion_sessions.sql` creates two tables:

```sql
CREATE TABLE IF NOT EXISTS ingestion_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sender_id TEXT NOT NULL,
  session_key TEXT NOT NULL UNIQUE,
  opened_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  closed_at TIMESTAMPTZ,
  member_count INTEGER NOT NULL DEFAULT 0,
  raw_types TEXT[] NOT NULL DEFAULT '{}',
  platforms TEXT[] NOT NULL DEFAULT '{}',
  shared_entities UUID[] DEFAULT '{}',
  shared_tags TEXT[] DEFAULT '{}',
  context_summary TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS ingestion_session_members (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL REFERENCES ingestion_sessions(id) ON DELETE CASCADE,
  memory_id UUID NOT NULL,
  platform TEXT NOT NULL,
  raw_type TEXT NOT NULL,
  content_preview TEXT,
  ingested_at TIMESTAMPTZ NOT NULL,
  UNIQUE(session_id, memory_id)
);
```

---

## Implementation

**Agent:** `platform/src/gardener/agents/context-linker.agent.ts` (276 lines)
**Service layer:** `platform/src/services/ingestion-context.ts`

### Processing Flow

1. Close single-member sessions immediately (no enrichment needed)
2. Find multi-member sessions whose window has expired
3. For each qualifying session:
   - Fetch content from Qdrant for each member
   - Compute entity overlap across members via `getMemoryEntities()`
   - Generate a context summary via LLM (`ml.chat`)
   - Re-embed each member with `[Context: {summary}] {content}` prepended
   - Update Qdrant payload with `related_to`, `ingestion_session_id`, shared `tags`, `context_summary`
   - Create CO_TEMPORAL facts for each pair of members (if shared entities exist)
   - Close session with computed aggregates
4. Chain to `gardener:resolve-conflicts` if any facts were created

### Error Handling

- LLM failure falls back to a simple summary ("Items share context around: {entities}" or "Items captured in the same time window")
- Individual member re-embedding failures are logged and skipped (session still closes)
- Individual session failures are logged; session is closed to avoid reprocessing
- Throws `AgentError` for unexpected failures

### Configuration

- `INGESTION_SESSION_WINDOW_MINUTES` — configurable window for session expiry (default 15 minutes)

---

## Tests

**File:** `platform/src/test/agents/context-linker.test.ts` (340 lines)

| Test ID | Description |
|---------|-------------|
| CL-001 | Correct name and tier |
| CL-002 | Returns success with no sessions |
| CL-003 | Closes single-member sessions without enrichment |
| CL-004 | Processes multi-member sessions with full context enrichment |
| CL-005 | Handles LLM failure with fallback summary |
| CL-006 | Does not create facts when no shared entities exist |
| CL-007 | Creates facts for all pairs with 3+ members (C(n,2) facts) |

---

## Acceptance Criteria

- [x] Agent registered with controller as `context-linker` (frequent tier)
- [x] Single-member sessions closed without ML calls
- [x] Multi-member sessions produce context summaries
- [x] Members re-embedded with context prepended
- [x] Cross-links set in Qdrant (`related_to` payload)
- [x] Shared tags propagated across members
- [x] CO_TEMPORAL facts created for shared-entity pairs
- [x] Chains to conflict resolution when facts are created
- [x] Graceful fallback when LLM is unavailable

---

## Related Packets

- [W22: Ingestion Agent](./W22-ingestion-agent.md) (predecessor, replaced)
- [W21: Gardener Scheduler](../phase3/W21-gardener-scheduler.md) (dependency)
- [W26: Relationship Agent](./W26-relationship-agent.md) (also creates facts)
- [W28: Conflict Resolution](./W28-conflict-resolution.md) (downstream chain target)
