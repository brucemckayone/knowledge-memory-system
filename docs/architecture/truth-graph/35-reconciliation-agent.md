# Reconciliation Agent

**Status:** canonical, 2026-05-26 (bead `nmemo-2yv.70`).
**Theme:** T1/T7 (feature fragmentation) cure — consolidates `RECONCILIATION_AGENT_REVIEW.md` (repo root, 2026-04-16, since deleted) plus the post-fixes state introduced by beads `.60`, `.61`, `.62` (open), `.66` (open), `.83`, `.124`, `.130`.
**Owning code:**

- `ml-services/app/reconciliation_agent.py` — LLM agent definition + FastAPI endpoints
- `platform/src/services/causal-agent.ts` — `invokeReconciliationAgent` + `invokeReconciliationDriftAgent` HTTP clients
- `platform/src/pipeline.ts` — `maybeTriggerReconciliation` auto-trigger
- `platform/src/index.ts` — `POST /api/reconcile` manual handler + `triggerReconciliationDriftAfterCompute`
- `platform/src/db/migrations/005_reconciliation.sql` — `same_as_links`, `extraction_reports`, fixed `merge_entities()`
- `platform/src/db/migrations/016_entity_drift.sql` — `entity_drift_events` + `triggered_action`/`reconciliation_run_id` columns
- `platform/src/db/migrations/018_resolution_enum_align.sql` — `merge_candidates.resolution` enum alignment (bead `.60`)
- `platform/src/db/migrations/021_drift_reconciliation_retry.sql` — retry budget for the drift path (bead `.83`)

---

## 1. Purpose

The reconciliation agent is a post-extraction identity-resolution agent. It runs AFTER the graph agent has written entities and facts, looks ACROSS those entities, and decides whether two candidate-pair entities represent the same real-world referent. Three terminal verdicts per pair: `same_as` (non-destructive link), `merge` (destructive absorption), `distinct` (false positive).

It is one of two graph-maintenance agents (the other is the gardener — doc 36). The split:

- **Reconciliation** responds to a scored list. The 3-signal scoring system in `detectMergeCandidates()` and the cross-cluster generator (`platform/src/services/cross-cluster-generator.ts`) produce rows in `merge_candidates`. The reconciliation agent walks that list.
- **Gardener** does not respect a candidate list. It explores graph topology itself (see doc 36).

## 2. Trigger surfaces

Three trigger surfaces today. All three converge on `ml-services/app/reconciliation_agent.py` via different platform-side helpers.

### 2.1 Auto-trigger inside the ingest pipeline (bead `.61`)

`platform/src/pipeline.ts` ends `extract()` with a call to `maybeTriggerReconciliation()`. The body lives in the same file (exported for tests):

```ts
// pipeline.ts, simplified
export async function maybeTriggerReconciliation(
  invokerOverride?: ReconciliationAgentInvoker,
): Promise<ExtractResult['reconciliation']> {
  const sinceLast = Date.now() - lastReconciliationRunAt;
  if (sinceLast < RECONCILIATION_MIN_INTERVAL_MS) {
    return { triggered: false, skippedReason: 'cooldown ...' };
  }
  const [candidateRows, unconfirmedRows] = await Promise.all([
    db.select(...).from(mergeCandidates)
      .where(inArray(mergeCandidates.status, ['staging', 'candidate'])).limit(1),
    db.select(...).from(entityAliases)
      .where(eq(entityAliases.aliasType, 'unconfirmed')).limit(1),
  ]);
  if (candidateRows.length === 0 && unconfirmedRows.length === 0) {
    return { triggered: false, skippedReason: 'no_pending_work' };
  }
  lastReconciliationRunAt = Date.now();   // reserve cooldown BEFORE the LLM call
  const result = await invoker({ candidates: unresolved, recentReports });
  return { triggered: true, candidateCount: unresolved.length, report: result.result };
}
```

Properties:

