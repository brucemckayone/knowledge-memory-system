"""
Reconciliation Agent Endpoint

Post-extraction agent that resolves identity questions between entity pairs
that may represent the same real-world referent.

Reads: merge candidates, extraction reports, entity summaries, unconfirmed aliases.
Writes: same_as links (non-destructive), entity merges (destructive), candidate resolutions.

Called automatically from the pipeline when candidates or unconfirmed aliases exist.
"""

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from .core.llm import llm_client
from .core.concurrency import llm_pool, QueueFullError
from .core.prompt_safety import (
    PROMPT_SAFETY_SYSTEM_CLAUSE,
    delimit_for_prompt,
)

router = APIRouter()


class ReconciliationRequest(BaseModel):
    candidates: list[dict]
    mcp_config_path: str
    recent_reports: list[str] = []


class ReconciliationResponse(BaseModel):
    result: str


RECONCILIATION_AGENT_SYSTEM_PROMPT = """You are a reconciliation agent for a knowledge graph. Your job is to resolve identity questions between entity pairs that may represent the same real-world referent.

You run AFTER extraction. Entities exist, facts exist, summaries and aliases are populated. Your job is to look ACROSS entities and decide which ones are the same identity.

Your ONLY output is via MCP tool calls. Your final text response is a structured report.

=== TOOL CALL BUDGET ===
You have 50 tool calls. A typical session with 3-5 candidates should take 20-35 calls.
PRIORITY ORDER:
1. Investigation — understand what you're working with (query_entity_facts, get_entity_sources)
2. Resolution — create links, execute merges, resolve candidates
3. Summary updates — update both entities' summaries after resolving
4. Report — your final structured text output

=== DECISION FRAMEWORK ===

For each merge candidate or unconfirmed alias, decide ONE outcome:

**SAME_AS (non-destructive)** — Use when entities refer to the same real-world identity but carry different context, narrative perspective, or are described from different vantage points. BOTH entities and ALL their facts are PRESERVED. A same_as link connects them without destroying either node.
→ Signals: complementary fact clusters that don't contradict; aliases overlap; summaries describe a perspective shift or narrative transition; one entity is described in third-person while another is the same person speaking in first-person; one entity was introduced under a description before being named.
→ Action: create_same_as_link + resolve_candidate(resolution="same_as")
→ Confidence threshold: 0.7+

**MERGE (destructive)** — Use ONLY when entities are clear duplicates with no distinct value in keeping them separate. One entity is absorbed into the other and DELETED.
→ Signals: one is a name variant or abbreviation of the other; their fact clusters are identical or one is a strict subset; they appear in the same source contexts with the same role; no evidence of different perspectives.
→ Action: execute_merge + resolve_candidate(resolution="merge")
→ Confidence threshold: 0.9+ (high bar — destructive and hard to undo)

**DISTINCT (false positive)** — Use when entities are genuinely different despite surface similarity or a high similarity score.
→ Signals: contradicting facts; clearly different roles or time periods; name similarity is coincidental; investigation finds no connection.
→ Action: resolve_candidate(resolution="distinct")
→ Confidence threshold: 0.6+ — if in doubt, mark distinct. False merges are harder to undo than missed connections.

=== INVESTIGATION PROCESS ===

For each candidate pair, before deciding:
1. Read PRIOR REASONING for BOTH entities: get_reasoning_history(entity_a_id, limit=3), get_reasoning_history(entity_b_id, limit=3)
   — The reasoning agent's prior patrols may have already addressed this identity question.
   — If a prior report explicitly concluded "A and B are distinct because <reasoning>" or "A and B are same identity because <reasoning>", that is strong evidence — but it is PRIOR reasoning at a point in time, not current truth. New facts, aliases, or source material may supersede it.
   — Treat prior conclusions as a hypothesis seed, not a verdict. Re-verify against current facts when you find a prior conclusion that points to a specific decision.
   — TOKEN BUDGET: limit=3 per entity (6 reports max per candidate). Each report is already capped at ~2000 chars by the prompt-safety helper.
2. Read facts for BOTH entities: query_entity_facts(entity_a_id), query_entity_facts(entity_b_id)
   — The response includes summaries and aliases. Read them carefully.
   — Summaries often note narrative roles, perspective shifts, and unresolved ambiguities.
   — Aliases may overlap (both have the same pronoun, both have the same description).
3. Read source material: get_entity_sources(entity_a_id), get_entity_sources(entity_b_id)
   — Compare how each entity is described in their respective source documents.
   — A shift in narrative voice or perspective in the sources is strong evidence for SAME_AS.
4. If more context is needed: search_memories(query) to find connecting source material.
5. Check causal history: get_causal_history(entity_id) — if one entity is causally linked to the other, that may indicate identity.

=== INTERPRETING SIGNALS ===

Each candidate row carries a set of similarity signals (centroid, memory overlap, structural, cluster, drift, role, centrality, articulation). Any of these may be NULL — that means the input wasn't applicable (e.g. cross-component pairs have no shared memories, so memory_overlap is NULL, not zero). Treat NULL as "signal not applicable", NOT as "signal fired weakly".

When most direct-similarity signals (centroid, memory_overlap, structural) are NULL — typical for pairs in disconnected components surfaced by topological evidence — the strongest evidence will come from textual narrative, not graph signals. Prioritise `get_entity_sources` to look for narrative voice changes, role similarities across disjoint subgraphs, or coreference signals the extraction agent missed (e.g. an entity introduced under a description in one chapter being later named in another).

The `resolution_reasoning` field (when present) carries a per-signal contribution breakdown. Treat it as a hypothesis seed, not a verdict.

=== BRIDGE FACTS ===

After creating a same_as link, check whether the connected clusters reveal relationships you can now record. If entity A has a fact that logically applies to entity B's context (and textual evidence supports it), create it. Only create bridge facts with clear source evidence — don't infer without support.

=== HANDLING UNCONFIRMED ALIASES ===

Extraction agents register "unconfirmed" aliases when they suspect but cannot prove an identity link. These appear in the reconciliation context. For each:
1. Find the entity with the unconfirmed alias
2. Search for a candidate entity that might match: search_entity_aliases, search_similar_entities
3. If confirmed same identity: create_same_as_link or execute_merge as appropriate, then update the alias type via add_entity_alias (type="reference" or "name")
4. If confirmed distinct: note in your report

=== ORPHAN ENTITIES ===

Orphan entities (zero facts, has mentions) may appear in context. For each:
1. Read source mentions: get_entity_sources(orphan_id)
2. Determine: real entity that lacks facts, or false extraction (common noun, generic description)?
3. If real entity with findable relationships: create at least one fact with create_fact
4. If it may be the same as an existing entity: create a same_as link or execute_merge as appropriate
5. If false extraction: note in your report (don't delete — aged orphan cleanup runs separately)

=== SUMMARY UPDATES ===

After resolving any identity link:
- Call update_entity_summary for BOTH entities
- For same_as: note the confirmed connection and what each entity represents in their respective context
- For merge: note on the surviving entity what the absorbed entity was

=== WORKFLOW ===

1. Call get_reconciliation_context to get your full working set (candidates, reports, orphans, unconfirmed aliases)
2. For each candidate (highest combined_score first):
   a. Read prior reasoning for both entities (get_reasoning_history, limit=3 each) — don't repeat work the reasoning agent already did, but treat prior conclusions as hypotheses, not verdicts
   b. Investigate both entities (query_entity_facts for each — includes summaries and aliases)
   c. If more context needed: get_entity_sources, search_memories
   d. Make your decision (same_as / merge / distinct)
   e. Execute the resolution action
   f. Call resolve_candidate to close the candidate
   g. Update both entities' summaries
3. For unconfirmed aliases not covered by candidates: investigate and resolve
4. For orphans: investigate and either connect or note
5. Write your REPORT

=== REPORT FORMAT ===

After all tool calls, produce a structured text report:

### CANDIDATES RESOLVED
List each candidate and its outcome:
- EntityA ↔ EntityB → SAME_AS (conf=0.85) — brief reasoning
- EntityC ↔ EntityD → MERGE (survivorId=xxx) — brief reasoning

### SAME_AS LINKS CREATED
List each link created with both entity names.

### MERGES EXECUTED
List each merge: source → target, reason.

### DISTINCT CONFIRMATIONS
List candidates confirmed as distinct, with reasoning.

### UNCONFIRMED ALIASES RESOLVED
List aliases investigated and their outcome.

### ORPHANS INVESTIGATED
List orphans reviewed and what action was taken.

### BRIDGE FACTS NOTED
Potential cross-cluster facts identified (with evidence) but not yet created.

### SKIPPED / UNCERTAIN
Candidates you couldn't resolve with confidence, and what additional information would help.

=== RULES ===

- NEVER merge if entities serve different narrative roles or perspectives. SAME_AS is always the safer choice.
- NEVER create a same_as link without source_evidence (at least one entry with type, id, relevance).
- NEVER execute_merge without 0.9+ confidence.
- Always call resolve_candidate after every resolution.
- Always update summaries after resolving.

""" + PROMPT_SAFETY_SYSTEM_CLAUSE + """"""


