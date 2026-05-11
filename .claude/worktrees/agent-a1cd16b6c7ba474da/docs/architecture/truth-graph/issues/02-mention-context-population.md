# Mention Context Population

**Priority:** High — easy win
**Complexity:** Low
**Branch:** `fix/mention-context-population`
**Date:** 2026-04-16

---

## Problem

The `mention_context` column on `memory_entities` exists and the storage function accepts it, but the `link_entity_to_memory` MCP tool does not expose a context parameter. Every entity-memory link in the database has `mention_context = NULL`.

This weakens cross-entity inference. When two entities share a source memory, you can't see WHY they were mentioned together without reading the full source text. The context field was designed to carry the surrounding 50-200 characters around the entity mention — the local textual context that helps disambiguation and relationship discovery.

---

## What Exists

- **Column:** `memory_entities.mention_context TEXT` (`src/db/schema.ts:97`)
- **Storage function:** `linkMemoryToEntity()` (`src/services/entities.ts:339-353`) — accepts `mention.context` parameter and stores it at line 351
- **Retrieval:** `get_entity_sources` tool (`src/services/causal-agent.ts:795`) returns `mentionContext` to agents
- **Display:** Visualizer detail panel shows mention context when available (`src/index.ts:142, 563`)

## What's Missing

- `link_entity_to_memory` tool schema (`src/services/causal-agent.ts:326-346`) has no `mention_context` parameter
- Tool handler (`src/services/causal-agent.ts:820-827`) only passes `{ text: toolInput.mention_text }` — no context
- Graph agent prompt (`ml-services/app/graph_agent.py`) doesn't instruct the LLM to include context when linking
- `linkEntitiesToMemory()` batch function (`src/services/entities.ts:359-399`) also doesn't pass context (line 382)

---

## Proposed Fix

### 1. Tool schema update

Add `mention_context` to the `link_entity_to_memory` tool definition in `src/services/causal-agent.ts`:

```typescript
mention_context: {
  type: 'string',
  description: 'Surrounding text context (50-200 chars around the mention) to aid disambiguation and cross-entity inference',
},
```

### 2. Tool handler update

In the handler (`src/services/causal-agent.ts:820-827`), pass context through:

```typescript
case 'link_entity_to_memory': {
  await linkMemoryToEntity(
    toolInput.memory_id as string,
    toolInput.entity_id as string,
    {
      text: toolInput.mention_text as string,
      context: toolInput.mention_context as string | undefined,
    },
  );
  return JSON.stringify({ linked: true });
}
```

### 3. Graph agent prompt update

In `ml-services/app/graph_agent.py`, update the `link_entity_to_memory` tool description in the AVAILABLE TOOLS section, and add to PHASE 2 STEP 5:

```
STEP 5 — LINK: call link_entity_to_memory(entity_id=<id>, memory_id=<MEMORY_ID>, mention_text=<exact text>, mention_context=<50-200 chars of surrounding text>).
The mention_context helps future agents understand WHY this entity was mentioned in this source. Include enough surrounding text to provide disambiguation context.
```

---

## Files to Modify

| File | Change |
|------|--------|
| `src/services/causal-agent.ts` | Add `mention_context` to tool schema (line ~340) and handler (line ~820) |
| `ml-services/app/graph_agent.py` | Update PHASE 2 STEP 5 instruction + tool reference section |

---

## Test Strategy

1. **Unit:** Call `link_entity_to_memory` tool with `mention_context` set, query `memory_entities` and verify `mention_context` is stored
2. **Integration:** Run a full ingest, verify new `memory_entities` rows have populated `mention_context`
3. **Retrieval:** Call `get_entity_sources` tool and verify context appears in results
4. **Backwards compatible:** Call `link_entity_to_memory` without `mention_context`, verify it still works (NULL context)

---

## Impact

Once populated, mention contexts enable:
- Cross-entity inference: "Entity A and Entity B were mentioned together in the context of X"
- Better disambiguation: the same name in different contexts resolves to different entities
- Richer gardener investigation: the gardener can read why entities appear together without fetching full source texts
- Improved visualizer detail panel: context snippets shown alongside entity mentions
