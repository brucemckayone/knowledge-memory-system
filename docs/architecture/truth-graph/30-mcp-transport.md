# MCP Transport — canonical contract

**Status:** initial fill, 2026-05-26 (bead `nmemo-2yv.125`).
**Themes addressed:** T1 (doc-vs-code drift), T9 (observability gap), T11 (silent transport drift), T13 (Pi bridge replacement was never documented).
**Discovered from:** Review #13 cross-feature synthesis + the count/file-name drift cycle in docs 04 / 07 / 11.

---

## 1. Overview

The reasoning, gardener, reconciliation, and causal agents all need a way to call into the platform's graph tools (read entities, create facts, expire causal edges, etc.) from inside an LLM agentic loop. Two transports back this today, gated by an env-var switch in `ml-services`:

- **MCP path** — Claude Code (subprocess) speaks the Model Context Protocol over stdio to a Node MCP server (`src/services/graph-mcp.ts`). One process per agent invocation.
- **Pi bridge path** — an in-process HTTP bridge (`src/services/pi-agent-bridge.ts`) exposes the same tools over `/run`; ml-services' `PiBridgeProvider` calls it directly.

Both transports dispatch through the same shared dispatcher: `handleToolCall` in `src/services/causal-agent.ts`. The tool catalogue is the same: `GRAPH_TOOLS` (currently 38 tools; the actual count is whatever the array length is at any commit).

This doc captures the contract so doc-vs-code drift on tool count + file name + invariants stops recurring.

## 2. Transport selection

The selection lives in `ml-services` (Python), not platform (TS). Specifically:

- **`ml-services/app/core/llm.py`** reads `LLM_PROVIDER` from `process.env`. Allowed values:
  - `claude` (code default) — routes to `ClaudeCodeProvider` (the MCP path).
  - `pi` — routes to `PiBridgeProvider` (the Pi bridge path).
  - `zai` — bypasses both; the provider runs inside ml-services (no host transport process).
- **`ml-services/.env`** sets the active provider per-deployment. As of 2026-05-26 it sets `LLM_PROVIDER=pi`. The "code default is `claude`" / "deployed default is `pi`" split is a real source of confusion — the env file decides what runs.

Operators flip the provider by editing `ml-services/.env` and restarting ml-services. No platform restart is required because the platform-side dispatcher is transport-agnostic.

## 3. MCP path — data flow

```d2
shape: sequence_diagram

pipeline: "platform/pipeline.ts"
agent: "causal-agent.ts\ninvokeReasoningAgent"
ml: "ml-services\nFastAPI"
claude: "Claude Code\nsubprocess"
mcp: "graph-mcp.ts\n(stdio JSON-RPC)"
handle: "causal-agent.ts\nhandleToolCall"

pipeline -> agent: "invokeReasoningAgent(delta)"
agent -> agent: "getMcpConfigPath('graph_agent')\nwrites .graph-mcp-config.graph_agent.json"
agent -> ml: "POST /reasoning-patrol\n{ mcp_config_path }"
ml -> claude: "spawn(claude -p ...)\n--mcp-config + --strict-mcp-config\n--allowedTools mcp__mnemo-graph__*"
claude -> mcp: "spawn(npx tsx graph-mcp.ts)\nwith env from getMcpEnv via config file"
mcp -> handle: "dispatch by tool name\n(initialize → tools/list → tools/call ...)"
handle -> mcp: "result JSON"
mcp -> claude: "tool response"
claude -> ml: "agent transcript"
ml -> agent: "{ ok, result, ... }"
```

**Key files:**
- `src/services/causal-agent.ts` — `getMcpConfigPath(actor)` writes a per-actor MCP config; `getMcpEnv(actor)` is the shared env builder (added by bead `.126`); `GRAPH_TOOLS` is the tool catalogue; `_handleToolCallInner` is the dispatcher switch.
- `src/services/graph-mcp.ts` — the MCP server itself. Reads stdio, dispatches by name to `handleToolCall`.
- `ml-services/app/core/llm.py` — `ClaudeCodeProvider._build_cmd` adds `--mcp-config + --strict-mcp-config + --allowedTools mcp__mnemo-graph__*`.

## 4. Pi bridge path — data flow

```d2
shape: sequence_diagram

pipeline: "platform/pipeline.ts"
agent: "causal-agent.ts\ninvokeReasoningAgent"
ml: "ml-services\nFastAPI"
pi: "ml-services\nPiBridgeProvider"
bridge: "pi-agent-bridge.ts\nHTTP /run"
handle: "causal-agent.ts\nhandleToolCall"

pipeline -> agent: "invokeReasoningAgent(delta)"
agent -> ml: "POST /reasoning-patrol\n(no mcp_config_path used)"
ml -> pi: "PiBridgeProvider.run(...)"
pi -> bridge: "HTTP POST /run\n{ actor, system_prompt, tools }"
bridge -> handle: "in-process dispatch by tool name\n(no subprocess)"
handle -> bridge: "result JSON"
bridge -> pi: "streaming SSE events"
pi -> ml: "transcript"
ml -> agent: "{ ok, result, ... }"
```

