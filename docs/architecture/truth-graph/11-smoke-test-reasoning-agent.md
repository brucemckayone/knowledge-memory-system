# Phase 0 — Smoke-Test Reasoning Agent (No Code)

**Parent:** [10 — Reasoning Layer Overview](10-reasoning-layer-overview.md)
**Size:** S
**Depends on:** Nothing
**Blocks:** All implementation phases (validates current state first)

## Purpose

The reasoning agent is fully implemented — 25 MCP tools, patrol + query modes, system prompt — but has never been tested end-to-end. Before we invest in code changes, we validate that the existing invocation chain works against the loaded MISRA C++ 2023 data.

This phase ships no code. It ships a playbook, findings, and a list of any bugs discovered. Bugs get fixed here before they contaminate later phases.

## Why This Matters

The current data state is:
- ~159 entities (MISRA rules, categories, related concepts)
- ~290 facts
- Unknown number of causal events (triggered on fact changes)
- Zero causal edges likely (agent has never run)
- Zero reasoning reports

If the reasoning agent fails to invoke cleanly (MCP spawning on Windows, config paths, tool name mismatches), every downstream phase inherits the same bug.

## Invocation Chain — What We're Validating

```d2
direction: right

user: "User\nHTTP POST" {
  shape: person
}

platform: "Platform API\n:3001" {
  endpoint: "/api/reason/query"
}

causal_agent: "causal-agent.ts" {
  invoke: "invokeReasoningAgent()"
  mcp_config: "getMcpConfigPath()\nwrites .graph-mcp-config.json"
}

ml: "ML Service\n:8000" {
  endpoint: "/reasoning-agent"
  prompt: "_build_reasoning_prompt()"
}

llm: "Claude Code CLI\nsubprocess" {
  prompt_file: "--system-prompt-file"
  mcp: "--mcp-config --strict-mcp-config"
  allowed: "--allowedTools mcp__mnemo-graph__*"
}

mcp: "MCP Server\ncausal-mcp.ts" {
  tools: "25 tools from\nGRAPH_TOOLS"
}

db: "PostgreSQL :5433" {
  entities: "entities"
  facts: "facts"
  causal_events: "causal_events"
  reasoning_reports: "reasoning_reports"
}

qdrant: "Qdrant :6335" {
  memories: "source memories"
}

user -> platform.endpoint: "POST\n{question}"
platform.endpoint -> causal_agent.invoke
causal_agent.invoke -> causal_agent.mcp_config: "writes config"
causal_agent.invoke -> ml.endpoint: "POST {mode, question, mcp_config_path}"
ml.endpoint -> ml.prompt
ml.prompt -> llm: "spawn subprocess"
llm.mcp -> mcp.tools: "tools/list\ntools/call"
mcp.tools -> db: "SQL queries"
mcp.tools -> qdrant: "vector search"
llm -> ml.endpoint: "stdout JSON"
ml.endpoint -> platform.endpoint: "{result}"
platform.endpoint -> user: "JSON response"
```

Every arrow is a potential break point. The smoke test walks each one.

## Prerequisites

1. Services running:
   - PostgreSQL on 5433 (`make up`)
   - Qdrant on 6335 (`make up`)
   - Ollama on 11434 with `nomic-embed-text`
   - Python ML service on 8000 (`make ml`)
   - Platform on 3001 (`pnpm dev` from `platform/`)
2. Data loaded: MISRA C++ 2023 entities + facts (verified via `GET /api/viz/stats`)
3. Claude Code CLI on PATH (`claude --version`)

## Test Playbook

### Test 1 — Infrastructure Health

```bash
# Platform health
curl http://localhost:3001/health

# Stats
curl http://localhost:3001/api/viz/stats

# ML health
curl http://localhost:8000/health
```

**Expected:** All 200 OK, stats show entities > 150, facts > 250.

### Test 2 — MCP Server Standalone

```bash
# From platform directory
cd platform
npx tsx src/services/causal-mcp.ts
# Should start and await stdin. Type tools/list JSON-RPC request manually or Ctrl-C.
```

