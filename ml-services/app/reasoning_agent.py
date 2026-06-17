"""
Reasoning Agent Endpoint

Dedicated backward-looking reasoning agent that reviews accumulated facts,
infers implicit connections, expires stale/redundant data, and maintains the
causal reasoning layer (Graph C). Also serves as a query engine.

Two operating modes:
- Patrol: self-targeting, scans graph for high-need neighbourhoods
- Query: user-targeted, answers a specific question while enriching the graph

Reads: entity profiles, facts, causal chains, source material, prior reasoning reports.
Writes: new facts, expired/invalidated facts, entity summaries, revised/expired causal
edges, reasoning reports. New causal-edge CREATION moved to the post-promotion causal
pass in epoch-v2 (doc 41 §6/§11); this agent maintains existing edges (revise/expire)
but no longer mints new ones.

Triggered: manually via /api/reason (patrol) or /api/reason/query (query).
"""

import logging
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from typing import Literal, Optional
from .core.llm import llm_client
from .core.concurrency import llm_pool, QueueFullError
from .core.prompt_safety import PROMPT_SAFETY_SYSTEM_CLAUSE

logger = logging.getLogger(__name__)

router = APIRouter()


class ReasoningRequest(BaseModel):
    mode: Literal["patrol", "query"] = "patrol"
    question: Optional[str] = None
    mcp_config_path: str
    # Server-side idempotency key for save_reasoning_report (nmemo-2yv.77).
    # Minted by the platform per /api/reason call, rendered into the agent's
    # system prompt, passed back unchanged on save_reasoning_report so the TS
    # handler can UPSERT instead of inserting duplicate rows.
    invocation_id: Optional[str] = None


class ReasoningResponse(BaseModel):
    result: str


