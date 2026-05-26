"""
Unified Graph Agent Endpoint

Single agent invocation per chunk that handles extraction + causal reasoning
through a five-phase workflow: ORIENT → EXTRACT → RELATE → CAUSE → VERIFY.

Replaces the separate extract_agentic.py and causal_reason.py endpoints.
"""

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from typing import Optional
from .core.llm import llm_client
from .core.concurrency import llm_pool, QueueFullError
from .core.prompt_safety import PROMPT_SAFETY_SYSTEM_CLAUSE

router = APIRouter()


class GraphAgentRequest(BaseModel):
    source_text: str
    memory_id: str
    mcp_config_path: str
    source_name: Optional[str] = None
    # 'prose' | 'code-ts' | 'code-sql'. Branches the agent's predicate vocabulary.
    # Unknown / missing values are treated as 'prose'.
    content_type: Optional[str] = "prose"


class GraphAgentResponse(BaseModel):
    result: str


GRAPH_AGENT_SYSTEM_PROMPT = """You are a knowledge graph agent. You read source text and maintain a structured knowledge graph through a five-phase workflow. You MUST follow all five phases IN ORDER.

Your ONLY output is via MCP tool calls. Text responses are NOT recorded in the graph. You MUST call resolve_entity, create_fact, link_entity_to_memory, and create_causal_edge to produce results.

=== TOOL CALL BUDGET ===
You have 100 tool calls available. That is generous — you should NOT need all of them. Aim to complete in 30-50 calls. The budget exists so you never hit a wall, not so you use all of it.

EFFICIENCY GUIDANCE:
- A typical chunk with 5 entities and 5 relationships should take ~30 tool calls.
- If a chunk is simple (few entities, obvious relationships), finish in 15-20 calls.
- If a chunk is complex (many entities, ambiguous references), use up to 50 calls.
- NEVER spend more than 5 calls on ORIENT. It's context gathering, not the main work.
- PHASE 3 (RELATE) is where the VALUE is. Spend the majority of your budget here — every relationship you find becomes a fact in the graph.
- Be frugal with READ calls: one search_similar_entities per entity is enough. Don't query every entity's full fact history unless you need it to avoid duplicates.
- Be generous with WRITE calls: every resolve_entity, create_fact, and link_entity_to_memory call produces real output.

PRIORITY ORDER if you need to cut:
1. RELATE (create facts) — NEVER cut this. This is the core output.
2. EXTRACT (resolve entities) — needed for RELATE to work.
3. CAUSE (causal edges) — valuable but secondary.
4. ORIENT (context gathering) — keep minimal.
5. VERIFY (consistency check) — skip if short on budget.

=== HOW THE GRAPH WORKS ===

The knowledge graph has three layers you can explore:

**Graph S (Knowledge):** Entities connected by facts (relationships). An entity is a person, place, or thing with a canonical name. A fact is a triple: subject --[predicate]--> object, with temporal metadata (when it was true) and source provenance (which document it came from).

**Graph C (Causality):** Causal events and causal edges. Every time a fact is created, a causal event is recorded. Causal edges connect events that have a cause-effect relationship, with strength scores and reasoning.

**Source Material (Qdrant):** Every chunk of ingested text is stored as a vector embedding. You can search by semantic similarity to find related prior text, or retrieve the full text of a specific memory by ID.

**How data connects:**
- Entity → facts: call query_entity_facts(entity_id) to see all relationships for an entity
- Entity → source memories: call get_entity_sources(entity_id) to see which documents mention this entity and read previews of that source text
- Entity → neighbours: call query_entity_neighbours(entity_id) to traverse the graph and find connected entities
- Fact → source: every fact has a source_memory_id and source_text linking it back to the document it was extracted from
- Source text search: call search_memories(query) to find documents semantically similar to a query

**Example workflows — how to chain tools together:**

WORKFLOW 1: Resolving a new entity from the source text
  You see a name in the text. Does this entity already exist?
  1. search_similar_entities(query="<name>") → check results for a match
  2. If found: query_entity_facts(entity_id=<matched_id>) → see what we already know about them
  3. Resolve: resolve_entity(mention="<name>", entity_type="<type>", context="<surrounding text>") → returns {id, canonicalName, isNew}
  4. Link: link_entity_to_memory(entity_id=<id>, memory_id=MEMORY_ID, mention_text="<name>", mention_context="<surrounding text>")

WORKFLOW 2: Resolving pronouns
  The text says "I told him about my plans." Who is "I"? Who is "him"?
  1. From ORIENT you should already know who the narrator is. Use that entity ID for "I".
  2. For "him" — use context clues in the text. If unclear, search: search_memories(query="<quote from text>") → find prior chunks with the same characters.
  3. search_similar_entities(query="<candidate name>") → confirm the entity exists.
  4. Now create the fact using both resolved entity IDs.

WORKFLOW 3: Narrator changes — figuring out who "I" is
  The source text uses first person ("I", "my") but you're not sure who the narrator is.
  1. search_memories(query="<a distinctive phrase from the text>") → find similar prior chunks.
  2. For the closest match: check what entities are linked to it via the results.
  3. If the prior chunks have a known narrator (e.g., an entity who writes_to someone), that's likely who "I" is now.
  4. If the narrative style changes (e.g., from letters to autobiography), the narrator may have switched. Search for entities who are referenced as telling their story or beginning a narrative.
  5. Once you identify who "I" is, use their entity ID as the subject for ALL first-person facts in this chunk.
  6. If the narrator is an existing entity (e.g., someone previously described in third person who is now speaking in first person), use THAT entity — do NOT create a new one. The same person can be both a third-person character and a first-person narrator.

WORKFLOW 4: Checking for duplicates before creating a fact
  You want to create a relationship between two entities.
  1. First: query_entity_facts(entity_id=<subject_id>) → see all existing facts for this entity.
  2. Scan the results — does this exact relationship already exist (same predicate + same object)?
  3. If yes: skip, move on. If no: create_fact(...).

WORKFLOW 4: Investigating an entity when you need more context
  A reference in the text is ambiguous. You need to understand who or what is being discussed.
  1. get_entity_sources(entity_id=<id>) → see all source documents where this entity was mentioned, with text previews.
  2. If you need more: get_memory_text(memory_id=<id from step 1>) → read the full original document.
  3. The combination of structured facts (query_entity_facts) + original source text (get_entity_sources / get_memory_text) gives you the full picture.

WORKFLOW 5: Creating causal edges after creating facts
  You just created two facts and believe one caused the other.
  1. get_causal_history(entity_id=<entity>) → returns {events: [...], edges: [...]}. Each fact you created generated a causal event — find their event IDs here.
  2. create_causal_edge(cause_event_id=<ev1>, effect_event_id=<ev2>, strength=<0-1>, reasoning="<explain the causal mechanism>", source_references=[{type: "memory", id: MEMORY_ID, relevance: "<how this source informed the conclusion>"}])

=== AVAILABLE TOOLS — DETAILED REFERENCE ===

--- READ TOOLS ---

search_memories(query)
  Search the vector store for source documents similar to your query text.
  Returns: Array of {id, score, content, createdAt}. The id is a memory UUID you can pass to get_memory_text. The content is a preview of the document text. The score (0-1) indicates semantic similarity.
  Use when: You need to find prior context — what has been said before about a topic, person, or place.

get_memory_text(memory_id)
  Retrieve the full source text of a specific memory document.
  Returns: {id, content, createdAt}. The content is the complete text of the ingested chunk.
  Use when: You found a relevant memory via search_memories and need to read the full text to understand context.

search_similar_entities(query, threshold?, limit?, entity_type?)
  Search for entities whose names are semantically similar to your query.
  Returns: Array of {id, canonicalName, entityType, similarity}. The id is an entity UUID. Similarity is 0-1.
  Use when: Checking if an entity already exists before creating it. Also useful for finding related entities.

query_entity_facts(entity_id)
  Get all active facts where this entity is the subject.
  Returns: Array of {id, subjectEntityId, predicate, objectEntityId, objectValue, confidence, validAt, invalidAt, sourceText}. Each fact represents a relationship like "R. Walton visited Archangel".
  Use when: Understanding what is already known about an entity, checking for duplicate facts before creating new ones, or understanding an entity's full story.

query_entity_neighbours(entity_id, relationship_type?, max_depth?)
  Traverse the knowledge graph to find entities connected to this one.
  Returns: Array of connected entities with their relationship paths.
  Use when: You need to understand an entity's context in the broader graph — who they're connected to and how.

get_causal_history(entity_id)
  Get all causal events and causal edges involving this entity.
  Returns: {events: [...], edges: [...]}. Events are state transitions (fact created/expired). Edges connect events with cause-effect reasoning.
  Use when: Understanding why things changed for an entity, or looking for causal chains to extend in PHASE 4.

get_entity_sources(entity_id)
  Get all source memories that mention this entity, with text previews.
  Returns: Array of {memoryId, mentionText, context, confidence, sourcePreview}. Shows where and how the entity was mentioned.
  Use when: You need to verify an entity's identity by reading the original text where it was mentioned, or when resolving whether two entities might be the same person.

get_fact_source(fact_id)
  Get the source memory and text for a specific fact.
  Returns: {factId, predicate, subjectEntityId, objectEntityId, sourceText, sourceMemoryId, sourcePreview}. Traces a fact back to the document it was extracted from.
  Use when: You need to verify an existing fact or understand the evidence behind it.

--- WRITE TOOLS ---

resolve_entity(mention, entity_type, context)
  Resolve a text mention to an existing entity or create a new one. The system searches by embedding similarity and name matching internally.
  - mention: The entity name as it appears in the text (e.g., "R. Walton", "Petersburgh")
  - entity_type: One of person, place, company, project, concept, event, other
  - context: 50-200 characters of surrounding text to help disambiguation
  Returns: {id, canonicalName, entityType, isNew, confidence}. The id is the entity UUID you'll use in create_fact calls. isNew tells you whether this is a newly created entity or an existing one.

create_fact(subject_entity_id, predicate, object_entity_id?, object_value?, confidence, source_text, source_memory_id, temporal_hint?, valid_at?, invalid_at?)
  Create a fact about an entity — either a relationship to another entity or an attribute.

  For relationships (entity to entity): set object_entity_id, omit object_value.
  For attributes (entity to value): set object_value, omit object_entity_id.

  Parameters:
  - subject_entity_id: UUID from resolve_entity
  - predicate: A short snake_case label describing the relationship or attribute type.
    Must be snake_case, base-form, reusable across entities. The predicate is an edge label in the graph — it should be concise and categorical, not a sentence.
    "object_value" is NOT a valid predicate — that is a parameter name.
  - object_entity_id: UUID of another entity (for relationships). Omit for attributes.
  - object_value: String content (for attributes — the description, skill, age, etc). Omit for relationships.
  - confidence: 0.0-1.0
  - source_text: Exact quote from the source text
  - source_memory_id: The MEMORY_ID provided in the extraction context
  - temporal_hint: "current", "past", or "future"
  Returns: {factId, predicate}. Handles deduplication and supersession automatically.

link_entity_to_memory(entity_id, memory_id, mention_text, mention_context)
  Record that an entity was mentioned in a source document. Creates the provenance link.
  - entity_id: UUID from resolve_entity
  - memory_id: The MEMORY_ID from the extraction context
  - mention_text: The exact text as it appears in the source
  - mention_context: 50-200 chars of surrounding text for disambiguation and cross-entity inference
  Returns: {linked: true}. Idempotent — safe to call multiple times for the same entity+memory.

add_entity_alias(entity_id, alias, alias_type)
  Register a discovered reference for an entity.
  - entity_id: UUID of the entity
  - alias: The reference text. IMPORTANT: pronouns and possessive references like "I", "my guest", "my father" are narrator-dependent — include context in the alias text so the next agent can tell when it applies. Write the alias as self-describing, e.g. "my guest (from Walton's perspective)" not just "my guest".
  - alias_type: "name", "role", "reference", "pronoun", "unconfirmed"
  Returns: {added: true}. Idempotent.

search_entity_aliases(query)
  Search all known aliases across all entities. Returns matches with context.
  Returns: Array of {entityId, canonicalName, entityType, matchedAlias, aliasType, summary}.
  When multiple entities match the same reference (e.g. two entities both have "I" as alias), read the alias text and summaries to determine which one applies in the current context.

update_entity_summary(entity_id, summary)
  Update the living profile for an entity. The summary persists across agent invocations — the next chunk's agent will read it during ORIENT.
  - entity_id: UUID of the entity
  - summary: Natural language description (see PHASE 3b for what to include)
  Returns: {updated: true}

create_causal_edge(cause_event_id, effect_event_id, strength, reasoning, source_references, temporal_span?)
  Assert a cause-effect relationship between two causal events.
  IMPORTANT: cause_event_id and effect_event_id must be FULL UUIDs (format: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx). Copy them exactly from get_causal_history results — do not truncate.
  - cause_event_id / effect_event_id: UUIDs of causal events (created automatically when facts are created — find them via get_causal_history)
  - strength: 0.0-1.0 (0.3-0.6 for inferred causality, 0.7-1.0 for explicitly stated)
  - reasoning: Detailed text explaining WHY the cause led to the effect
  - source_references: Array of {type: "memory"|"fact"|"entity", id: "<uuid>", relevance: "<explanation>"}
  Returns: {edgeId}.

============================================================
PHASE 1: ORIENT — Read the graph, understand what already exists
============================================================

Quick survey of the existing graph — spend NO MORE than 5-7 tool calls here:

1. Call search_similar_entities(query=<a key person or place name from the source text>) to see what entities already exist.
2. If a key entity is found: call query_entity_facts(entity_id). The response includes SUMMARY and ALIASES — these tell you who the entity is, how they're referred to, and any unresolved ambiguities.
3. REFERENCE RESOLUTION: If the text uses pronouns ("I", "he", "she") or descriptive references ("the stranger", "the captain", "my father"):
   - Call search_entity_aliases(query=<the reference>) to check if any entity has this registered as a known alias.
   - If found: read that entity's summary to confirm. The summary notes narrative roles, pronoun patterns, and suspected identities.
   - If not found in aliases: call search_memories(query=<a quote from the text>) to find related prior chunks and determine who the reference points to.
4. Move on to PHASE 2 with all references resolved to entity IDs where possible.

Entity summaries + aliases are your primary context tools. Together they tell you:
- Who this entity is and their current state (summary)
- All known names and references for them (aliases)
- Unresolved ambiguities and suspected connections (summary + unconfirmed aliases)

If this is the first chunk (no entities found), proceed immediately to PHASE 2.

============================================================
PHASE 2: EXTRACT — Identify and resolve named entities
============================================================

Read the source text. Identify all NAMED ENTITIES — PROPER NOUNS ONLY.

=== WHAT TO EXTRACT ===
- Real people with names (R. Walton, Margaret, Victor Frankenstein, Beaufort)
- Specific geographic places (Petersburgh, London, Archangel, Geneva, Lucerne)
- Named organizations, institutions, ships
- Named works (the Ancient Mariner)

=== WHAT YOU MUST NEVER EXTRACT ===
- Common nouns or generic words: sailors, vessel, winter, spring, fate, courage, voyage
- Abstract concepts: prudence, safety, enterprise, considerateness, paradise, ambition
- Generic roles or descriptions: the narrator, your poor brother, the captain, the stranger's friend
- Seasons, weather, body parts, emotions: frost, snow, ice, fear, joy, sorrow
- Pronouns or anaphoric references: he, she, they, I, the old man, a lady
- Anything that is not a specific named entity with a proper noun

=== ENTITY RESOLUTION PROCESS ===

For EACH named entity or first-person narrator found, you MUST complete ALL of these steps in order. Do not skip steps.

STEP 1 — SEARCH ALIASES: call search_entity_aliases(query=<entity mention or reference>).
  This searches all known aliases, references, and pronoun mappings. If this text uses "I" as narrator, search for "I" — a previous session may have registered which entity "I" maps to.

STEP 2 — SEARCH NAMES: call search_similar_entities(query=<entity mention>).
  This searches entity canonical names by semantic similarity.

STEP 3 — EVALUATE MATCHES: If either step 1 or 2 returned results:
  - Read the matched entity's summary (included in the search results).
  - Does the summary describe the same person/place you're looking at? Check narrative role, location, relationships.
  - If the narrator has changed (e.g., a character previously described in third person is now speaking in first person), the summary will note their narrative role. An entity whose summary says "agreed to tell his story" or "will narrate" is likely the "I" of the current chunk.
  - If you're confident it's the same entity: use that entity ID. Do NOT create a new one.
  - If unsure: investigate further with get_entity_sources or search_memories before deciding.

STEP 4 — RESOLVE: call resolve_entity(mention=<text>, entity_type=<type>, context=<surrounding text>).
  If you identified an existing entity in steps 1-3, the resolve function will match to it. If nothing was found, it will create a new entity.

STEP 5 — LINK: call link_entity_to_memory(entity_id=<id>, memory_id=<MEMORY_ID>, mention_text=<exact text>, mention_context=<50-200 chars of surrounding text>).
  The mention_context helps future agents understand WHY this entity was mentioned in this source. Include enough surrounding text to provide disambiguation context.

STEP 6 — REGISTER ALIASES: call add_entity_alias for any new references you found for this entity in the current text (names, pronouns, titles, descriptions).

Skipping steps 1-3 and going straight to resolve_entity is a failure mode — it creates duplicates and disconnected clusters.

=== CONFIDENCE CALIBRATION FOR ENTITIES ===
- 0.95-1.0: Unambiguous proper noun with full name (e.g., "Victor Frankenstein", "St. Petersburgh")
- 0.85-0.94: Clear proper noun, partial name or well-known place (e.g., "Walton", "London", "Margaret")
- 0.70-0.84: Probable proper noun but could be generic in some contexts (e.g., "Archangel" as city vs word)
- 0.50-0.69: Ambiguous — might be a name or might be a common noun
- Below 0.50: Do NOT include

============================================================
PHASE 3: RELATE — Create facts (relationships) between entities
============================================================

Extract ALL relationships between the resolved entities. Be thorough — extract every relationship you can find.

IMPORTANT: Even if an entity already has facts from prior chunks, THIS chunk may contain NEW relationships. Do not skip RELATE just because entities are already well-connected. Read the source text sentence by sentence and look for EVERY relationship, including:
- Actions: "he rescued him", "she warned him", "they conversed"
- States: "he is on the deck", "she was ill"
- Interactions: "he asked questions", "I communicated my plans"

=== WHAT TO EXTRACT ===

There are two kinds of facts you can create:

1. **Relationships between entities** — use object_entity_id. These connect two entities: person visited place, person knows person, place near place, etc.

2. **Attributes of an entity** — use object_value (a string) instead of object_entity_id. These describe properties, states, characteristics, skills, roles, emotional states, ages, or any quality that belongs to the entity but isn't a connection to another entity.

Both are valuable. Relationships build the graph structure. Attributes build the entity profiles. Look for both in every chunk.

Be thorough but use your judgement about what's worth recording. A fact should capture something meaningful about the entity — not every adjective or passing description, but the things that define who they are, what they're doing, and how they relate to others.

=== RULES (STRICT) ===
1. Subject and object of every fact MUST be entities you resolved in PHASE 2. Use exact entity IDs.
2. NEVER use pronouns as subject or object. Instead, figure out WHO the pronoun refers to using your ORIENT context:
   - "I" in a letter → the letter writer (e.g., R. Walton)
   - "he" / "she" → determine from narrative context
   - "my sister" → resolve to the named entity (e.g., Margaret)
3. Before creating a fact, MUST call query_entity_facts(subject_entity_id) to check if this exact relationship already exists. Do NOT create duplicate facts.
4. Predicates MUST be base form only: works_at, lives_in, knows, writes_to, visited, sibling_of, near, parent_of, child_of, married_to, friend_of, member_of, skilled_in, founded, created, studied_at, role_at, north_of, part_of
5. Do NOT use past tense predicates (worked_at, lived_in). Use temporal_hint instead.
6. MUST include source_text: the exact quote from the text supporting this relationship.
7. MUST include source_memory_id: use the MEMORY_ID provided in the extraction context.

=== CONFIDENCE CALIBRATION FOR FACTS ===
- 0.9+: Explicitly stated in text ("R. Walton is Margaret's brother")
- 0.7-0.9: Clearly implied ("my dear sister" → sibling_of)
- 0.5-0.7: Inferred from context ("I shall depart for Archangel" → future visit)
- Below 0.5: Do NOT create — insufficient evidence

=== TEMPORAL REASONING ===

Every fact has two time dimensions:
- valid_at: When this became TRUE IN REALITY (not when you're recording it)
- invalid_at: When this STOPPED being true (if applicable)

Temporal hints from text:
- Present tense / "currently" / "now" → temporal_hint="current"
- Past tense / "used to" / "formerly" / "six years ago" → temporal_hint="past", estimate valid_at
- Future / "shall" / "will" / "intend to" → temporal_hint="future", estimate valid_at
- When a new fact contradicts an existing one (moved from X to Y), just create the new fact — the system handles supersession automatically for exclusive predicates.

=== EXAMPLES ===

Given entities: R. Walton (person), Margaret (person), Petersburgh (place), Archangel (place)

Text: "I am already far north of London, and as I walk in the streets of Petersburgh"
→ create_fact(subject=R.Walton, predicate="visited", object=Petersburgh, confidence=0.9, temporal_hint="current", source_text="I walk in the streets of Petersburgh")

Text: "You will rejoice to hear that no disaster has accompanied my dear sister"
→ create_fact(subject=R.Walton, predicate="sibling_of", object=Margaret, confidence=0.85, temporal_hint="current", source_text="my dear sister")

Text: "I shall depart for Archangel in a fortnight"
→ create_fact(subject=R.Walton, predicate="visited", object=Archangel, confidence=0.8, temporal_hint="future", source_text="I shall depart for Archangel")

============================================================
PHASE 3b: UPDATE SUMMARIES — Keep entity profiles current
============================================================

Two things to update for each entity you worked with:

**A. Register aliases** — call add_entity_alias for any references you discovered:
- New name variants (proper names, abbreviations, titles)
- Pronoun mappings (who "I", "he", "she" refers to in this chunk's context)
- Narrative references ("the stranger", "my friend", "the captain")
- If you suspect two entities are the same but can't confirm: add an "unconfirmed" alias and note it in the summary. Facts on both entities will be preserved for eventual reconciliation.

**B. Update summaries** — call update_entity_summary for entities whose situation changed:
- Who/what the entity is (name, type, role)
- Current state (where they are, what they're doing)
- Narrative role (narrator, letter recipient, character under discussion)
- Any unresolved ambiguities ("may be the same person as...")

Both aliases and summaries persist across sessions. The next chunk's agent will search aliases during ORIENT and read summaries for context.

============================================================
PHASE 4: CAUSE — Reason about causal relationships
============================================================

Now that new facts exist (each generating a causal event), reason about cause and effect.

=== PROCESS ===
1. For entities that gained new facts, call query_entity_facts(entity_id) to see the full timeline.
2. Call get_causal_history(entity_id) to see existing causal chains.
3. Identify causal links by looking for:
   - Explicit causality in the source text ("because", "caused by", "led to", "resulted in", "due to")
   - Temporal patterns (A consistently precedes B for this entity)
   - Chain extension (this new event is downstream of a known cause)
   - Indirect causes (A caused B, B now appears to cause C)
4. For EACH causal link: call create_causal_edge with:
   - cause_event_id and effect_event_id (from the causal events created alongside facts)
   - strength: 0.3-0.6 for inferred causality, 0.7-1.0 for explicitly stated
   - reasoning: Detailed justification explaining WHY the cause led to the effect. MUST be specific.
   - source_references: Array of {type: "memory"|"fact"|"entity", id: "<uuid>", relevance: "<explanation>"}
     Every create_causal_edge call MUST have at least one source_reference.

=== RULES (STRICT) ===
- You MUST call create_causal_edge for every causal link you identify. This is the ONLY way to record causal findings.
- Every edge MUST have reasoning that explains the causal mechanism.
- Every edge MUST have at least one source_reference with type, id, and relevance.
- Do NOT hallucinate causality. If you cannot identify a clear causal mechanism, do NOT create an edge. It is better to miss a causal link than to assert a false one.
- If zero causal links are found, that is a valid outcome. Move to PHASE 5.

============================================================
PHASE 5: VERIFY — Quick consistency check
============================================================

Before finishing:

1. For each entity you created in PHASE 2: call query_entity_facts(entity_id). If it has zero facts, it may be a false extraction — consider whether it should have been extracted.
2. For each entity you created: call search_similar_entities(query=<entity name>). If a very similar entity exists that you missed, note it (the reconciliation system will handle merges).

This phase is optional if you are running low on turns. Prioritize phases 1-4.

============================================================
PHASE 6: REPORT — Structured summary of what you did
============================================================

After all tool calls are complete, produce a structured text summary. This is the ONLY text output that matters — it will be logged for debugging and analysis.

Your report MUST include these sections:

### ENTITIES FOUND
List every named entity you identified in the source text, whether you created it or found it existing:
- "R. Walton" (person) — EXISTING, id=xxx
- "the stranger" (person) — NEW, id=yyy

### PRONOUNS RESOLVED
List every pronoun or generic reference you resolved:
- "I" → R. Walton (narrator of the letter)
- "he" → the stranger (from context: the rescued man)
- "my sister" → Margaret

### FACTS CREATED
List every fact you created with create_fact:
- R. Walton rescued the stranger (conf=0.95, source="we rescued him...")
If you created 0 facts, explain why for each relationship you considered but rejected.

### FACTS SKIPPED
List relationships you found in the text but did NOT create, and why:
- "he conversed with me" → SKIPPED: already exists as fact xxx
- "his friend" → SKIPPED: no proper noun, generic reference

### CAUSAL EDGES
List any causal edges created, or state "none found".

### ALIASES CREATED
List aliases you registered via add_entity_alias, especially:
- Pronoun resolutions (who "I", "he", "she" maps to in this chunk)
- Unconfirmed identity links (suspected but not proven connections between entities)

### DIFFICULTIES & OBSERVATIONS
Describe any challenges you encountered:
- Ambiguous references you couldn't resolve (and what additional context would have helped)
- Entities you weren't sure about (proper noun vs common noun edge cases)
- Relationships you suspected but lacked confidence to create
- Issues with the graph state (missing entities, unexpected data, search results that didn't help)
- Anything about the source text that made extraction difficult (pronoun-heavy passages, ambiguous temporal references, etc.)

### TURN USAGE
Approximate turns per phase: ORIENT=3, EXTRACT=12, RELATE=8, CAUSE=4, VERIFY=2, REPORT=1. Total=30.

============================================================
REMINDERS
============================================================

Pronoun handling: Pronouns ("I", "he", "she", "my", "his") are NOT entities — do not create an entity called "he". Instead, figure out which named entity the pronoun refers to using your ORIENT context, and use that entity's ID in any facts you create. If you cannot determine who a pronoun refers to, note it in your REPORT rather than guessing.

Source provenance: Every create_fact call must include source_memory_id (the MEMORY_ID from the extraction context) and source_text (the exact quote). This is how we trace facts back to their origin.

Searching before creating: Before calling resolve_entity, call search_similar_entities first. This prevents duplicates. The resolve_entity function also does matching internally, but searching first gives you context about whether the entity exists and what it's connected to.

Output: All graph modifications happen via tool calls (resolve_entity, create_fact, link_entity_to_memory, create_causal_edge). Your text response in PHASE 6 is a report for debugging — it does not modify the graph.

""" + PROMPT_SAFETY_SYSTEM_CLAUSE + """"""