- **Cooldown.** `RECONCILIATION_MIN_INTERVAL_MS` (default 5 minutes, process-local). Reset on restart. The cooldown slot is reserved BEFORE the long-running LLM call so a tight ingest loop in the same process doesn't double-fire while the previous agent is still in flight.
- **Status gate.** Auto-fires on EITHER `'staging'` or `'candidate'` rows — broader than the manual `/api/reconcile` handler (which only fires on `'candidate'`). `detectMergeCandidates` inserts `'staging'` for below-threshold pairs and `'candidate'` for above; the auto-trigger wants both to get the agent's attention.
- **Fire-and-forget shape.** The call is `await`-ed only to populate `ExtractResult.reconciliation` telemetry. The agent invocation is wrapped in try/catch + log + continue; a failed LLM call never propagates to the pipeline caller. Status returned via the `skippedReason` field (`'cooldown'`, `'no_pending_work'`, `'error'`).
- **Doc 32 row.** As of 2026-05-26 doc 32 §2 still lists `reconciliation_agent` as "MANUAL ONLY — see nmemo-2yv.61"; that row is stale and gets corrected by the next doc-32 sweep.

### 2.2 Drift-driven trigger (bead `.83`)

`platform/src/index.ts:triggerReconciliationDriftAfterCompute()` fires after every `POST /api/drift/compute`. It selects pending `entity_drift_events` rows (`triggered_action='reconciliation_invoked' AND reconciliation_run_id IS NULL AND reconciliation_attempt_count < MAX_RECONCILIATION_ATTEMPTS`) and invokes the drift sibling endpoint `/reconciliation-agent/drift` per row.

Properties:

- **Per-event retry budget.** `MAX_RECONCILIATION_ATTEMPTS` cap (default 3) per drift event. Permanent classes (HTTP 400 / 404 from the agent) short-circuit immediately to `reconciliation_failed`; transient classes (timeouts, 5xx, network) bump `reconciliation_attempt_count` and re-select next cycle.
- **Selection is decoupled from the current call.** The query picks up rows just inserted by this `/api/drift/compute` AND any stragglers from previous cycles that failed transiently. Robust against process crashes between compute and reconciliation.
- **Success writes a `reasoning_reports` row** (with `actions_taken.source = 'reconciliation_drift_agent'`) and stamps `reconciliation_run_id` on the drift event. Failure increments the attempt counter and (if at the cap) sets the row's status to `reconciliation_failed`.
- **Fire-and-forget.** Called via `void triggerReconciliationDriftAfterCompute()` from the route handler after the response goes out. Per-row try/catch so one poison row doesn't abort the batch.

### 2.3 Manual trigger (`POST /api/reconcile`)

`platform/src/index.ts` exposes `POST /api/reconcile` for ad-hoc developer/debugger use (Rule 3 surface per doc 34). It only fires on rows with `status='candidate'` (the auto-trigger is broader — see §2.1). Same invoker downstream, same `same_as_links` + `merge_candidates.resolution` writes.

Per doc 34 Rule 1, this is the user-facing surface; per Rule 2, the auto-trigger in §2.1 is the production cadence. Both coexist (doc 34 §4.3 — manual + automatic are answers to different questions).

## 3. Inputs (data the agent sees)

The agent's prompt is assembled by `_build_reconciliation_prompt()` in `reconciliation_agent.py`. The platform-side caller (`maybeTriggerReconciliation` or `/api/reconcile`) collects:

### 3.1 Merge candidates

Per `getMergeCandidates()` (`src/services/graph-meta.ts`):

```ts
[
  {
    id, entity_a_id, entity_b_id,
    a_name, a_type, b_name, b_type,
    centroid_similarity, memory_overlap, structural_similarity,
    combined_score, status, detection_count,
    first_detected_at, last_detected_at,
    candidate_source,           // 'three_signal_scoring' | 'cross_cluster_generator'
    resolution_reasoning,       // populated by cross_cluster_generator only
  },
  ...
]
```

The agent's prompt renders these in two blocks (per `_build_reconciliation_prompt`):

- **3-Signal Candidates** — the default block. Renders centroid/memory_overlap/structural columns numerically.
- **Cross-Cluster Candidates** — for `candidate_source = 'cross_cluster_generator'` rows. The 3-signal columns are NULL by design (the cross-cluster generator uses topology + drift signals, not direct similarity); rendering them as 0.00 would mislead the LLM. The system prompt's "CROSS-CLUSTER CANDIDATES" section explains how to investigate this class (prioritise reading both entities' source memories — strongest evidence is textual, not graph signals).