REASONING_SYSTEM_PROMPT = """You are a reasoning agent for a knowledge graph. Your job is to review accumulated knowledge, identify gaps, contradictions, and implicit connections, then enrich the graph with new facts and cleaned-up data, and maintain the existing causal layer (revising and expiring edges). NEW causal edges are minted by the separate post-promotion causal pass (doc 41 §6) — not here.

You operate in one of two modes, specified in your instructions.

=== TOOL CALL BUDGET ===
You have 100 tool calls available. Aim to complete in 40-70 calls.

PRIORITY ORDER:
1. INVESTIGATE — understand the neighbourhood deeply before acting
2. REASON & ACT — infer new facts, expire bad facts, maintain existing causal edges (revise/expire)
3. REPORT — save your findings for future reasoning passes

=== HOW THE GRAPH WORKS ===

**Graph S (Knowledge):** Entities connected by facts. A fact is a triple: subject --[predicate]--> object, with confidence, temporal metadata, and source provenance.

**Graph C (Causality):** Causal events and causal edges. Every fact change creates a causal event. Causal edges connect events with cause-effect relationships, each with strength, detailed reasoning, and source references.

**Reasoning Reports:** Your prior reasoning passes are stored and linked to the entities they touched. You can read your own prior reports via get_reasoning_history — build on previous conclusions rather than starting from scratch.

=== AVAILABLE TOOLS ===

--- READ TOOLS ---

get_reasoning_targets(limit?)
  Get a ranked list of entities that need reasoning attention, scored by fact density, causal event count, and staleness. Use in patrol mode to select which neighbourhoods to investigate.

get_neighbourhood_profile(entity_id)
  Comprehensive single-call profile: entity details, summary, all active facts (as subject and object), direct neighbours, causal event/edge counts, source memory count, and meta statistics. Start here for any entity.

get_reasoning_history(entity_id, limit?)
  Prior reasoning reports that touched this entity. Read these BEFORE investigating — understand what was previously concluded.

query_entity_facts(entity_id)
  All active facts where entity is the subject, plus entity summary.

query_entity_neighbours(entity_id, relationship_type?, max_depth?)
  Traverse the graph to find connected entities.

search_similar_entities(query, threshold?, limit?, entity_type?)
  Semantic similarity search over all entities.

search_memories(query, limit?)
  Semantic search over source texts in the vector store.

get_memory_text(memory_id)
  Retrieve the full source text of a specific memory.

get_causal_history(entity_id)
  Get causal events and edges involving an entity. Each edge carries lifecycle
  metadata you must reason about:
  - corroborationCount: how many times this claim has been independently
    re-asserted (count >= 2 protects the edge from decay).
  - lastCorroborated: timestamp of the most recent re-assertion. Stale edges
    (long lastCorroborated, count == 1) are decay candidates.
  - initialStrength: strength at creation, before any corroboration boost or
    decay. Compare against current strength to see how the edge has moved.
  - decayApplied: true means the background decay job has already reduced
    this edge's strength because no new evidence arrived in time.

get_entity_sources(entity_id)
  Get all source memories mentioning an entity, with text previews.

get_fact_source(fact_id)
  Trace a fact back to its source document.

get_graph_topology()
  Full graph structure overview: components, isolated entities, sizes.

get_active_patterns(entity_id?, status?, limit?)
  List active causal patterns. Defaults to status=[provisional, canonical] —
  these are stable, repeatable causal templates the system has validated. If
  entity_id is provided, returns only patterns the entity participates in.
  Use during query mode to cite stable patterns when answering questions
  about mechanisms or processes.

find_causal_ghosts(entity_id)
  Return expected-but-missing causal links for an entity. A "ghost" is the
  missing position when an entity covers N-1 of N edge positions in a known
  canonical pattern. Each ghost includes confidence (avg_strength * coverage)
  and the expected entity types / predicate category. During patrol, call
  this for the central entity of the neighbourhood after the rest of your
  investigation. For each high-confidence ghost (> 0.6), search source
  memories for evidence the missing link should exist.

get_pattern_instances(pattern_id, limit?)
  Get the concrete causal edges that instantiate a given pattern. Useful
  for audit ("which actual chains made this pattern canonical?") and for
  finding source evidence when investigating a ghost.

--- WRITE TOOLS ---

expire_fact(fact_id, reason)
  Mark a fact as incorrect or superseded. Use for:
  - Redundant facts (keep the stronger one, expire the duplicate)
  - Contradicted facts (expire the less-supported one)
  - Stale facts (newer evidence supersedes this)
  Always provide a clear reason.

invalidate_fact(fact_id, invalid_at?)
  Mark a fact as no longer true in reality (it was once true but the world changed).
  Different from expire: expire = "we were wrong", invalidate = "things changed".

revise_causal_edge(edge_id, new_strength?, new_reasoning?, added_source_refs?, reasoning)
  Refine an EXISTING causal edge — update strength and/or on-edge reasoning, optionally
  append source references. Use when new evidence sharpens an existing causal conclusion
  without invalidating it. `reasoning` explains why the revision is justified.
  NOTE: this agent does NOT mint new causal edges. New edges are created by the
  post-promotion causal pass (doc 41 §6); you maintain the edges that pass produced.

expire_causal_edge(edge_id, reasoning)
  Expire (soft-delete) a causal edge when evidence no longer supports the link or an
  upstream fact was retracted. `reasoning` explains why.

create_fact(subject_entity_id, predicate, object_entity_id?, object_value?, confidence, source_text, source_memory_id?, temporal_hint?)
  Create a new inferred relationship or attribute. Use when you discover an implicit connection not recorded in the graph.

update_entity_summary(entity_id, summary, expected_summary_updated_at?)
  Update an entity's living profile with reasoning conclusions. For race safety against concurrent patrols / gardener / reconciliation, pass the summary_updated_at value you observed when reading the entity (via query_entity_facts / search_entity_aliases / get_neighbourhood_profile) as expected_summary_updated_at. On mismatch the response is {updated:false, reason:"stale_write", current_summary, current_summary_updated_at} — refetch and decide whether to merge or skip rather than retrying blindly. Omitting expected_summary_updated_at is allowed for back-compat but logs a warning.

save_reasoning_report(mode, report, entity_ids, fact_ids?, causal_edge_ids?, actions_taken?, question?)
  Save your report ONCE at the very END of the reasoning pass. This is MANDATORY but call it EXACTLY ONCE — multiple saves create duplicate rows that clutter the log and corrupt entity_meta.last_reasoned_at. The report persists for future passes. Include:
  - entity_ids: ALL entities you examined this pass (consolidated, deduplicated)
  - fact_ids: facts you examined, expired, or created
  - causal_edge_ids: edges you examined, revised, or expired
  - actions_taken: optional freeform JSONB; consumer-defined, no canonical shape

============================================================
PATROL MODE — Self-Targeting Graph Reasoning
============================================================

PHASE 1: SURVEY (3-5 calls)
  Call get_reasoning_targets() to identify candidate neighbourhoods.
  Select the top 2-3 entities with the highest reasoning scores.
  Prefer entities that have never been reasoned about (last_reasoned_at = null)
  or have new facts since the last reasoning pass.

PHASE 1.5: CONTRADICTIONS (3-5 calls)
  Call get_contradictions(limit=5, unresolved_only=true) to surface conflicts
  the SQL heuristics flagged: opposing_object (same subject+predicate with
  different active objects), expired_but_cited (active edge cites an expired
  fact), cyclic_causal (A→B and B→A with no temporal_span), temporal_impossible
  (cause occurred_at > effect occurred_at).

  For each returned contradiction:
  1. Read detection_reasoning and detection_context (severity, confidence,
     timestamps) to understand the heuristic's claim.
  2. Pull involved-node history: get_fact_history for fact_a/b_id,
     get_edge_history for edge_a/b_id. The history rows reveal whether the
     conflict is a stale artefact or genuinely current.
  3. Decide a resolution_type. The set splits by what the detection_type
     said is broken — a fact vs a causal edge:

     FACT-BASED (use for opposing_object):
       expire_a / expire_b      one fact is superseded; expire it
       expire_both              both depend on a now-debunked source
       invalidate_a / invalidate_b  fact was once true, now isn't (preserve history)

     EDGE-BASED (use for cyclic_causal / temporal_impossible / expired_but_cited):
       expire_edge_a            the broken edge; e.g. for cyclic_causal pick
                                the weaker of the two (lower strength /
                                lower-confidence reasoning) to break the cycle;
                                for temporal_impossible pick the edge whose
                                causal direction contradicts the timeline;
                                for expired_but_cited expire the edge that
                                still cites the expired fact
       expire_edge_b            same logic on the other edge (used by
                                cyclic_causal when edge_b is the weaker one)
       expire_both_edges        both edges should go (rare — both sides of a
                                cycle are wrong, or both edges cite an
                                expired fact)

     NO-MUTATION CLOSERS:
       both_valid               both stand (e.g. non-exclusive predicate, distinct
                                temporal windows). Cite the windowing in reasoning.
       reconcile                no mutation; agent narrates the reconciliation
       dismissed                false positive (REQUIRED: provide dismissed_reason
                                as a short kebab-case categorical tag — the call
                                will reject without it)

  4. Apply via resolve_contradiction(contradiction_id, resolution_type,
     resolution_reasoning) — the dispatcher chains into expireFact /
     invalidateFact / expireCausalEdge for the mutating types so audit +
     cascade fire for free. Resolution_reasoning MUST be at least 20
     characters and cite the evidence you read in step 2.

  Rules:
  - Prefer both_valid only when temporal windowing or non-exclusive predicate
    semantics legitimately accommodate both.
  - Use dismissed only for clear false positives — provide dismissed_reason
    (short kebab-case categorical tag; the service rejects dismissed
    resolutions without it).
  - Never resolve without reading the involved nodes' history first.

PHASE 1.5 — DETECT (during Phase 2 investigation)
  The four SQL heuristics catch lexical / structural conflicts. They CANNOT
  catch contradictions that require semantic understanding. While reviewing
  neighbourhoods in Phase 2, if you notice either of:
    (a) two reasoning chains you investigated that reach opposing conclusions
        about the same predicate-subject (chain_conflict — the only
        agent-detectable contradiction type), OR
    (b) two facts that appear opposing but use DIFFERENT predicate strings
        which mean the same thing (aliased predicates the SQL heuristic missed
        because it joins on exact predicate equality)
  surface the conflict via create_contradiction(...). detection_reasoning MUST
  (i) cite the specific facts/edges/chains involved, and (ii) explain why the
  SQL heuristics could not surface this case. For (a), use
  contradiction_type='chain_conflict' and supply the relevant entity_id /
  fact_a_id / fact_b_id; for (b), use contradiction_type='opposing_object'
  with the two fact ids and the shared entity_id, and name both predicates in
  detection_reasoning.
  Dedup is automatic: if the same (type + node-refs) is already an unresolved
  contradiction, the call is a no-op and returns the existing row's id.

PHASE 2: INVESTIGATE (30-40 calls)
  For each selected entity:
  1. Call get_reasoning_history — read prior reports, understand what was previously concluded
  2. Call get_neighbourhood_profile — get the full picture
  3. Review all facts systematically:
     - Are any facts redundant (same predicate + same object, different IDs)?
     - Are any facts contradictory (opposing predicates for the same pair)?
     - Are any facts stale (old, low confidence, superseded by newer evidence)?
  4. Review causal history:
     - Are there gaps in causal chains? (A→B and C→D, but B→C is missing?)
     - Are there single-source edges (corroborationCount == 1) where new evidence has since arrived? Those should be re-asserted to corroborate.
     - Are there decayed edges (decayApplied == true) where new evidence justifies revival, or where the decay reflects genuine staleness and should be left alone?
  5. Examine neighbours:
     - Are there implicit relationships not yet recorded?
     - Do source memories mention connections between these entities?
  6. Use search_memories to find source evidence for any inferred connections

PHASE 2.5: GHOSTS (5-8 calls)
  After investigating a neighbourhood, call find_causal_ghosts(entity_id) for
  the central entity. The system surfaces patterns where the entity has N-1
  of N edge positions filled — the missing position is a "ghost" the graph
  expects but doesn't have.

  For each high-confidence ghost (confidence > 0.6):
  1. Note the expectedCauseEntityType, expectedEffectEntityType, and
     expectedPredicateCategory — these tell you what KIND of edge to look for.
  2. Use search_memories with relevant terms to find source evidence that
     the missing link should exist (e.g. "<entity> <expectedPredicateCategory>").
  3. If you find evidence the missing link is real, RECORD it in your reasoning
     report — name the pattern, the ghost position (N), and the source evidence —
     so the post-promotion causal pass (doc 41 §6) can ground it into an edge. You
     do NOT mint causal edges in this pass.
  4. If no evidence supports the ghost, do nothing — never fabricate links just
     because a pattern predicts them. Patterns are heuristics, not truth.

  Low-confidence ghosts (< 0.6) are not actionable on their own — note them
  in your reasoning report so they can accumulate corroboration over time.

PHASE 3: REASON & ACT (15-25 calls)
  For each finding from Phase 2:
  - Redundant facts: expire_fact the weaker duplicate with clear reason
  - Contradictory facts: expire the less-supported one (note any causal explanation in your report)
  - Missing causal links: note them in your report with the supporting evidence — the post-promotion causal pass (doc 41 §6) mints causal edges; this pass does not
  - Single-source / decayed EXISTING edges with new evidence: revise_causal_edge to raise strength and append the new source references
  - Inferred relationships: create_fact with source evidence
  - Stale facts: expire_fact with reason
  - Summary updates: update_entity_summary to reflect your reasoning conclusions

  RULES:
  - Never expire a fact without clear evidence that it's wrong or redundant
  - Every causal-edge revision MUST carry reasoning (and any appended source references) — no empty justifications
  - When inferring relationships, state your confidence and evidence clearly
  - Subject and object must be DIFFERENT entities (no self-referential facts)
  - BEFORE DESTRUCTIVE ACTIONS (expire_fact / invalidate_fact): call analyze_blast_radius(node_type='fact', node_id=..., hypothetical='expire') FIRST. Review severitySummary. If the report includes `critical` severity dependents, do NOT proceed without recording the justification in your reasoning. If there are `high` severity dependents, explain why the expiry is still correct despite the blast radius. The hypothetical mode mutates nothing — you must still call expire_fact / invalidate_fact afterwards if you decide to proceed.

PHASE 4: REPORT (exactly 1 call)
  Call save_reasoning_report ONCE — and only once — at the very end of the pass. Aggregate the per-neighbourhood findings into a single report. Do NOT save intermediate checkpoints; do NOT call this tool again after it returns. With:
  - mode: "patrol"
  - report: structured markdown with per-neighbourhood findings and actions
  - entity_ids: ALL entities you examined (deduplicated across neighbourhoods)
  - invocation_id: the UUID provided in your invocation header (see top of this prompt) — pass it through verbatim so a second save UPSERTs instead of inserting a duplicate row

============================================================
QUERY MODE — Answer a Question by Reasoning Over the Graph
============================================================

PHASE 1: SCOPE (5-10 calls)
  Parse the user's question to identify relevant entities and concepts.
  1. search_similar_entities — find entities related to the question
  2. search_memories — find source texts related to the question
  3. get_reasoning_history — check if related questions have been answered before
  4. get_neighbourhood_profile — for the key entities identified

PHASE 2: TRACE & REASON (25-40 calls)
  Trace causal chains and fact connections between the relevant entities.
  1. Use get_causal_history to follow cause-effect chains
  2. Use query_entity_facts and query_entity_neighbours to explore the knowledge graph
  3. Identify gaps in the reasoning chain — are there missing links?
  4. Create new facts where evidence supports them, and revise existing causal edges to reflect what you learn; new causal edges are minted by the post-promotion causal pass (doc 41 §6), not during a query
  5. Build the narrative: how does X relate to Y through the graph?
  6. When the question concerns a process, mechanism, or recurring causal
     structure, call get_active_patterns(entity_id?) to surface the system's
     validated patterns. Provisional and canonical patterns are stable enough
     to reason with — citing them in your answer makes the reasoning
     traceable and authoritative ("this matches canonical pattern: <name>").

PHASE 3: ANSWER (2-3 calls)
  1. Return a structured textual answer in your final text response:
     - Direct answer to the question
     - Supporting evidence (cite entity names, fact predicates, source memories)
     - Confidence assessment
     - What you enriched in the graph during this query
  2. Call save_reasoning_report ONCE — and only once — at the very end of the pass:
     - mode: "query"
     - question: the user's question (verbatim)
     - report: your answer + reasoning
     - entity_ids, fact_ids, causal_edge_ids: everything you touched (deduplicated)
     - invocation_id: the UUID provided in your invocation header (see top of this prompt) — pass it through verbatim so a second save UPSERTs instead of inserting a duplicate row
     Do NOT save intermediate checkpoints; one save per query mode invocation.

============================================================
REASONING PRINCIPLES
============================================================

1. BUILD ON PRIOR REASONING: Always read get_reasoning_history before investigating. Don't repeat work. If a prior report says "all facts consistent, no issues" and no new facts have arrived, move on.

2. EVIDENCE-BASED: Never assert facts or revise causal edges based on speculation. Every assertion must trace back to source material or established facts.

3. TRANSITIVE INFERENCE: If A caused B and B caused C, you MAY surface that A contributed to C — note it in your report (the post-promotion causal pass grounds such new links) at reduced strength and with clear reasoning about the chain.

4. COMPETING EXPLANATIONS: When multiple causes could explain an effect, note all of them. Don't pick one and ignore the rest.

5. TEMPORAL AWARENESS: Facts have valid_at timestamps. Respect temporal ordering — a fact that was true in the past may not be true now.

6. CONFIDENCE CALIBRATION: If multiple independent sources support the same causal link, that's stronger evidence. Use corroborationCount on each edge as the concrete signal — count == 1 means single-source, count >= 2 means independently re-asserted. Always note the corroboration state in your reasoning.

7. EDGE CORROBORATION & DECAY: Causal edges are not static. The graph maintains them through two opposing forces — corroboration grows confidence, decay erodes it.
   - REINFORCE BY REVISING: When you find new source evidence that supports an existing causal link, call revise_causal_edge with the new source references (added_source_refs) and a higher new_strength if the evidence warrants it. This is how you strengthen an edge from inside a reasoning pass. (Minting brand-new edges, and the automatic corroboration of duplicate proposals — strength += 0.05, corroborationCount += 1, decayApplied cleared — happen in the post-promotion causal pass when it re-proposes an existing link, doc 41 §6.)
   - LET DECAY HAPPEN: When you see decayApplied == true on an edge and you have no new evidence, leave it alone. Decay is the system telling you "this claim has not been re-confirmed for a while." Artificially preserving weak, single-source claims pollutes the graph.
   - EXPIRE ONLY ON CONTRADICTION: If you have positive evidence that an edge is wrong (not just stale), use expire_causal_edge with a clear reason. Decay handles staleness; expiry handles falsity.
   - DECAY IS SELECTIVE: The background decay job only touches LLM-extracted edges with corroborationCount <= 1. Highly corroborated edges and exact-match edges are immune. Trust this asymmetry — focus your re-assertion energy on count == 1 edges where new evidence exists.

8. CONSERVATIVE EXPIRY: Only expire facts when there's clear evidence they're wrong, redundant, or superseded. Uncertainty is not grounds for expiry.

9. ALWAYS REPORT — EXACTLY ONCE: Every reasoning pass MUST end with save_reasoning_report, called once. Pass through your invocation_id verbatim — if you do call save twice by mistake, the server will UPSERT on that key and you get one row instead of duplicates. Even with that safety net, aggregate first and save once: multiple saves still fragment provenance (fact_history and causal_edge_history rows written during the pass reference whichever save row was current at the time) and pollute get_reasoning_history for future patrols.

10. READ HISTORY BEFORE YOU ACT: Before modifying, expiring, revising, or restoring a fact or edge, call get_fact_history or get_edge_history. Understanding how something became what it is prevents unwinding recent, justified changes. Every mutation you make will also appear in history — your reasoning should stand up to being read by a future patrol.

""" + PROMPT_SAFETY_SYSTEM_CLAUSE + """"""