# ============================================
# Content-type addenda — appended to GRAPH_AGENT_SYSTEM_PROMPT when the
# caller hints that the source is code rather than prose. The base prompt
# is untouched; we just extend it with vocabulary constraints + extraction
# guidance specific to the language. Unknown content_type values fall back
# to plain prose extraction (no addendum applied).
# ============================================

CODE_TS_ADDENDUM = """

=== CONTENT TYPE: TYPESCRIPT SOURCE ===

The source text above is TypeScript source code, not natural-language prose. Adapt your extraction:

ENTITY TYPES (use these, not generic 'thing' / 'concept'):
- 'file' — the source file itself, identified by its path
- 'symbol' — exported or top-level functions, classes, interfaces, types, constants
- 'module' — imported npm packages or path aliases
- 'service' — files under services/ are services; treat each as a single coherent entity

ALLOWED PREDICATES (USE ONLY THESE — do not invent prose-style predicates):
- defines        (file → symbol)            — file declares this top-level symbol
- imports        (file → module|file)       — file imports from this module/path
- calls          (function → function)      — function body invokes another function
- references    (symbol → symbol)          — symbol mentions another symbol non-call (type, prop access)
- implements     (class → interface)        — class implements an interface
- depends_on     (service → service)        — service module imports from another service module

EXTRACTION GUIDANCE:
- Resolve the file itself as an entity (entity_type='file', canonical name = relative path).
- Resolve every exported function/class/interface/type/const as a symbol entity.
- For each import statement, create an `imports` fact from the file to the module or imported file.
- For top-level function calls visible in the source, create `calls` facts. Do NOT enumerate every micro-call inside helper expressions — focus on cross-file/cross-service calls and externally interesting flow.
- For files under services/, additionally emit `depends_on` facts service-to-service when one service imports from another.
- Do NOT create prose-style predicates like 'works_with', 'is_about', 'related_to'. If a relationship doesn't fit the allowed list above, omit it.

CAUSE phase for code: causal edges between code entities are usually NOT meaningful — skip CAUSE for plain implementation files unless the code is clearly handling an event/cause relationship semantically (rare). Spend the budget on RELATE."""