Also exercise the automated health check:
```bash
curl http://localhost:3001/api/mcp-health
```

**Expected:** `ok: true`, `tools: [...]` with 25 entries.

**Failure modes to watch:**
- `npx tsx` not resolvable → check PATH
- `shell: true` not set on Windows → see `causal-agent.ts:1781`
- tsx can't find `causal-mcp.ts` → check `cwd` resolves correctly
- Tool count < 25 → `GRAPH_TOOLS` array truncation or import failure

### Test 3 — Reasoning Agent Patrol Mode

```bash
curl -X POST http://localhost:3001/api/reason \
  -H "Content-Type: application/json" \
  --max-time 700
```

**Expected response shape:**
```json
{
  "triggered": true,
  "result": "# Patrol Report\n\n## Survey\n...",
  "durationMs": <60000-400000>
}
```

**What to inspect:**
- ML service logs show `[reasoning] request received mode=patrol`
- Subprocess stdout shows MCP tool calls (at minimum: `get_reasoning_targets`, `get_neighbourhood_profile`, `save_reasoning_report`)
- `reasoning_reports` table has a new row: `SELECT * FROM reasoning_reports ORDER BY created_at DESC LIMIT 1;`
- `entity_meta.last_reasoned_at` updated for touched entities

### Test 4 — Reasoning Agent Query Mode

Use the loaded MISRA data. Good smoke-test questions:

```bash
curl -X POST http://localhost:3001/api/reason/query \
  -H "Content-Type: application/json" \
  -d '{"question": "Which MISRA C++ 2023 rules relate to pointer arithmetic?"}' \
  --max-time 700
```

Second prompt — uses the deliberately-bad code file:

```bash
# Read the file into a variable (bash-on-Windows syntax)
CODE=$(cat platform/test-bad-code.cpp)
QUESTION="What MISRA C++ 2023 rules would this code violate?\n\n${CODE}"

curl -X POST http://localhost:3001/api/reason/query \
  -H "Content-Type: application/json" \
  -d "$(jq -n --arg q "$QUESTION" '{question: $q}')" \
  --max-time 700
```

