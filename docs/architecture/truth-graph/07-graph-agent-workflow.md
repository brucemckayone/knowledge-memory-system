# Graph Agent Workflow — Five-Phase Knowledge Graph Interaction Protocol

**Status:** Implementation
**Branch:** `feat/sparse-truth-graph`
**Date:** 2026-04-14

## Overview

The graph agent is a unified LLM agent that reads source text and maintains the knowledge graph through a structured five-phase workflow. It replaces the previous two-agent approach (separate extraction agent + causal agent) with a single invocation that shares context across all reasoning tasks.

The agent interacts with the graph exclusively through MCP tools. Text responses are not recorded — all output is via tool calls that create entities, facts, causal edges, and provenance links.

## The Self-Establishing Loop

The graph is the agent's persistent memory across invocations. Each chunk gets a fresh agent instance, but the graph carries forward everything that was learned:

```
Graph State (N) → Agent reads graph → Agent reads source text
                                     → Agent writes to graph → Graph State (N+1)
```

A richer graph means better entity resolution (fewer duplicates), better relationship extraction (more context for ambiguous references), and better causal reasoning (more prior chains to extend). The workflow makes this loop explicit.

## Five Phases

### Phase 1: ORIENT

**Goal:** Understand the current graph state before processing the source text.

The agent surveys the existing graph to build context:

1. **Search for similar prior documents** — `search_memories(query=<source text excerpt>)` finds related prior chunks. This tells the agent what narrative context it's entering.

2. **Read related source material** — `get_memory_text(memory_id)` for the top 2-3 similar memories. The agent now knows what was said before about the same topics.

3. **Query existing entity facts** — For entities mentioned in prior material, `query_entity_facts(entity_id)` shows what relationships are already established.

4. **Check causal history** — `get_causal_history(entity_id)` for key entities reveals existing causal chains that the new text might extend.

**After ORIENT:** The agent knows "R. Walton is a person who has visited these places, has these relationships, and whose journey has caused these effects." When it reads the new chunk mentioning "Walton", it already has context.

**Why ORIENT matters:** Without it, the agent processes each chunk in isolation. With it, chunk 7 knows everything chunks 1-6 established. The graph teaches the agent about itself.

### Phase 2: EXTRACT

**Goal:** Identify named entities in the source text and resolve them against the existing graph.

For each named entity (proper nouns only — not common nouns, pronouns, or generic descriptions):

1. **Search for existing entity** — `search_similar_entities(query=<entity mention>)` checks if this entity already exists in the graph.

2. **Read prior source context** — If a match is found, `get_entity_sources(entity_id)` shows where this entity was mentioned before. This helps disambiguate (is "Walton" the same as "R. Walton" or "Robert Walton"?).

3. **Resolve or create** — `resolve_entity(mention, entity_type, context)` either matches to an existing entity or creates a new one. The system handles alias creation and embedding-based matching.

4. **Link to source** — `link_entity_to_memory(entity_id, memory_id, mention_text)` records provenance.

**Key principle:** Always search before creating. The ORIENT phase already revealed what exists — EXTRACT should not be surprised by any entity.

### Phase 3: RELATE

**Goal:** Create facts (relationships) between resolved entities, with full temporal annotation and source provenance.

For each relationship identified in the text (explicit, implicit, spatial, social, temporal):

1. **Check existing facts** — `query_entity_facts(subject_entity_id)` to see if this relationship already exists. Don't recreate "R. Walton sibling_of Margaret" if it's already in the graph.

2. **Create fact** — `create_fact(subject_entity_id, predicate, object_entity_id, confidence, source_text, source_memory_id, temporal_hint, valid_at, invalid_at)` with full provenance.

**Temporal reasoning:** Every fact has two time dimensions:
- `valid_at` — when this became true in reality (not when recorded)
- `invalid_at` — when this stopped being true (if applicable)

The agent reasons about temporal hints in the text:
- Present tense / "currently" → `temporal_hint="current"`
- Past tense / "formerly" / "six years ago" → `temporal_hint="past"`, estimate `valid_at`
- Future / "shall" / "intend to" → `temporal_hint="future"`, estimate `valid_at`

For exclusive predicates (lives_in, works_at), the system automatically expires the previous value when a new one is created.

**Relationship types to look for:**
- Explicit: "Alice works at Acme" → `works_at`
- Implicit: "I walked through Petersburgh" → speaker `visited` Petersburgh
- Spatial: "the road between X and Y" → X `near` Y
- Social: "my dear sister" → `sibling_of`
- Communication: "I write to you" → `writes_to`
- Pronoun resolution: "I" / "he" / "she" → resolve to the correct entity using ORIENT context

### Phase 4: CAUSE

**Goal:** Reason about cause and effect between the facts just created and the existing graph.

Now that new facts exist (each generating a causal event), the agent reasons about causality:

1. **Review new and existing facts** — `query_entity_facts(entity_id)` for entities that gained new facts. See the full timeline.

2. **Check existing causal chains** — `get_causal_history(entity_id)` for entities with causal history. Look for chains to extend.

