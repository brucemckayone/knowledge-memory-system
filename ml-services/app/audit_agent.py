"""
Cross-corpus Audit Agent Endpoint (nmemo-uhp.12.3, spec 04 §6)

User-triggered, MCP-driven cross-corpus audit. Invoked BY the audit pass
(platform audit-pass.ts), once per recalled (element, rule) cell. The pass has
already recalled the candidate pair deterministically (aligned entity embeddings,
the .14 lever); this endpoint pushes the pair to the agent, which decides whether
the SOURCE element violates | satisfies | is not_applicable to the TARGET rule.

The agent's ONLY effect on the graph is propose_bridge_edge — it stages a bridge
into staging_bridge_edges (partitioned by MNEMO_INVOCATION_ID on the MCP config
env); deterministic bridge-promotion (platform) then disposes it. It never writes
canonical, and its actor is env-pinned ('audit_agent') so its tool surface is
reads + propose_bridge_edge only.

Mirrors the /causal-agent section of causal_agent.py (E6). Haiku-first.
"""

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from .core.llm import llm_client
from .core.concurrency import llm_pool, QueueFullError
from .core.prompt_safety import PROMPT_SAFETY_SYSTEM_CLAUSE

router = APIRouter()


class AuditAgentRequest(BaseModel):
    scope: dict
    mcp_config_path: str


class AuditAgentResponse(BaseModel):
    result: str


AUDIT_AGENT_SYSTEM_PROMPT = """You are the cross-corpus audit agent for a knowledge graph.

Two corpora live side by side and never fuse: a SOURCE corpus (e.g. a codebase) and a TARGET corpus (e.g. a coding standard / rulebook). Your job is to decide, for ONE candidate pair the pass hands you, whether the source element VIOLATES, SATISFIES, or is NOT_APPLICABLE to the target rule — and, when there is a real relation, to lay down one explained, sourced bridge between them.

Your ONLY effect on the graph is propose_bridge_edge. You CANNOT create facts, merge entities, or write canonical bridges directly — deterministic bridge-promotion disposes your proposal (it validates the endpoints, drops unresolved ones, dedups, and handles cited-fact status). You propose; promotion disposes.

=== WHAT TO DO ===
You are pushed ONE candidate pair: a source ELEMENT and a target RULE the pass recalled as semantically close. Adjudicate exactly this pair:
- If the element clearly BREACHES the rule → relation = "violates".
- If the element clearly CONFORMS to the rule in a way worth recording as evidence → relation = "satisfies".
- If the rule does not actually apply to this element, or the two are unrelated once you look closely → relation = "not_applicable": propose NOTHING and say so in your report. The pass records the coverage cell as checked; do not fabricate a bridge to look thorough.

For a "violates" or "satisfies" verdict, call propose_bridge_edge exactly once:
- aKind = "entity", aRef = the SOURCE element id (given below).
- bKind = "entity", bRef = the TARGET rule id (given below).
- sourceCorpusId / targetCorpusId = the ids given below (do not swap them).
- relation = "violates" | "satisfies".
- reasoning: a concrete, non-empty explanation of WHY — grounded in what the element actually does and what the rule actually requires, not in surface name similarity.
- source_references: a NON-EMPTY array of {type: "entity"|"fact"|"memory", id, relevance}. At minimum cite the two entity ids; strengthen it with the facts / memories you read. Non-negotiable — every bridge must be traceable.

=== INVESTIGATION ===
The pair is the start, not the limit. Confirm the real behaviour before you judge:
- query_entity_facts on the element id and the rule id — what does each actually assert?
- search_memories / get_memory_text / get_fact_source — pull the source text behind the element and the rule wording behind the rule; these become your source_references.
- search_similar_entities (pass corpus_id to stay inside one corpus) — gather neighbouring context when the pair alone is thin.
Name similarity is a hint, never proof. A memcpy call and a "no unbounded copy" rule can look close and still be not_applicable if the call is bounded.

=== RULES ===
- Judge THIS pair only. Do not propose bridges to other rules you happen to recall — the pass sweeps those as their own cells.
- Propose ONLY for a genuine relation. When unsure, choose not_applicable and propose nothing.
- Never invent entity ids; use the ids given or ones your read tools confirm.
- Every proposal needs non-empty reasoning AND at least one source reference, or it is rejected.
- You have no canonical-write tool by design — do not look for one.

=== REPORT ===
After your decision, a short structured report:

### VERDICT
- violates | satisfies | not_applicable — one line on why.

### BRIDGE PROPOSED
- element -> rule (relation) — reasoning (grounded in [sources]); or "none (not_applicable)".

### EVIDENCE
- the facts / memories you read and what they showed.

""" + PROMPT_SAFETY_SYSTEM_CLAUSE + """"""


def _fmt_side(label: str, side: dict, corpus_id: str) -> str:
    """Render one endpoint (element or rule) as a labelled block."""
    desc = side.get("description")
    out = (
        f"### {label} (corpus `{corpus_id}`)\n"
        f"  - id: {side.get('ref')}\n"
        f"  - name: {side.get('name')}\n"
        f"  - type: {side.get('type')}\n"
    )
    if desc:
        out += f"  - description: {desc}\n"
    return out


def _build_audit_prompt(scope: dict) -> str:
    """Render one recalled (element, rule) pair into the audit agent's working prompt.

    The scope is built by the audit pass (audit-pass.ts) from canonical entities in the
    two corpora. Source-derived strings (names, descriptions) are rendered plainly; the
    prompt-safety system clause tells the agent that scope content is DATA, not instructions.
    """
    element = scope.get("element", {}) or {}
    rule = scope.get("rule", {}) or {}
    source_corpus = scope.get("sourceCorpusId", "")
    target_corpus = scope.get("targetCorpusId", "")
    similarity = scope.get("similarity")

    lines = [
        "## Candidate pair to adjudicate\n\n",
        "The pass recalled this SOURCE element and TARGET rule as semantically close "
        f"(cosine similarity {similarity}). Decide whether the element violates, satisfies, "
        "or is not_applicable to the rule.\n\n",
        _fmt_side("SOURCE element", element, source_corpus),
        "\n",
        _fmt_side("TARGET rule", rule, target_corpus),
        "\n## Instructions\n",
        "Investigate both sides with your read tools (facts, source text), then decide. "
        "For violates/satisfies call propose_bridge_edge once with aKind/bKind=\"entity\", "
        f"aRef={element.get('ref')}, bRef={rule.get('ref')}, "
        f"sourceCorpusId={source_corpus}, targetCorpusId={target_corpus}, concrete reasoning, "
        "and at least one source reference. For not_applicable, propose nothing. "
        "Finish with your REPORT.",
    ]
    return "".join(lines)


@router.post("/audit-agent", response_model=AuditAgentResponse)
async def audit_agent(request: AuditAgentRequest):
    """Adjudicate one recalled cross-corpus (element, rule) pair (nmemo-uhp.12.3)."""
    prompt = _build_audit_prompt(request.scope)

    try:
        result = await llm_pool.submit(llm_client.generate, prompt, options={
            "task": "audit_agent",
            "system_prompt": AUDIT_AGENT_SYSTEM_PROMPT,
            "mcp_config": request.mcp_config_path,
            "tools": "mcp",
            "max_turns": 30,
            "timeout": 300,
        })
    except QueueFullError:
        raise HTTPException(status_code=503, detail="Service busy, retry later")
    except HTTPException:
        # Preserve the structured ClaudeCodeProvider diagnostic body (bead nmemo-klv.10).
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Audit agent failed: {e}")

    return AuditAgentResponse(result=result)
