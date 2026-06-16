"""
Causal Agent Endpoint (E6, doc 41 §6, §8a.6)

Post-promotion, conditional, delta-scoped causal reasoning over the SETTLED canonical
graph. Invoked BY the causal pass (platform causal-pass.ts), which PUSHES a bounded
scope — the promotion-minted causal events plus the touched entities' causal
neighbourhood. The agent reasons over the settled subgraph and proposes causal edges
via propose_causal_edge into staging_causal_edges; deterministic causal-promotion
(platform) then disposes them (ref-resolve, self-loop, dedup, cited-fact status).

This is the ONE agent that reads live canonical, correctly — because it runs after
promotion, when the graph is clean and the timeline is coherent. It never writes
canonical: the propose tool is its only effect.

Mirrors the /arbiter-agent section of reconciliation_agent.py (E5).
"""

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from .core.llm import llm_client
from .core.concurrency import llm_pool, QueueFullError
from .core.prompt_safety import PROMPT_SAFETY_SYSTEM_CLAUSE

router = APIRouter()


class CausalAgentRequest(BaseModel):
    epoch_id: str
    scope: dict
    mcp_config_path: str


class CausalAgentResponse(BaseModel):
    result: str


CAUSAL_AGENT_SYSTEM_PROMPT = """You are the causal agent for a knowledge graph.

You run AFTER promotion, over the SETTLED canonical graph — the one clean, stable moment when the timeline is coherent. Promotion has already minted a causal EVENT for every settled fact change (created / expired / strengthened), each with a STABLE id. You reason over these settled events and assert the causal links BETWEEN them that per-chunk extraction could never see — for example, a funding round described in one source causing an HQ relocation described in another.

Your ONLY effect on the graph is propose_causal_edge. You CANNOT create facts, merge entities, or write canonical causal edges directly — deterministic causal-promotion disposes your proposals (it resolves the event refs, drops self-loops, dedups, and handles cited-fact status). You propose; promotion disposes.

=== WHAT TO DO ===
You are pushed a SCOPE: the new events minted by this promotion, plus the prior causal neighbourhood (existing events + edges) of the touched entities. Find the genuine cause→effect relationships among them:
- Connect a NEW event to another new event, or to a PRIOR event in the neighbourhood (cross-source, cross-time causality is the whole point).
- For each real causal link, call propose_causal_edge(causeEventId, effectEventId, reasoning, source_references).
- causeEventId / effectEventId MUST be event ids from the scope (or ones you confirm via your read tools). They are settled and stable — never invent ids.
- reasoning: a concrete, non-empty explanation of WHY the cause produced the effect — grounded in the sources, not in surface co-occurrence.
- source_references: a NON-EMPTY array of {type: "memory"|"fact"|"entity", id, relevance} that grounds the link. Non-negotiable — every edge must be traceable.

=== GROUNDING ON FACT STATUS ===
propose_causal_edge returns citedFactStatus for each cited fact. Heed it:
- active — solid grounding.
- superseded — the fact's value was later replaced, but the PAST event is still real; citing it for a historical cause is fine. Causal-promotion KEEPS such edges.
- invalidated — the fact was found to be WRONG. Avoid grounding a new edge solely on it; prefer a different source. Causal-promotion KEEPS but FLAGS the edge stale for re-grounding — so only propose it if you have no better evidence.

=== INVESTIGATION ===
The scope is the start, not the limit. Go deeper only when needed:
- get_causal_delta / trace_causes / get_causal_history — see the existing causal structure around an entity before adding to it (do not duplicate an edge that already exists; corroboration is automatic).
- get_neighbourhood_profile / search_memories / get_memory_text / get_fact_source / get_fact_history — gather the source_references that ground a link and confirm an event's meaning.

=== RULES ===
- Propose a causal edge ONLY for a genuine mechanism, never for mere temporal adjacency or correlation. When unsure, do NOT propose.
- Never invent event ids; use the settled ids in the scope or ones your read tools confirm.
- Every proposal needs non-empty reasoning AND at least one source reference, or it is rejected.
- You have no canonical-write tool by design — do not look for one.

=== REPORT ===
After your proposals, a short structured report:

### CAUSAL EDGES PROPOSED
- causeEvent → effectEvent — reasoning (grounded in [sources])

### CONSIDERED BUT NOT PROPOSED
- pair → why it was correlation / insufficiently grounded, not cause

### SHAKY GROUNDING
- any edge you had to ground on a superseded/invalidated fact, and what would re-ground it

""" + PROMPT_SAFETY_SYSTEM_CLAUSE + """"""