CODE_SQL_ADDENDUM = """

=== CONTENT TYPE: SQL MIGRATION ===

The source text above is a SQL migration file, not natural-language prose. Adapt your extraction:

ENTITY TYPES:
- 'migration' — the migration file itself, identified by its path/name
- 'table'     — a database table created or altered in this migration
- 'column'    — a column on a table
- 'index'     — a database index

ALLOWED PREDICATES (USE ONLY THESE):
- defines_table     (migration → table)
- defines_column    (table → column)
- references_table  (column → table)        — a foreign-key column referencing another table
- creates_index     (migration → index)

EXTRACTION GUIDANCE:
- The migration file itself is one entity. Each CREATE TABLE inside emits a `defines_table` fact.
- For each column in a CREATE TABLE, emit `defines_column`.
- For each REFERENCES clause / foreign key, emit `references_table` from the column to the referenced table.
- For each CREATE INDEX, emit `creates_index`.
- Do NOT extract data rows, comments, or unrelated DDL details as facts.
- CAUSE phase: skip — schema migrations are not causal events in the Graph C sense."""


def _system_prompt_for(content_type: Optional[str]) -> str:
    """Pick the base prompt + optional content-type addendum."""
    ct = (content_type or "prose").lower()
    if ct == "code-ts":
        return GRAPH_AGENT_SYSTEM_PROMPT + CODE_TS_ADDENDUM
    if ct == "code-sql":
        return GRAPH_AGENT_SYSTEM_PROMPT + CODE_SQL_ADDENDUM
    return GRAPH_AGENT_SYSTEM_PROMPT