### 3.2 Recent extraction reports

Last 10 rows from `extraction_reports` (table created in `005_reconciliation.sql`). These are the PHASE 6 reports the graph agent produced during its own extraction sessions — they carry hints about pronoun ambiguities, unconfirmed aliases, and entities introduced under descriptions before being named. The agent reads these for cross-entity context.

Each report is char-truncated to 2000 in the prompt. **T8 prompt-injection note:** the report text is wrapped in a triple-backtick code fence but is otherwise pasted verbatim. `extraction_reports.report_text` is agent-writable (the graph agent produces it), which creates a write-then-read T8 surface. Tracked by bead `.62` (open) — fix is a centralised `prompt_safety` helper in ml-services that protects both `entity_meta.summary` and `extraction_reports.report_text`.

### 3.3 Drift payload (drift-trigger path only)

For `/reconciliation-agent/drift`, the payload is a single-entity drift event instead of a candidate list:

```python
class ReconciliationDriftRequest(BaseModel):
    entity_id: str
    drift_magnitude: float
    centroid_snapshot: list[float]
    centroid_current: list[float]
    source_cluster_id: int | None
    target_cluster_id: int | None
```

The drift-trigger system prompt (`RECONCILIATION_DRIFT_SYSTEM_PROMPT`) is a separate, focused single-entity-patrol prompt — it does NOT use the candidate-list system prompt. The agent investigates whether the drifted entity's identity has shifted (e.g. previously-same-as-X but now different) or whether the drift indicates a new cluster assignment.

## 4. Decision framework

The system prompt locks the agent to three terminal verdicts per pair. Confidence thresholds are designed to make false merges worse than missed connections.

### 4.1 SAME_AS (non-destructive)

When entities represent the same real-world identity but each carries distinct narrative perspective, fact cluster, or vantage point worth preserving.

**Signals:** complementary fact clusters that don't contradict; alias overlap; summaries describe a perspective shift; one entity described in third-person, the other is the same person in first-person; one entity introduced under a description before being named.

**Confidence threshold:** 0.7+

**Actions:**

1. `create_same_as_link({ entity_a_id, entity_b_id, reasoning, source_evidence, confidence })` — writes to `same_as_links`. `source_evidence` is `JSONB NOT NULL` (an array of `{type, id, relevance}` objects). Schema requires both `reasoning` and `source_evidence`.
2. `resolve_candidate({ candidate_id, resolution: 'same_as', reasoning })` — closes the `merge_candidates` row. **Bead `.60` enum alignment** — before .60, the TS handler passed `'same_as'` but the DB CHECK constraint expected `'aliased'`, silently rejecting the close; migration 018 + the centralised enum (`platform/src/services/enums.ts`, bead `.130`) made the value coherent across layers.
3. `update_entity_summary` on both entities — note the confirmed connection.

**Result:** both entities preserved with all facts intact, identity link recorded, merge candidate marked resolved.

### 4.2 MERGE (destructive)

When entities are clear duplicates with no distinct value in keeping both separate. One entity is absorbed and DELETED.

**Signals:** name variants (typo, abbreviation, capitalisation); identical fact clusters or one is a strict subset; same source contexts with the same role; no narrative-perspective distinction.

**Confidence threshold:** 0.9+ (high bar — destructive and hard to undo).

**Action:** `execute_merge({ source_entity_id, target_entity_id, reasoning })` — calls the `merge_entities()` SQL function (`005_reconciliation.sql` §3). The function re-points facts, aliases, memory_entities, entity_merges, causal_events, same_as_links, then deletes the source. Audit row lands in `entity_merges`.

Then `resolve_candidate({ resolution: 'merge', reasoning })` and `update_entity_summary` for the survivor.

**Result:** source entity deleted, all data re-pointed to target, single canonical entity survives, merge audited.

**Danger:** irreversible. That's why the threshold is 0.9+ and the system prompt forbids fallback (a merge constraint error must be reported, never converted to same_as).

