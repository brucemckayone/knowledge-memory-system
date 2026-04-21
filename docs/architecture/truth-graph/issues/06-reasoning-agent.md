# Reasoning Agent

**Priority:** High — core reasoning layer
**Complexity:** High
**Branch:** `feat/reasoning-agent`
**Date:** 2026-04-17

---

## Problem

The graph agent extracts entities, facts, and causal edges from source text — it's forward-looking, per-chunk. The gardener maintains topology — merges, identity, islands. Neither agent reasons backward over accumulated knowledge. As the graph grows, facts accumulate on nodes without review, causal connections between disparate areas go unnoticed, redundant or contradictory facts persist, and the reasoning layer (Graph C) stays sparse.

Replaces issue #3 (gardener fact expiry) and subsumes all semantic fact lifecycle decisions.

---

## Solution

A dedicated backward-looking reasoning agent that reviews accumulated facts, infers implicit connections, expires stale/redundant data, and builds the causal reasoning layer. Also serves as a query engine — when a user asks "how does X relate to Y?", it traces the subgraph, builds reasoning chains, and returns a structured answer while permanently enriching the graph.

## Two Operating Modes

### Mode 1: Patrol (Self-Targeting)
- Triggered via viz button ("Reason") or by gardener after detecting high-density areas
- Agent scans graph statistics, identifies high-need neighbourhoods:
  - High fact density (many facts per entity relative to graph average)
  - High causal event density (lots of transitions)
  - High-degree connector nodes (hubs bridging subgraphs)
  - Stale regions (old facts, low corroboration)
- Selects top-N neighbourhoods, does deep pass on each
- Outputs: expired facts, new causal edges, new inferred facts, updated summaries

### Mode 2: Query (User-Targeted)
- Triggered via viz with a user question (text input) and optional entity targets
- Agent traces the relevant subgraph around the question
- Builds/strengthens causal chains connecting the relevant concepts
- Returns a structured textual answer with citations to entities/facts/sources
- Graph enrichment is permanent — reasoning persists for future queries

## Write Scope (Full Access)
- `create_causal_edge` — inferred causal links between events
- `create_fact` — inferred entity relationships not explicit in source text
- `expire_fact` — semantic expiry (redundant, contradictory, superseded)
- `invalidate_fact` — mark facts no longer true in reality
- `update_entity_summary` — update profiles with reasoning context
- All existing read tools for investigation

## Gardener Boundary
- **Gardener**: topology — merges, same-as, islands, structural cleanup. Keeps structural expiry (post-merge side-effects).
- **Reasoning agent**: semantics — fact quality, logical consistency, causal inference, deduplication. Owns all semantic expiry.
- Gardener may trigger reasoning agent when it notices high-density areas during patrol.

---

## Reasoning Reports (Provenance & Continuity)

Each reasoning pass produces a **report** stored in the database and linked to the entities/facts it touched. This gives the agent memory across invocations — it reads its own prior reasoning about a neighbourhood before starting a new pass.

### Schema: `reasoning_reports` table
- `id` (UUID), `mode` ('patrol' | 'query'), `question` (TEXT, nullable)
- `report` (TEXT) — structured markdown: findings, actions, confidence
- `entity_ids` (UUID[]), `fact_ids` (UUID[]), `causal_edge_ids` (UUID[]) — linked graph objects
- `actions_taken` (JSONB) — structured log
- `created_at` (TIMESTAMPTZ)

### How it's used
- **Patrol PHASE 1**: `get_reasoning_targets` includes `last_reasoned_at` in scoring. Neighbourhoods with recent reports and no new facts get deprioritised.
- **Any mode PHASE 2**: Agent reads prior reports before investigating — builds on previous conclusions.
- **Query mode**: Prior query reports on overlapping entities are surfaced.
- **Cross-invocation learning**: If the agent expired a fact and a new ingestion recreated it, the report trail shows the conflict.

---

## New Tools

| Tool | Type | Purpose |
|------|------|---------|
| `expire_fact` | write | Expose existing `expireFact()` — semantic expiry with reason |
| `invalidate_fact` | write | Expose existing `invalidateFact()` — fact no longer true |
| `get_neighbourhood_profile` | read | Composite: entity + facts + neighbours + causal history + meta in one call |
| `get_reasoning_targets` | read | Ranked entities by reasoning need (fact density, staleness, etc.) |
| `get_reasoning_history` | read | Prior reasoning reports for an entity |
| `save_reasoning_report` | write | Persist report with linked entity/fact/edge IDs |

---

## Agent Phases

### Patrol Mode (4 phases)

**PHASE 1: SURVEY** (3-5 calls) — `get_reasoning_targets`, select top 2-3

**PHASE 2: INVESTIGATE** (30-40 calls) — For each neighbourhood: `get_reasoning_history` + `get_neighbourhood_profile`, review facts for redundancy/contradiction/staleness, review causal gaps, examine neighbours

**PHASE 3: REASON & ACT** (15-25 calls) — Expire redundant/contradictory facts, create causal edges, infer relationships, update summaries

**PHASE 4: REPORT** (1-2 calls) — `save_reasoning_report` with structured findings + all touched IDs

### Query Mode (3 phases)

**PHASE 1: SCOPE** (5-10 calls) — Find relevant entities/sources, read prior reports

**PHASE 2: TRACE & REASON** (25-40 calls) — Trace causal chains, fill gaps, enrich graph

**PHASE 3: ANSWER** (2-3 calls) — Structured textual answer + `save_reasoning_report`

---

## Future Use Cases

1. **Transitive inference**: A→B and B→C infers A→C at reduced strength
2. **Competing explanations**: Weight multiple potential causes
3. **Pattern detection**: Recurring cause-effect sequences (uses `causal_patterns` table)
4. **Temporal reasoning**: Ordering constraints as causal evidence
5. **Cross-domain connection**: Bridge semantically similar but disconnected subgraphs
6. **Confidence calibration**: Strengthen edges corroborated by multiple sources
7. **Anomaly flagging**: Flag contradictions with established causal chains

---

## Files

### New
| File | Purpose |
|------|---------|
| `ml-services/app/reasoning_agent.py` | Agent endpoint + system prompt |
| `src/db/migrations/008_reasoning_reports.sql` | Table + indexes |

### Modified
| File | Change |
|------|--------|
| `src/services/causal-agent.ts` | 6 new tool schemas + handlers + `invokeReasoningAgent()` |
| `src/db/schema.ts` | `reasoning_reports` table + `last_reasoned_at` on entity_meta |
| `src/index.ts` | `POST /api/reason` + `POST /api/reason/query` |
| `ml-services/app/main.py` | Register reasoning agent router |
| `ml-services/app/core/llm.py` | Add `reasoning_agent` to TASK_DEFAULTS |
| `viz/index.html` | Reason button + query input + answer panel |
| `viz/js/app.js` | Handlers for patrol, query, answer display |
