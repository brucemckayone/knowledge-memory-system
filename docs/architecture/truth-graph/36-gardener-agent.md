# Gardener Agent

**Status:** canonical, 2026-05-26 (bead `nmemo-2yv.70`).
**Theme:** T1/T7 (feature fragmentation) cure — consolidates the fact-expiry issue doc (`issues/03-gardener-fact-expiry.md`), the merge-vs-same-as quality issue doc (`issues/05-merge-same-as-quality.md`), and the post-fixes state introduced by beads `.66` (open), `.67` (open).
**Owning code:**

- `ml-services/app/gardener_agent.py` — LLM agent definition + FastAPI endpoint
- `platform/src/services/causal-agent.ts` — `invokeGardenerAgent` HTTP client
- `platform/src/pipeline.ts` — `GARDENER_RUN_INTERVAL` auto-trigger (every 5 graph-agent runs)
- `platform/src/index.ts` — `POST /api/garden` manual handler + audit insert
- `platform/src/db/migrations/006_gardening.sql` — `gardening_reports` table
- `platform/src/db/schema.ts` — `gardeningReports` Drizzle binding

---

## 1. Purpose

The gardener is a graph-maintenance agent that operates without a candidate list. It explores graph topology by itself, finds islands, name variants, orphans, and missed connections, and acts on them. Counterpart to the reconciliation agent (doc 35):

- **Reconciliation agent** responds to a scored list (`merge_candidates`, `entity_aliases` with `alias_type='unconfirmed'`, drift events).
- **Gardener** explores the topology — uses `get_graph_topology()` first and decides for itself what to investigate.

The gardener is the broader of the two — it can call all the same write tools as the reconciliation agent (`create_same_as_link`, `execute_merge`, `resolve_candidate`), plus the extraction tools (`create_fact`, `update_entity_summary`, `add_entity_alias`). What distinguishes it is the entry point: a topology-first exploration vs. a candidate-first walk.

## 2. Trigger surfaces

Two trigger surfaces. Both converge on `ml-services/app/gardener_agent.py:/gardener-agent` via the `invokeGardenerAgent` TS client.

### 2.1 Auto-trigger inside the ingest pipeline (every N graph-agent runs)

`platform/src/pipeline.ts` increments a process-local `graphAgentRunCount` after each `extract()` succeeds and triggers the gardener when the counter hits `GARDENER_RUN_INTERVAL` (default 5):

```ts
// pipeline.ts, simplified
graphAgentRunCount++;
if (graphAgentRunCount >= GARDENER_RUN_INTERVAL) {
  const tGarden = Date.now();
  const runsSince = graphAgentRunCount;
  graphAgentRunCount = 0;   // reset before async call
  try {
    const gardenResult = await invokeGardenerAgent({
      trigger: 'auto',
      graphAgentRunsSinceLast: runsSince,
    });
    gardenerResult = { triggered: true, report: gardenResult.result };
  } catch (err) {
    gardenerResult = { triggered: false };
  }
  timing.gardener = Date.now() - tGarden;
}
```

Properties:

- **Threshold-driven counter.** Process-local; resets on restart. Per doc 34 §3.4 this is the "borderline Rule 2" case — anchored on `graph_agent` runs (which DO touch the state the gardener cares about, so the anchor isn't wildly wrong) but the counter is `let`-scoped rather than DB-stored. Acceptable as MVP; the long-term Rule 2 shape is a `*_since_last_run` row the gardener itself consults.
- **Fire-and-forget shape.** The call is `await`-ed only to populate `ExtractResult.gardener` telemetry. Try/catch around the invocation; failure logs and continues. The pipeline never blocks.
- **Trigger discriminator.** The agent receives `trigger: 'auto'` and `graph_agent_runs_since_last` so its session report can note the trigger context.
- **Audit gap.** The auto-trigger path **does not insert into `gardening_reports`** today. The `gardenerResult` lives only in the pipeline's return payload. Tracked by bead `.67` (open) — fix is a shared `recordGardeningRun` helper called from both the auto path and the manual `/api/garden` handler. Until that lands, `gardening_reports.trigger_type='auto'` is dead-on-write.

### 2.2 Manual trigger (`POST /api/garden`)

`platform/src/index.ts` exposes `POST /api/garden` for ad-hoc developer/debugger use (Rule 3 surface per doc 34). The manual path **does** insert into `gardening_reports` after the agent returns:

```ts
// index.ts, simplified
const result = await invokeGardenerAgent({ trigger: 'manual' });
db.insert(gardeningReports).values({
  triggerType: 'manual',
  reportText: result.result || '(no report)',
  durationMs,
}).catch(err => { /* log + continue */ });
```

The insert is fire-and-forget — a failed audit write doesn't bubble up to the HTTP response. Manual responses include the full report text in JSON. Per doc 34 Rule 1, `/api/garden` is the user-facing surface; per Rule 2, the pipeline counter in §2.1 is the production cadence. Both coexist (doc 34 §4.3).

## 3. Inputs (what the agent sees)

The agent's prompt is minimal — just the trigger context (`trigger`, `runs_since_last`) and an instruction to start with `get_graph_topology()`. There is no candidate list; the agent's job is to discover state itself.

```python
# gardener_agent.py:_build_gardener_prompt
lines = ["## Gardening Session\n"]
lines.append(f"**Trigger:** {trigger}")
if runs_since_last > 0:
    lines.append(f"**Graph agent runs since last gardening:** {runs_since_last}\n")
lines.append(
    "\n## Instructions\n"
    "Start with get_graph_topology() to understand the graph structure. "
    "Then investigate islands, name variants, and orphans. "
    "Take consolidation actions where evidence supports them. "
    "Finish with your structured REPORT."
)
```

The system prompt does the heavy lifting (see §4–§6).

## 4. Four-phase workflow (locked by system prompt)

The system prompt structures every session as four phases. The agent must spend tool budget proportionally.

### 4.1 Phase 1 — MAP

Spend 5-10 calls understanding the landscape. `get_graph_topology()` returns:

- Connected components (groups of entities linked by facts)
- Per-component: entity names, types, fact counts
- Isolated entities (no incident facts)
- Component sizes
- A `sparseLeaves` section identifying entities with 1-2 connections dangling off a hub

Priorities in order:

1. **Sparse leaves** (HIGHEST). 1-2 edges off a hub = missing cross-links. The topology output flags these explicitly. A MISRA rule connected only to `AUTOSARC++14` probably also references HIC++, JSF, or C++ Core Guidelines.
2. **Islands.** Small disconnected components. Almost everything connects to something — investigate.
3. **Orphans.** Entities with zero facts.
4. **Name variants.** Abbreviations, typos, "the X" vs "X" — same-name candidates that look like they should be merged but weren't.

The agent also reviews existing `same_as_links` for any that connect entities with identical or near-identical names — those should have been merges per §6, and the gardener cleans them up.

### 4.2 Phase 2 — INVESTIGATE

Majority of the tool budget. Per priority area:

**Islands.** For each entity in the island: `query_entity_facts(entity_id)` (facts + summary + aliases) and `get_entity_sources(entity_id)` (source material). Then search for connections: `search_similar_entities(query=<entity_name>)`, `search_entity_aliases(query=<alias>)`, `search_memories(query=<key_phrase>)`. If a match is found, investigate BOTH sides before acting.

**Name variants and duplicates.** Look for abbreviations, typos, partial names, description-vs-name patterns. For each suspected pair: query facts, summaries, sources for both — do they contradict? complement? clearly the same?

**Sparse leaves (highest-value).** For each sparse leaf:

1. Identify what hub it connects to (e.g., `Rule M5-0-17` → only connects to `AUTOSARC++14`).
2. Determine what ELSE it should connect to based on its name and domain knowledge: rules starting with "M" originated from MISRA C++:2008; rules starting with "A" are AUTOSAR-specific; rules in the same numbering range are siblings.
3. `search_memories` for source text mentioning the rule — often lists the standards it references.
4. Create cross-linking facts with predicates like `references_standard`, `related_to`, `originated_from`, `same_topic_as`.
5. The system prompt forbids marking a sparse leaf as "healthy" — they represent MISSING connections, not present ones.

**Orphans.** `get_entity_sources(entity_id)` + `query_entity_facts(entity_id)`. Decide: real entity that lacks facts (add at least one), false extraction (note but don't delete — aged-orphan cleanup is a separate concern), or duplicate of an existing entity.

### 4.3 Phase 3 — ACT

For every action, the system prompt requires clear evidence from Phase 2. Never act on a hunch without investigation.

The locked rule: subject and object must be DIFFERENT entities (no self-pointing facts).

### 4.4 Phase 4 — REPORT

Structured Markdown report covering topology overview, islands investigated, consolidations, facts created, summaries updated, orphans, structural observations, and skipped/uncertain cases.

## 5. Tool roster

The gardener runs against the unified `GRAPH_TOOLS` MCP server (doc 30 §2). Compared to the reconciliation agent's 15-tool subset, the gardener has the **full** roster including write tools the reconciliation agent doesn't typically use (e.g. `update_entity_summary` as a primary action, not just a follow-up).

Tool budget: **80 calls per session** (vs reconciliation's 50). Typical session uses 40-60. The larger budget reflects topology-first exploration — Phase 1 (MAP) alone consumes 5-10 calls before any investigation starts.

Timeout: **600 seconds** (10 minutes) per LLM session. Concurrency: shared `llm_pool` with the graph agent and reconciliation agent (`ml-services/app/core/concurrency.py`); queue-full returns HTTP 503.

## 6. Merge vs same-as criteria (locked by system prompt)

The system prompt encodes the merge-vs-same-as decision rule explicitly, after history of the gardener over-using `same_as` for name variants (see `issues/05-merge-same-as-quality.md` — four same_as links were created for what should have been merges before the prompt was tightened).

### The locked test

> "Would merging these lose information that matters?"

- **NO → MERGE.** One entity is absorbed; no meaningful context is lost.
- **YES → SAME_AS.** Both nodes preserved because each carries distinct facts or perspective.

### MERGE (destructive) — confidence 0.9+

Signals:

- Same name (case-insensitive), or trivial variant ("The X" vs "X", "R. Walton" vs "Robert Walton", typos like "Petersburgh" vs "Petersburg")
- Same or compatible entity types
- Facts don't contradict
- No distinct perspective or context worth preserving — duplicates from different extraction runs

Action: `execute_merge(source_entity_id, target_entity_id, reasoning)` — calls the SQL `merge_entities()` function from `005_reconciliation.sql`. The function re-points facts, aliases, memory_entities, entity_merges, causal_events, same_as_links, then deletes the source. Audit row in `entity_merges`.

Then `update_entity_summary` on the survivor.

The system prompt explicitly forbids fallback: if `execute_merge` fails with a constraint error, the agent must report it — never silently convert to `same_as`. This is doctrine carried over from `issues/05-merge-same-as-quality.md`.

### SAME_AS (non-destructive) — confidence 0.7+

Signals (high bar to distinguish from MERGE):

- Different names describing the same referent from different viewpoints
- Each has its own fact cluster with unique information
- Narrative perspective shift (one entity in third-person, the other speaking in first-person)
- Merging would lose the distinct framing each node provides

Example from the Frankenstein test set: "the stranger" (described by Walton) ↔ "Victor Frankenstein" (self-narrator) — same person, but each node carries different facts from different narrative perspectives.

Action: `create_same_as_link(entity_a_id, entity_b_id, reasoning, source_evidence)` — writes to `same_as_links`. `source_evidence JSONB NOT NULL` (array of `{type, id, relevance}`).

Then `update_entity_summary` on BOTH entities to note the connection.

The locked rule that prevents same_as misuse: **NEVER create a same_as link between entities with the same or near-identical names — that is always a merge.**

### DISTINCT (false positive)

Per `resolve_candidate` — when an investigated pair turns out to be genuinely different. Same threshold and behaviour as the reconciliation agent (doc 35 §4.3).

## 7. Other write actions

### 7.1 Bridge facts

If linking islands reveals a recordable relationship between the connected clusters, the agent creates the fact via `create_fact(subject, predicate, object, source_text, source_memory_id)`. Only with clear source evidence — the system prompt forbids inference without support.

### 7.2 Summary updates

After any consolidation, the agent updates the affected entities' summaries via `update_entity_summary`. For same_as: note the confirmed connection and what each entity represents in its respective context. For merge: note on the surviving entity what the absorbed entity was.

### 7.3 Alias registration

When investigation surfaces an unrecorded name variant, the agent calls `add_entity_alias` to register it.

### 7.4 Fact expiry (proposed, not shipped)

`issues/03-gardener-fact-expiry.md` proposes an `expire_fact` MCP tool letting the gardener soft-expire facts it discovers are stale, contradictory, or superseded during exploration. Currently the gardener can `create_fact` but not `expire_fact` — fact expiry only fires automatically when a new fact with an exclusive predicate is created during extraction (see `src/services/facts.ts:52-68`). The proposed tool would call the existing `expireFact(factId, reason)` helper. Not yet implemented; tracked in the issue doc.

## 8. Persistence and audit (current state)

### 8.1 Manual path (today)

`POST /api/garden` writes to `gardening_reports` after the agent returns:

```sql
INSERT INTO public.gardening_reports (trigger_type, report_text, duration_ms)
VALUES ('manual', <report>, <ms>);
```

The schema (`006_gardening.sql`) supports much richer metadata:

```sql
CREATE TABLE public.gardening_reports (
  id                    UUID PRIMARY KEY,
  trigger_type          VARCHAR(20) NOT NULL DEFAULT 'manual',  -- 'manual' | 'auto'
  runs_since_last       INT NOT NULL DEFAULT 0,
  actions               JSONB NOT NULL DEFAULT '[]',
  same_as_created       INT NOT NULL DEFAULT 0,
  merges_executed       INT NOT NULL DEFAULT 0,
  facts_created         INT NOT NULL DEFAULT 0,
  summaries_updated     INT NOT NULL DEFAULT 0,
  total_entities        INT,
  total_components      INT,
  islands_investigated  INT NOT NULL DEFAULT 0,
  report_text           TEXT NOT NULL,
  duration_ms           INT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

The `trigger_type` enum (`'manual' | 'auto'`) is enforced at the schema layer by the `valid_trigger_type` CHECK constraint added in `031_trigger_type_check.sql` (bead `nmemo-2yv.69`). The canonical TS-side declaration lives at `src/services/enums.ts:TRIGGER_TYPE_VALUES`; the migration carries a `-- keep in sync with src/services/enums.ts:TRIGGER_TYPE_VALUES` comment naming the authoritative location. A typo in either writer (`POST /api/garden` or the pipeline auto-trigger) now fails the insert with a `check_violation` rather than landing silently.

Today the manual insert populates only `trigger_type`, `report_text`, `duration_ms`. The structured columns (`actions`, `same_as_created`, etc.) are zero/null — no report-parser exists. The aspirational design is `recordGardeningRun(opts)` extracting counts from the agent's structured report; until then, those columns are placeholders.

### 8.2 Auto path (today — incomplete)

Per §2.1, the auto-trigger does NOT insert into `gardening_reports`. The result is captured only in `ExtractResult.gardener` for telemetry. Tracked by bead `.67` (open) — fix is the same `recordGardeningRun` helper, called from both paths.

The schema column `trigger_type='auto'` is dead-on-write until `.67` lands.

## 9. Error handling

### 9.1 Pipeline auto-trigger

Per §2.1. Any failure in `invokeGardenerAgent` is caught and logged. The pipeline never blocks on a failed gardener:

| Failure mode | Visible signal | Pipeline impact |
|---|---|---|
| Counter not yet at threshold | No-op (no log) | None |
| Agent timeout (600s) | `gardenerResult = { triggered: false }` + warn log | None |
| ML service 503 (queue full) | `gardenerResult = { triggered: false }` + warn log | None |
| Any other exception | `gardenerResult = { triggered: false }` + warn log | None |

`graphAgentRunCount` is reset to 0 BEFORE the async call to prevent the next ingest from re-triggering while the previous gardener is still in flight.

### 9.2 Manual `/api/garden`

Errors propagate to a 500 HTTP response with `{ triggered: false, error, durationMs }`. The audit insert is fire-and-forget — a failed `gardening_reports` write logs a warning but doesn't fail the response.

## 10. Observability and audit (gaps)

| What | Stored where | Status |
|---|---|---|
| Manual run report | `gardening_reports` (trigger_type='manual') | Live |
| Auto run report | `ExtractResult.gardener` only | **Audit gap** — `.67` |
| Same-as links created | `same_as_links` (created_by='reconciliation_agent') | Live but misattributed — `.66` |
| Merges executed | `entity_merges` | Live |
| Facts created | `facts` | Live |
| Structured action counts | `gardening_reports.actions` + count columns | Schema-ready, never populated |
| Per-decision metrics (% merge vs same_as) | n/a | Extractable from `same_as_links` and `entity_merges` but not aggregated |

Two cross-feature audit gaps are open:

- `.66` — `same_as_links.created_by` is hardcoded to `'reconciliation_agent'` in the shared tool handler. Gardener-created same_as links are misattributed. Fix: thread the calling agent identity through the tool handler.
- `.67` — auto-triggered gardener runs are not persisted. Fix: shared `recordGardeningRun` helper used by both the manual and auto paths.

## 11. Historical context

This doc consolidates two pre-existing fragmentary sources:

- **`issues/03-gardener-fact-expiry.md`** — narrow proposal for the `expire_fact` MCP tool (§7.4). Not implemented; the issue doc remains as a forward-looking proposal.
- **`issues/05-merge-same-as-quality.md`** — the over-creation-of-same_as-links incident that motivated the locked merge-vs-same-as criteria in the system prompt (§6). Resolved at the prompt level; residual gaps tracked by `.66` (createdBy attribution) and `.67` (audit gap).
- **`docs/research/gardener-research.md`** — KARMA agent research, bi-temporal model. Historical context for the position paper; the current gardener implementation does not derive from KARMA's job-queue scheduler architecture.
- **`docs/work-packets/phase3/W21-gardener-scheduler.md`** — work packet for a Phase-3 job-queue scheduler that was abandoned. The current LLM-agent gardener is the live design; the work-packet describes an obsolete direction.

The `docs/research/` and `docs/work-packets/` fragments are historical — `docs/architecture/truth-graph/36-gardener-agent.md` (this doc) is the canonical entry point.

## 12. Cross-references

### 12.1 Beads (open, gaps in the current state)

- `nmemo-2yv.66` — `same_as_links.created_by` hardcoded; misattributes gardener-created links (§10).
- `nmemo-2yv.67` — auto-triggered gardener runs not persisted to `gardening_reports` (§2.1, §8.2, §10).

### 12.2 Related architecture docs

- `06-graph-meta-layer.md` — entity meta and merge-candidate detection upstream of the gardener's exploration.
- `21-cluster-bridging-master.md` — cluster topology the gardener queries via `get_graph_topology()`.
- `30-mcp-transport.md` — the MCP transport the gardener runs over.
- `32-compute-trigger-registry.md` §2 — the doc-32 row for `gardener` (every-N-graph-runs threshold-driven trigger; flags the `.67` audit gap).
- `34-architectural-principles.md` — Rule 1 lists `/api/garden` as a user-facing surface; Rule 2 makes the pipeline counter the production cadence; Rule 3 covers `/api/garden`'s debug-surface role.
- `35-reconciliation-agent.md` — the sibling maintenance agent that works from a candidate list rather than topology exploration.

### 12.3 Code

- `ml-services/app/gardener_agent.py` — system prompt (the source of truth for behaviour), endpoint, request/response models.
- `platform/src/services/causal-agent.ts` — `invokeGardenerAgent` HTTP client.
- `platform/src/pipeline.ts` — `GARDENER_RUN_INTERVAL` and the auto-trigger block.
- `platform/src/index.ts` — `POST /api/garden` handler.
- `platform/src/db/migrations/006_gardening.sql` — `gardening_reports` schema.