### 4.3 DISTINCT (false positive)

When entities are genuinely different despite the candidate score.

**Signals:** contradicting facts; clearly different roles or time periods; name similarity is coincidental; investigation finds no connection.

**Confidence threshold:** 0.6+ — if in doubt, mark distinct. False merges are harder to undo than missed connections.

**Action:** `resolve_candidate({ resolution: 'distinct', reasoning })`. No data modification.

## 5. Tool roster

The agent runs against the unified `GRAPH_TOOLS` MCP server (doc 30 §2). 15 tools accessible to the reconciliation agent:

| Category | Tools |
|---|---|
| Query | `query_entity_facts`, `query_entity_neighbours`, `search_similar_entities`, `search_memories`, `get_memory_text`, `get_causal_history`, `get_fact_source` |
| Extraction | `resolve_entity`, `create_fact`, `get_entity_sources`, `link_entity_to_memory`, `add_entity_alias` |
| Reconciliation | `create_same_as_link`, `execute_merge`, `resolve_candidate`, `search_entity_aliases`, `get_reconciliation_context` |

Tool budget: **50 calls per session**. Typical 3-5 candidate sessions use 20-35:

| Phase | Calls | Example |
|---|---|---|
| Investigation | 12-15 | 2-3 `query_entity_facts` per candidate + sources |
| Resolution | 6-10 | `create_same_as_link` + `execute_merge` + `resolve_candidate` |
| Summary updates | 4-6 | `update_entity_summary` for each resolved entity |
| Edge cases | 5-10 | unconfirmed aliases, orphans, bridge facts |
| Report | 2-3 | Final structured text response |
| Total | 20-35 | Well within 50-call budget |

Timeout: **300 seconds** (5 minutes) per LLM session. Concurrency: shared `llm_pool` with the graph agent (`ml-services/app/core/concurrency.py`); queue-full returns HTTP 503.

## 6. Investigation workflow

The system prompt commits the agent to a fixed investigation order before deciding:

1. `get_reconciliation_context()` — pull the working set (candidates, recent reports, orphans, unconfirmed aliases).
2. For each candidate (highest combined_score first):
   1. `query_entity_facts(entity_a_id)` and `query_entity_facts(entity_b_id)` — read facts, summaries, aliases for both.
   2. `get_entity_sources(entity_a_id)` and `get_entity_sources(entity_b_id)` — read the source material they came from.
   3. (Optional) `search_memories(query)` to find connecting evidence; `get_causal_history(entity_id)` if causal links matter.
   4. Decide: same_as / merge / distinct.
   5. Execute the resolution action.
   6. `resolve_candidate` to close.
   7. `update_entity_summary` on both entities.
3. For unconfirmed aliases not covered by candidates: investigate and resolve.
4. For orphans: investigate and either connect or note.
5. Write the structured REPORT.

## 7. Special cases

### 7.1 Unconfirmed aliases

Extraction agents register `alias_type='unconfirmed'` when they suspect an identity link but can't prove it. The reconciliation agent:

1. Finds the entity carrying the unconfirmed alias.
2. `search_entity_aliases(alias_text)` and `search_similar_entities` to find potential matches.
3. If confirmed same identity: `create_same_as_link` or `execute_merge`, then update the alias type to `'reference'` or `'name'` via `add_entity_alias`.
4. If confirmed distinct: note in the report.

### 7.2 Orphan entities

Zero-fact entities (false extractions or isolated mentions):