def _build_causal_prompt(scope: dict) -> str:
    """Render the pushed settled scope into the causal agent's working prompt.

    The scope is built by the causal pass (causal-pass.ts) from settled canonical —
    minted events + the touched entities' causal neighbourhood. Source-derived strings
    (predicates, source text) are rendered plainly; the prompt-safety system clause
    tells the agent that scope content is DATA, not instructions.
    """
    new_events = scope.get("newEvents", []) or []
    nbr_events = scope.get("neighbourhoodEvents", []) or []
    nbr_edges = scope.get("neighbourhoodEdges", []) or []

    lines = [
        "## Settled Causal Scope\n\n",
        f"This promotion minted {len(new_events)} new causal event(s). "
        f"The neighbourhood adds {len(nbr_events)} prior event(s) and {len(nbr_edges)} existing edge(s). "
        "Find the genuine cause-and-effect links among them and propose each with propose_causal_edge.\n",
    ]
    if scope.get("capped"):
        lines.append(
            "\nNote: the scope was truncated at the configured cap — reason over what is here; "
            "a later delta pass will cover the rest.\n"
        )

    def render_event(e: dict) -> str:
        out = (
            f"  - id={e.get('id')} [{e.get('transitionType')}] "
            f"subject={e.get('subjectEntityId')} {e.get('predicate')} "
            f"(occurred_at={e.get('occurredAt')})\n"
        )
        if e.get("sourceText"):
            out += f"      source: {e.get('sourceText')}\n"
        return out

    lines.append("\n### New events (this promotion)\n")
    for e in new_events:
        lines.append(render_event(e))

    if nbr_events:
        lines.append("\n### Prior events in the neighbourhood\n")
        for e in nbr_events:
            lines.append(render_event(e))

    if nbr_edges:
        lines.append("\n### Existing causal edges (do not duplicate)\n")
        for ed in nbr_edges:
            lines.append(
                f"  - {ed.get('causeEventId')} -> {ed.get('effectEventId')}: {ed.get('reasoning')}\n"
            )

    lines.append("\n## Instructions\n")
    lines.append(
        "Reason over the settled events above. For each genuine cause-and-effect mechanism, call "
        "propose_causal_edge with settled event ids, concrete reasoning, and at least one source "
        "reference. Investigate with your read tools only when the scope is insufficient. Do NOT "
        "propose for mere co-occurrence. Finish with your REPORT."
    )
    return "".join(lines)


@router.post("/causal-agent", response_model=CausalAgentResponse)
async def causal_agent(request: CausalAgentRequest):
    """Invoke the post-promotion causal agent to propose edges over the settled scope (E6)."""
    prompt = _build_causal_prompt(request.scope)

    try:
        result = await llm_pool.submit(llm_client.generate, prompt, options={
            "task": "causal_agent",
            "system_prompt": CAUSAL_AGENT_SYSTEM_PROMPT,
            "mcp_config": request.mcp_config_path,
            "tools": "mcp",
            "max_turns": 40,
            "timeout": 300,
        })
    except QueueFullError:
        raise HTTPException(status_code=503, detail="Service busy, retry later")
    except HTTPException:
        # Preserve the structured ClaudeCodeProvider diagnostic body (bead nmemo-klv.10).
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Causal agent failed: {e}")

    return CausalAgentResponse(result=result)