3. **Assert causal edges** — For each cause→effect link identified, `create_causal_edge(cause_event_id, effect_event_id, strength, reasoning, source_references)` with:
   - `strength`: 0.3-0.6 for inferred causality, 0.7-1.0 for explicitly stated
   - `reasoning`: Detailed justification explaining the causal mechanism
   - `source_references`: Array of `{type, id, relevance}` pointing to memories, facts, or entities that informed the conclusion

**This phase benefits from shared context:** The agent already understands the narrative from ORIENT, resolved the entities in EXTRACT, and created the facts in RELATE. Causal reasoning naturally follows from this accumulated understanding.

**When to skip:** If no new facts were created, or if the text is purely descriptive with no causal content, the agent can skip this phase.

### Phase 5: VERIFY

**Goal:** Sanity-check what was created before finishing.

1. **Orphan check** — `query_entity_facts(entity_id)` for each newly created entity. If it has zero facts, it may be a false extraction.

2. **Duplicate check** — `search_similar_entities(query=<new entity name>)` for newly created entities. If a very similar entity exists, the agent may have missed a merge.

3. **Consistency check** — Do any newly created facts contradict existing ones? The agent can flag issues without necessarily fixing them.

**This phase is optional** if the turn budget is running low. It catches errors before they propagate into subsequent invocations.

## Tool Inventory

The graph agent has access to the full `GRAPH_TOOLS` catalogue via the unified `graph-mcp.ts` server (see [doc 30 — MCP transport](30-mcp-transport.md) for the contract; tool count is whatever `GRAPH_TOOLS.length` returns, currently 38):

### Read tools (graph investigation)
| Tool | Purpose | Phase |
|------|---------|-------|
| `search_memories` | Semantic search over source texts in Qdrant | ORIENT |
| `get_memory_text` | Retrieve full source text of a memory | ORIENT |
| `search_similar_entities` | Semantic entity search via pgvector | ORIENT, EXTRACT, VERIFY |
| `query_entity_facts` | Get all active facts for an entity | ORIENT, RELATE, CAUSE, VERIFY |
| `query_entity_neighbours` | Traverse the knowledge graph | ORIENT, CAUSE |
| `get_causal_history` | Get existing causal chains for an entity | ORIENT, CAUSE |
| `get_entity_sources` | Entity → source memories with text previews | EXTRACT |
| `get_fact_source` | Fact → source memory with text preview | CAUSE |

### Write tools (graph modification)
| Tool | Purpose | Phase |
|------|---------|-------|
| `resolve_entity` | Resolve mention to existing entity or create new | EXTRACT |
| `create_fact` | Create a relationship with full provenance | RELATE |
| `link_entity_to_memory` | Record entity-to-source provenance | EXTRACT |
| `create_causal_edge` | Assert cause→effect with reasoning + sources | CAUSE |

## Turn Budget

Estimated tool calls per phase for a typical chunk (~3000 chars, ~5 entities, ~5 relationships):

| Phase | Tool calls | Notes |
|-------|-----------|-------|
| ORIENT | 3-5 | search + 2-3 reads + fact queries |
| EXTRACT | 10-15 | (search + resolve + link) × entities |
| RELATE | 5-10 | (check + create) × relationships |
| CAUSE | 3-5 | history queries + edge creation |
| VERIFY | 2-3 | orphan + duplicate checks |
| **Total** | **~25-35** | |

Set `max_turns` to 30. This is one invocation instead of two, halving CLI subprocess overhead.

## Source Provenance Chain

Every piece of data traces back to source material:

```
Entity → memory_entities → Memory (Qdrant) → source text
Fact → source_memory_id → Memory (Qdrant) → source text
Fact → source_text (quote from source)
Causal Event → source_memory_id → Memory (Qdrant)
Causal Edge → source_references[].id → Memory / Fact / Entity
Causal Edge → reasoning (explains the causal mechanism)
```

The agent MUST set `source_memory_id` on every `create_fact` call. The memory_id is provided in the extraction context.

## What This Replaces

- `ml-services/app/extract_agentic.py` → merged into `graph_agent.py`
- `ml-services/app/causal_reason.py` → merged into `graph_agent.py`
- `shouldRunCausalAgent()` trigger logic → the unified agent always reasons about causality
- Separate `invokeCausalAgent()` invocation → single `invokeGraphAgent()` call
- The causal delta assembly in `pipeline.ts` → no longer needed

## Design Principles

1. **The graph is the persistent memory.** The agent doesn't carry state between invocations. Everything it learns must be written to the graph to persist.

2. **ORIENT before EXTRACT.** Always read the graph before modifying it. Context prevents duplicates and enables pronoun resolution.

3. **Search before create.** Every entity resolution starts with a search. Creating without searching produces duplicates.

4. **Full provenance always.** Every fact and causal edge must link back to source material. No assertions without evidence.

5. **The graph establishes itself.** Each invocation builds on prior invocations. The quality of extraction improves as the graph grows richer.