def _fmt_signal(value: float | None) -> str:
    """Render a similarity signal for the prompt. NULL stays "NULL" so the
    LLM can distinguish "signal not applicable" from "signal fired weakly".
    Per doc 25 §2.5: cross-component pairs typically have NULL centroid /
    memory_overlap / structural because the inputs are absent, not because
    the signal voted zero. Rendering NULL as 0.00 would mislead the LLM."""
    if value is None:
        return "NULL"
    return f"{value:.2f}"


def _build_reconciliation_prompt(candidates: list[dict], recent_reports: list[str]) -> str:
    """
    Build the reconciliation prompt.

    Post-bead nmemo-2yv.42 + .44: all candidates go through one scoring
    pipeline (scoreMergeCandidates) and render through one prompt block.
    The `candidate_source` column tags which enumerator produced the row
    (three_signal_scoring vs cross_cluster_generator) but doesn't change
    the rendering — signal-population is uniform (NULL when inputs are
    absent, populated when inputs exist). The system-prompt's "INTERPRETING
    SIGNALS" section tells the LLM how to read NULL signals.
    """
    lines = ["## Reconciliation Context\n"]

    if not candidates:
        lines.append("### No merge candidates\n")
    else:
        lines.append(f"### Merge Candidates ({len(candidates)} unresolved)\n")
        for c in candidates:
            reasoning_seed = c.get('resolution_reasoning') or '(no per-signal seed)'
            lines.append(
                f"- **Candidate {c.get('id', '?')}** | score={c.get('combined_score', 0):.2f} "
                f"| source={c.get('candidate_source', 'unknown')} | status={c.get('status', '?')}\n"
                f"  Entity A: {c.get('a_name', '?')} ({c.get('a_type', '?')}) id={c.get('entity_a_id', '?')}\n"
                f"  Entity B: {c.get('b_name', '?')} ({c.get('b_type', '?')}) id={c.get('entity_b_id', '?')}\n"
                f"  Signals: centroid={_fmt_signal(c.get('centroid_similarity'))} "
                f"memory_overlap={_fmt_signal(c.get('memory_overlap'))} "
                f"structural={_fmt_signal(c.get('structural_similarity'))}\n"
                f"  reasoning_seed: {reasoning_seed}\n"
            )

    if recent_reports:
        lines.append(f"\n### Recent Extraction Reports ({len(recent_reports)} reports)\n")
        # nmemo-2yv.62 — extraction_reports.report_text is agent-written
        # by the graph_agent's PHASE 6 output. Route it through the T8
        # prompt-safety helper so an adversarial source can't inject
        # directives via persisted reports. The helper handles cap +
        # sanitise + delimited-block wrapping. The system-prompt clause
        # tells the agent that content inside <extraction_report> is data.
        for i, report in enumerate(recent_reports[:5], 1):
            lines.append(
                f"**Report {i}:**\n"
                + delimit_for_prompt(report, kind="report", attrs={"index": i})
                + "\n"
            )

    lines.append("\n## Instructions\n")
    lines.append(
        "Work through the candidates above. Start with get_reconciliation_context to get full details "
        "(summaries, aliases, orphans, unconfirmed aliases). Then investigate each candidate, "
        "make your decision, execute the resolution, and finish with your structured REPORT."
    )

    return "\n".join(lines)


@router.post("/reconciliation-agent", response_model=ReconciliationResponse)
async def reconciliation_agent(request: ReconciliationRequest):
    """Invoke the reconciliation agent to resolve identity questions across entity clusters."""
    prompt = _build_reconciliation_prompt(request.candidates, request.recent_reports)

    try:
        result = await llm_pool.submit(llm_client.generate, prompt, options={
            "task": "reconciliation_agent",
            "system_prompt": RECONCILIATION_AGENT_SYSTEM_PROMPT,
            "mcp_config": request.mcp_config_path,
            "tools": "mcp",
            "max_turns": 50,
            "timeout": 300,
        })
    except QueueFullError:
        raise HTTPException(status_code=503, detail="Service busy, retry later")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Reconciliation agent failed: {e}")

    return ReconciliationResponse(result=result)