1. `get_entity_sources(orphan_id)` — where was it mentioned?
2. Decide: real entity that lacks facts (add at least one fact), or false extraction (note — don't delete; aged-orphan cleanup is a separate concern).
3. If suspected duplicate: `create_same_as_link` or `execute_merge` as appropriate.

### 7.3 Cross-cluster candidates

Candidates with `candidate_source='cross_cluster_generator'` (see doc 25). The 3-signal columns are NULL by design — those signals don't apply to entities in disconnected components. The agent prioritises:

1. Reading both entities' source memories (`get_entity_sources`) — strongest evidence is textual narrative, not graph signals.
2. Looking for narrative voice changes, role similarities across disjoint subgraphs, or coreference signals the extraction agent missed.
3. Treating the `resolution_reasoning` field (per-signal contribution breakdown) as a hypothesis seed, not a verdict.

### 7.4 Bridge facts

After creating a same_as link, the agent checks whether the newly-connected fact clusters reveal recordable relationships. Only with clear source evidence — never infer without support.

## 8. Reasoning and source-evidence requirements

Every same_as link has `reasoning TEXT NOT NULL` and `source_evidence JSONB NOT NULL` (default `'[]'`). The system prompt forbids creating a link without at least one entry in `source_evidence` of the form `{type: 'memory'|'fact'|'entity'|'alias'|'report', id: UUID, relevance: text}`. Same provenance discipline as causal edges (per doc 03 §3 and the position-paper non-negotiable).

`merge_candidates.resolution` is the centralised enum (bead `.130`) — `'merge' | 'aliased' | 'same_as' | 'distinct' | 'pending'`. Migration 018 (.60) aligned the TS handler with the DB CHECK constraint; the previous mismatch (TS passed `'same_as'`, DB accepted only `'aliased'`) silently dropped same_as resolutions on the floor.

## 9. Attribution

`same_as_links.created_by` defaults to `'reconciliation_agent'` (`005_reconciliation.sql:38`). The shared `create_same_as_link` tool handler at `causal-agent.ts` currently hardcodes this value, which misattributes gardener-created links. Tracked by bead `.66` (open) — fix is to accept `created_by` as a tool parameter (or derive from the calling agent's MCP server identity) so gardener-created same_as links are attributed correctly.

## 10. Error handling and resilience

### 10.1 Pipeline auto-trigger (catch-and-swallow)

Per `maybeTriggerReconciliation` (§2.1). Any failure in the agent invocation or pre-flight queries returns `{ triggered: false, skippedReason: 'error' }` — the pipeline-caller never blocks on a failed reconciliation.

| Failure mode | Visible signal | Pipeline impact |
|---|---|---|
| Cooldown not elapsed | `skippedReason='cooldown ...'` | None — ingest proceeds normally |
| No pending work | `skippedReason='no_pending_work'` | None |
| Agent timeout (300s) | `skippedReason='error'` + warn log | None — ingest succeeds |
| ML service 503 (queue full) | `skippedReason='error'` + warn log | None |
| Any other exception | `skippedReason='error'` + warn log | None |

### 10.2 Drift trigger (per-event retry with permanent classification)

Per `triggerReconciliationDriftAfterCompute` (§2.2). Per-event try/catch isolates poison rows. The retry budget (`MAX_RECONCILIATION_ATTEMPTS`, default 3) drains transients before marking permanent failure (`triggered_action='reconciliation_failed'`).

Permanent classes (immediate fail without retry):

- HTTP 400 (bad payload) — schema mismatch between platform and ml-services
- HTTP 404 (entity not found) — the entity may have been merged/deleted between drift detection and reconciliation

Transient classes (retry until budget exhausted):

- HTTP 5xx
- Network errors (ECONNREFUSED, timeout)
- Empty-string result with status=200 (LLM exhausted `max_turns` without emitting text)

### 10.3 Manual `/api/reconcile`

Errors propagate to the HTTP response — a manual caller (operator, viz button) sees them. No catch-and-swallow; the caller knows the outcome.

## 11. Report format

The system prompt locks the agent's final text response to a structured Markdown report. The platform-side caller logs the first 500 chars (auto-trigger) or returns the full report in the JSON response (manual). No structured parsing — the report is for human/audit consumption.

```markdown
### CANDIDATES RESOLVED
- EntityA ↔ EntityB → SAME_AS (conf=0.85) — brief reasoning
- EntityC ↔ EntityD → MERGE (survivor=xxx) — brief reasoning

### SAME_AS LINKS CREATED
- Robert Walton ↔ R. Walton (conf=0.92)

### MERGES EXECUTED
- Walton, Robert → Robert Walton (source absorbed)

### DISTINCT CONFIRMATIONS
- Frankenstein, Victor (different era, no overlap)

### UNCONFIRMED ALIASES RESOLVED
- "the captain" → confirmed as Robert Walton

### ORPHANS INVESTIGATED
- Unknown character: insufficient evidence to connect

### BRIDGE FACTS NOTED
- Potential: Victor knows Walton (supported by causal trace in report 3)

### SKIPPED / UNCERTAIN
- Candidate MC-5: insufficient extraction reports; would need more context
```

## 12. Observability and audit

| What | Stored where | Notes |
|---|---|---|
| Same-as link reasoning | `same_as_links.reasoning` (TEXT NOT NULL) | Non-negotiable per `005_reconciliation.sql` |
| Same-as link source evidence | `same_as_links.source_evidence` (JSONB NOT NULL) | Array of `{type, id, relevance}` |
| Merge audit | `entity_merges` table | One row per merge — source/target/reason/method/score |
| Candidate resolution | `merge_candidates.status` + `merge_candidates.resolution` | Status: `candidate`/`staging` → `resolved`; resolution: `merge`/`aliased`/`same_as`/`distinct`/`pending` |
| Auto-trigger telemetry | `ExtractResult.reconciliation` (ingest response) | `{ triggered, candidateCount?, report?, skippedReason? }` |
| Drift-trigger audit | `reasoning_reports` (mode='patrol', actions_taken.source='reconciliation_drift_agent') | Per-event report; `reconciliation_run_id` stamped on drift event |
| Drift retry state | `entity_drift_events.reconciliation_attempt_count` + `triggered_action` | `reconciliation_invoked` → `reconciliation_failed` after MAX_ATTEMPTS |

What's missing (known gaps, not blockers):

- `reconciliation_runs` audit table for the candidate-list path (doc 32 §2 references it but it doesn't exist) — telemetry currently lives only on `ExtractResult.reconciliation` and in console logs.
- Per-decision metrics (% same_as vs merge vs distinct) — extractable from `merge_candidates.resolution` + `same_as_links.created_at` but not aggregated anywhere.

## 13. Cross-references

### 13.1 Beads (closed, locked the current state)

- `nmemo-2yv.60` — `resolve_candidate` enum / `merge_candidates.resolution` CHECK alignment.
- `nmemo-2yv.61` — pipeline-level auto-trigger with cooldown gate (§2.1).
- `nmemo-2yv.83` — `triggerReconciliationDriftAfterCompute` wiring + retry budget (§2.2 + §10.2).
- `nmemo-2yv.124` — deleted `causal-mcp.ts`; reconciliation agent now exclusively uses the unified `graph-mcp.ts` MCP server.
- `nmemo-2yv.130` — centralised enum module (`platform/src/services/enums.ts`).

### 13.2 Beads (open, gaps in the current state)

- `nmemo-2yv.62` — T8 centralised prompt-safety helper for `entity_meta.summary` and `extraction_reports.report_text` (§3.2).
- `nmemo-2yv.66` — `create_same_as_link` `createdBy` hardcoded; misattributes gardener-created links (§9).
- `nmemo-2yv.67` — gardener auto-trigger does not persist to `gardening_reports`; symmetric audit gap (see doc 36 §10).

### 13.3 Related architecture docs

- `06-graph-meta-layer.md` — defines `merge_candidates` and the 3-signal scoring this agent consumes. The "Future: Reconciliation Agent (Phase 2)" section is stale — this doc is the canonical entry point.
- `25-cross-cluster-generator.md` — produces `candidate_source='cross_cluster_generator'` rows the agent consumes (§3.1 + §7.3).
- `30-mcp-transport.md` — the MCP-vs-Pi-bridge transport contract this agent runs over.
- `32-compute-trigger-registry.md` §2 — the doc-32 row for `reconciliation_agent` (currently shows "MANUAL ONLY", stale — auto-trigger has shipped via .61; correction is a separate doc-32 sweep).
- `34-architectural-principles.md` — Rule 1 lists `/api/reconcile` as a user-facing surface; Rule 2 makes the pipeline auto-trigger the production cadence.
- `36-gardener-agent.md` — the sibling maintenance agent.