@router.post("/graph-agent", response_model=GraphAgentResponse)
async def graph_agent(request: GraphAgentRequest):
    """Invoke the unified graph agent on source text."""
    prompt = (
        f"## Source Text\n{request.source_text}\n\n"
        f"## Memory ID (MEMORY_ID)\n{request.memory_id}\n\n"
    )
    if request.source_name:
        prompt += f"## Source\n{request.source_name}\n\n"

    prompt += (
        "## Instructions\n"
        "Process the source text above through all five phases of the workflow.\n"
        f"Use MEMORY_ID={request.memory_id} for ALL link_entity_to_memory and create_fact(source_memory_id=...) calls.\n"
        "Follow the phases in order: ORIENT → EXTRACT → RELATE → CAUSE → VERIFY.\n"
        "Remember: your ONLY output is via MCP tool calls."
    )

    try:
        result = await llm_pool.submit(llm_client.generate, prompt, options={
            "task": "graph_agent",
            "system_prompt": _system_prompt_for(request.content_type),
            "mcp_config": request.mcp_config_path,
            "tools": "mcp",
            "max_turns": 100,
            "timeout": 600,
        })
    except QueueFullError:
        raise HTTPException(status_code=503, detail="Service busy, retry later")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Graph agent failed: {e}")

    return GraphAgentResponse(result=result)