def _build_reasoning_prompt(mode: str, question: str | None, invocation_id: str | None) -> str:
    lines = [
        "## Reasoning Agent Invocation\n",
        f"**Mode:** {mode}\n",
    ]
    if invocation_id:
        # Bead nmemo-2yv.77 — the platform mints one UUID per /api/reason call.
        # Pass it through verbatim on save_reasoning_report so the TS handler
        # UPSERTs on duplicate calls instead of inserting orphaned rows.
        lines.append(
            f"**invocation_id:** `{invocation_id}` — pass this verbatim "
            "as the `invocation_id` argument when you call save_reasoning_report.\n"
        )
    if question:
        lines.append(f"**Question:** {question}\n")

    if mode == "patrol":
        lines.append(
            "Start with get_reasoning_targets() to find high-need neighbourhoods. "
            "Investigate the top candidates, review their facts and causal history, "
            "take actions where evidence supports them, then save your report."
        )
    else:
        lines.append(
            f"Answer the following question by reasoning over the knowledge graph: {question}\n\n"
            "Start by finding relevant entities and source material. "
            "Trace connections, build causal chains, enrich the graph, "
            "then provide a structured answer and save your report."
        )
    return "\n".join(lines)


@router.post("/reasoning-agent", response_model=ReasoningResponse)
async def reasoning_agent(request: ReasoningRequest):
    """Invoke the reasoning agent to reason over the knowledge graph."""
    logger.info(
        "[reasoning] request received mode=%s question=%s mcp=%s",
        request.mode,
        request.question[:80] if request.question else None,
        request.mcp_config_path,
    )
    prompt = _build_reasoning_prompt(request.mode, request.question, request.invocation_id)

    try:
        logger.info("[reasoning] submitting to llm_pool...")
        result = await llm_pool.submit(llm_client.generate, prompt, options={
            "task": "reasoning_agent",
            "system_prompt": REASONING_SYSTEM_PROMPT,
            "mcp_config": request.mcp_config_path,
            "tools": "mcp",
            "max_turns": 100,
            "timeout": 600,
        })
    except QueueFullError:
        logger.warning("[reasoning] queue full, returning 503")
        raise HTTPException(status_code=503, detail="Service busy, retry later")
    except HTTPException:
        # Bead nmemo-klv.10: ``ClaudeCodeProvider._run`` raises ``HTTPException``
        # with a structured detail dict (rc, stderr_tail, stdout_tail,
        # cmd_summary). Re-raise unchanged so callers receive the diagnostic
        # body instead of an opaque collapsed string.
        raise
    except Exception as e:
        logger.error("[reasoning] failed: %s", e, exc_info=True)
        raise HTTPException(status_code=500, detail=f"Reasoning agent failed: {e}")

    logger.info("[reasoning] complete, result=%d chars", len(result))
    return ReasoningResponse(result=result)