**Key files:**
- `src/services/pi-agent-bridge.ts` — HTTP server on `PI_BRIDGE_PORT` (default 3099). The `/run` route accepts an agent spec, dispatches tool calls via `handleToolCall`, and streams events back.
- `src/services/causal-agent.ts` — same `handleToolCall`. The Pi bridge does NOT use `getMcpConfigPath`; env passes via the bridge process's own `process.env`.

## 5. Parity contract

Both transports dispatch through `handleToolCall` and share the same tool catalogue. The PR contract:

1. **One tool catalogue.** Tools are defined in `GRAPH_TOOLS` (`src/services/causal-agent.ts`). Tool count is `GRAPH_TOOLS.length`; this doc does not hard-code a number. A regression test asserts each tool's existence (`src/test/harness/causal-mcp.test.ts`).
2. **One dispatcher.** Every tool call lands in `handleToolCall`, which routes to `_handleToolCallInner`. Both transports go through this function — write serialisation, audit context, and error wrapping happen exactly once regardless of transport (see §6).
3. **One env builder.** The MCP server subprocess gets its env from `getMcpEnv(actor)` (added by bead `.126`); both `getMcpConfigPath` (which writes the config Claude Code consumes) and `checkGraphMcpHealth` (which spawns the server directly) call this. Pi bridge inherits its env from the running process — its env contract is "whatever the bridge process was started with".

### 5.1 Parity test assertions (bead `nmemo-2yv.134`)

The contract above is enforced by `src/test/harness/transport-parity.test.ts`. It exercises the two live transports (`pi-agent-bridge.ts` over HTTP, `graph-mcp.ts` over stdio JSON-RPC) and asserts:

1. **Tool surface equivalence.** Both transports' `tools/list` (Pi: `GET /tools`; MCP: JSON-RPC `tools/list`) return the same set of tool names. For every tool, `inputSchema.required` is identical across transports (order-insensitive).
2. **Tool count matches `GRAPH_TOOLS`.** Both transports' tool-list length === `GRAPH_TOOLS.length`. A tool that fails to register in either transport — for instance, a `defineTool` schema rejection in Pi or a missing entry in `setRequestHandler(ListToolsRequestSchema, ...)` on the MCP side — fails this assertion before any agentic flow runs.
3. **Write-serialization parity.** Two concurrent `create_fact` calls against the Pi bridge's direct-dispatch endpoint (`POST /tools/call`) both persist as distinct rows. The shared `writeQueue` in `handleToolCall` serialises them regardless of transport (post-bead `.127`). The MCP-side mirror lives in `src/test/harness/causal-mcp.test.ts` ("write-tool serialisation") — `handleToolCall` is the singleton dispatcher; re-proving the same queue via JSON-RPC stdio is redundant.
4. **Unknown-tool error envelope.** Issuing `tools/call` with a bogus tool name (Pi: `POST /tools/call`, MCP: JSON-RPC `tools/call`) returns the same envelope on both: `{ isError: true, content: [{ type: 'text', text: 'Error: ...' }] }`. This guards against either transport silently changing how `handleToolCall`'s default-branch throw is surfaced.

The Pi bridge's `POST /tools/call` is a debug-only endpoint introduced by bead `.134` for this test. It mirrors `graph-mcp.ts`'s envelope shape. Agents do not call it in production — they go through `POST /run` and let the Pi SDK route invocations to the registered `defineTool` handlers.

**ZAI is excluded from the parity test.** ZAI (`LLM_PROVIDER=zai`) runs inside ml-services and has not been audited by any previous review cycle; testing it would require credentials, a network gate in CI, and a separate ZAI-audit pass. The parity test covers the two transports that the platform currently spawns or hosts — Pi bridge (in-process) and MCP (subprocess). Extending parity to ZAI is a follow-up if and when ZAI gets its own audit; tracked in `31-review-cycle-synthesis.md` §2.9 as the open ZAI gap.

## 6. Transport divergence — known places where behaviour is NOT identical

### Write-tool serialisation

The 17 mutating tools (`create_fact`, `expire_fact`, `execute_merge`, etc.) must run sequentially within a process to avoid races. Bead `nmemo-2yv.127` moved this from a Pi-bridge-only mechanism into the shared dispatcher:

- **Today (post-`.127`):** `causal-agent.ts:handleToolCall` checks `WRITE_TOOLS.has(toolName)` and chains the call through a module-scoped `writeQueue: Promise<unknown>`. The queue is initialised to `Promise.resolve()` at module load; each write chains as `writeQueue.catch(() => undefined).then(run)` so a prior failure does NOT block subsequent writes (fails open). Both transports inherit this — no per-transport mechanism.
- **Before `.127`:** the Pi bridge set `executionMode: isWriteTool(name) ? 'sequential' : 'parallel'` on each tool definition. The MCP transport had no equivalent — concurrent `tools/call` JSON-RPC messages from a single Claude message could race on the same DB tables. The Pi bridge no longer needs this; `executionMode: 'parallel'` is unconditional.

The queue is per-process. Two MCP-spawned subprocesses (one per agent invocation) are isolated at the process boundary, which is fine because a single Claude message cannot fan out across processes. The Pi bridge is single-process; serialisation across concurrent `/run` calls would only matter if two agents called simultaneously, which is rare and out of scope (no current evidence it is a hot path).

### Health probes

The two transports expose different probe endpoints:

- **MCP path:** `GET /api/mcp-health` on the platform (`src/index.ts`). Spawns `graph-mcp.ts`, sends `initialize` + `tools/list` + `tools/call get_graph_topology` over stdio (post-`.126`), returns `{ ok, tools, topologyOk, durationMs }`. `ok: true` requires the topology round-trip to succeed — proves the MCP→DB path works, not just spawn+init.
- **Pi bridge path:** `GET /health` on the bridge itself (`PI_BRIDGE_PORT`). Returns `{ status: 'ok', service: 'pi-agent-bridge', tools: number, version }`. The check is process-liveness only; no DB round-trip.

Bead `.132` wires both probes into a `validateStartup()` gate so the platform fails fast on transport-health failures at boot. Whichever transport is selected (`LLM_PROVIDER`), that transport's probe is the one that gates startup.

### Stderr capture

The MCP probe currently captures stderr only when the subprocess exits non-zero. Successful spawns that emit warnings to stderr (e.g. `dotenv` load notices) lose those signals. Tracked separately (no current bead).

## 7. Server identity invariant

The MCP server name is `mnemo-graph`. This string appears in:

- `src/services/graph-mcp.ts` — server identity returned in `initialize`.
- `src/services/causal-agent.ts` — `getMcpConfigPath` writes `mcpServers: { 'mnemo-graph': { ... } }` into the per-actor config.
- `ml-services/app/core/llm.py` — `--allowedTools mcp__mnemo-graph__*` pattern matches tool calls scoped to this server name.
- Test assertions — `src/test/harness/causal-mcp.test.ts` and friends.

**Any rename requires a coordinated edit across TS + Python + tests.** This is the natural shape of a cross-language transport contract, not a defect. Reviewer F9 from Review #13 considered an SSOT constant; the decision (per bead `.125` notes) was to leave the duplication and call out the invariant here. If the string ever changes, this section + a `bd remember` entry is the trail.

## 8. Process / port table

The platform process listens on `PORT` (default 3000). The Pi bridge listens on `PI_BRIDGE_PORT` (default 3099). The MCP server is NOT a long-running process — it spawns per agent invocation and exits when Claude Code disconnects stdio.

| Process | Default port | Long-running | Started by |
|---|---|---|---|
| Platform (Hono HTTP) | `PORT` = 3000 | Yes | `make dev-all`, `npm run dev` |
| Pi bridge HTTP | `PI_BRIDGE_PORT` = 3099 | Yes | `make dev-all` (separate process) |
| `graph-mcp.ts` MCP server | n/a (stdio) | No — per-invocation | Claude Code subprocess, one per `--mcp-config` invocation |
| ml-services FastAPI | `ML_SERVICES_URL` port (default 8000) | Yes | `make ml` |

A canonical port table for the Integrations layer is tracked under bead `nmemo-2yv.110` (doc 29). When that lands, doc 30 should cross-reference it rather than duplicating.

## 9. Cross-references

- `04-sparse-branch-design.md` §5.6 — the original "MCP server" introduction (now cross-linking here for the full contract).
- `07-graph-agent-workflow.md` §"Tool Inventory" — the tool listing (count is `GRAPH_TOOLS.length`; the source of truth for the list is the code).
- `11-smoke-test-reasoning-agent.md` — manual probe instructions for the reasoning agent end-to-end run.
- `nmemo-2yv.125` — this doc's owning bead.
- `nmemo-2yv.123 / .124 / .126 / .127` — beads that landed the underlying MCP changes this doc codifies.
- `nmemo-2yv.110` (planned doc 29) — Integrations layer canonical doc; port table lives there once it exists.