(If `jq` isn't available on Windows, hand-construct JSON or use Python one-liner.)

**Expected response shape:** `{ triggered: true, result: <markdown answer>, durationMs: ... }`

**Quality checks:**
- Answer cites actual MISRA rule IDs/names present in the graph
- Answer references source memories via evidence
- Agent called `search_similar_entities`, `get_memory_text`, `get_causal_history` at minimum
- Reasoning report stored with `mode='query'` and the question text

### Test 5 — Report Retrieval

```sql
-- connect: psql -h localhost -p 5433 -U postgres mnemo
SET search_path = ag_catalog, public;

SELECT id, mode, question, LEFT(report, 200) AS preview, 
       jsonb_array_length(entity_ids) AS n_entities, created_at
FROM reasoning_reports
ORDER BY created_at DESC
LIMIT 5;
```

**Expected:** Rows with populated `report`, at least one entity_id, timestamps.

## Known Failure Modes

### MCP Config Path on Windows

`getMcpConfigPath()` writes `platform/.graph-mcp-config.json` using an absolute path. On Windows, backslashes in the JSON must be escaped. Verify the written file parses:

```bash
cat platform/.graph-mcp-config.json | python -m json.tool
```

### Subprocess Timeout

Claude CLI subprocess has a 600s timeout. Query mode with 100 tool calls can push close. If the subprocess is killed mid-flight, the ML service returns 504. Check ML logs:

```
[reasoning] submitting to llm_pool...
[reasoning] failed: Claude CLI timed out after 600s
```

Raise `timeout` in `reasoning_agent.py:275` if needed.

### Tool Name Mismatches

System prompt references tools by name. If any tool in `GRAPH_TOOLS` was renamed without updating the prompt, the agent will call a nonexistent tool and either retry or fail.

```bash
# Extract tool names from the TS source
grep "name: '" platform/src/services/causal-agent.ts | grep -oP "(?<=name: ')[^']+" | sort > /tmp/tools.txt

# Extract tool names referenced in the prompt
grep -oE "(query_entity_facts|query_entity_neighbours|search_similar_entities|search_memories|get_memory_text|get_causal_history|get_fact_source|resolve_entity|create_fact|link_entity_to_memory|add_entity_alias|search_entity_aliases|update_entity_summary|get_entity_sources|create_same_as_link|execute_merge|resolve_candidate|get_reconciliation_context|get_graph_topology|expire_fact|invalidate_fact|get_neighbourhood_profile|get_reasoning_targets|get_reasoning_history|save_reasoning_report|create_causal_edge)" ml-services/app/reasoning_agent.py | sort -u > /tmp/prompt-refs.txt

diff /tmp/tools.txt /tmp/prompt-refs.txt
```

### MCP Tools Not Allowed

`llm.py:210` sets `--allowedTools mcp__${mcp_server}__*`. Default `mcp_server_name` is `"mnemo-graph"`. If the MCP config's server key differs from that, Claude blocks all calls. Check the config:

```bash
python -c "import json; print(json.load(open('platform/.graph-mcp-config.json'))['mcpServers'].keys())"
# Expected: dict_keys(['mnemo-graph'])
```

## Test Data Requirements

Phase 0 is a manual smoke test and does not ship curated fixtures. But it establishes a **baseline** for subsequent benchmarks:

- Capture `GET /api/viz/stats` output before and after runs
- Record the reasoning agent's output — this becomes the Level 4 end-to-end baseline for `TEST-E2E` (`bd show nmemo-klv.7`)
- Note tool call sequences, timing, and any anomalies in `docs/handoff/reasoning-smoke-test-findings.md`

These findings seed the `TEST-E2E` end-to-end corpus — bad C++ queries with expected rule citations — which becomes the authoritative quality benchmark for the whole reasoning layer.

## Acceptance Criteria

Phase 0 is complete when:

- [ ] All 5 tests run without subprocess errors
- [ ] Patrol mode creates at least one reasoning report and updates `entity_meta.last_reasoned_at`
- [ ] Query mode answers a MISRA question with specific rule citations from the graph
- [ ] Any bugs discovered are either fixed in this phase or documented as issues for Phase 1+
- [ ] MCP health endpoint returns 25 tools
- [ ] No tool name mismatches between prompt and implementation

## Deliverables

Checked into the repo:
- `docs/architecture/truth-graph/11-smoke-test-reasoning-agent.md` (this doc)
- `docs/handoff/reasoning-smoke-test-findings.md` (new — results of running the playbook)

Optional (only if bugs found):
- Minimal fixes in `platform/src/services/causal-agent.ts`, `ml-services/app/reasoning_agent.py`, or `ml-services/app/core/llm.py`

## Beads Issues

Parent: **nmemo-dey** (Phase 0)

- **nmemo-dey.1** — Run full smoke test playbook and record findings
- **nmemo-dey.2** — Fix any invocation-chain bugs discovered (sub-tasks created as needed)

`bd show nmemo-dey` for full tree.

## Test Design (No New Automated Tests)

This phase is deliberately manual. Automated tests arrive in Phase 1 onward. The smoke test is a **playbook**, not a test suite. Its purpose is to validate the existing system works before we invest in expanding it.

If bugs are found, **regression tests go in the phase that touches the affected code**. For example, if we discover `getMcpConfigPath()` produces malformed JSON on Windows, the regression test for that lives in the phase that modifies that function (or `platform/src/test/harness/mcp-config.test.ts` if it's a standalone fix).

## Exit Criteria → Phase 1

Phase 1 (Audit Trail Foundation) begins when:
1. Smoke test acceptance met
2. Any discovered bugs either fixed or documented
3. A baseline reasoning report exists — Phase 1's history tables will eventually link to reports like this one
