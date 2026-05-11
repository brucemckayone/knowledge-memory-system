# Continuation Prompt — Phase B MCP Integration Blocker

## Branch & Context

Branch: `feat/sparse-truth-graph`. Phase B (Graph C Causal Layer) is implemented — all 29 beads are closed, 71 unit tests pass. The blocker is the **end-to-end integration test** that proves Claude Code actually calls MCP tools through the ML service subprocess chain.

Run `bd prime` then `bd list --all` to see all closed beads. Run tests: `cd platform && npx vitest run src/test/harness/causal-*.test.ts`.

## The Architecture

The causal reasoning flow is:

```
TypeScript pipeline (ingest)
  → POST /causal-reason to ML service (Python FastAPI on port 8000)
    → ClaudeCodeProvider.generate() builds CLI command
      → subprocess.run(["claude", "-p", <prompt>, "--mcp-config", <path>, ...])
        → Claude Code spawns MCP server (npx tsx src/services/causal-mcp.ts)
          → MCP server imports handleToolCall() from causal-agent.ts
            → handleToolCall() queries DB via Drizzle, returns JSON
        → Claude Code calls create_causal_edge MCP tool
          → handleToolCall() inserts into causal_edges table
      → Claude Code returns JSON result
    → ClaudeCodeProvider parses JSON, returns result string
  → ML service returns CausalReasonResponse
→ TypeScript checks causal_edges table for new edges
```

## What's Proven

1. **MCP server works standalone** — `checkCausalMcpHealth()` in `causal-agent.ts:447` spawns the server process, sends MCP `initialize` + `tools/list` JSON-RPC messages, and confirms all 7 tools are listed. Test passes in ~2s.

2. **Claude Code sees MCP tools when run from shell** — This command works:
   ```bash
   claude -p "List your MCP tools" \
     --mcp-config "C:/Users/bruce.mckay/dev/nmemo/platform/.causal-mcp-config.json" \
     --output-format json --max-turns 2 --model haiku
   ```
   Returns JSON with `result` listing all 7 tools by name.

3. **ML service `/causal-reason` endpoint exists and responds** — `curl POST /causal-reason` with a minimal delta returned a valid response once (agent produced text reasoning, correctly said "no causal links found" for a trivial input). The endpoint is registered in `ml-services/app/main.py` and appears in `/health`.

4. **Tool handlers work** — `handleToolCall()` tests pass for all 7 tools including `create_causal_edge` which inserts into the DB and returns the edge ID.

## What's NOT Proven

**Claude Code has never been observed calling an MCP tool through the ML service subprocess chain.**

The one "successful" curl response said:
> "I would normally call `query_entity_facts`, `get_causal_history`... the only MCP tools connected are OAuth flows for external services (Atlassian, Figma, Microsoft 365, Miro). The local services/causal-mcp.ts server does not appear to be running or registered."

This means Claude Code, when launched by the ML service subprocess, either:
- Is not receiving the `--mcp-config` flag
- Is receiving it but failing to spawn the MCP server
- Is spawning the MCP server but not in the right working directory
- Is picking up its global MCP config instead of (or in addition to) the one we pass

## The Specific Failure

Test: `platform/src/test/harness/causal-integration.test.ts` → "Claude Code creates causal edge from explicit causal language"

Two failure modes observed:
1. **Agent returns text but no tool calls** — Claude Code runs, produces reasoning text that *describes* the tools, but never actually calls them. 0 edges in DB.
2. **500 error: `NoneType`** — `json.loads(result.stdout)` fails because stdout is empty/None. This happened on retries, possibly because the ML service reloaded mid-test.

## Key Files

### ML Service (Python)
- `ml-services/app/causal_reason.py` — endpoint, system prompt, delta formatter
- `ml-services/app/core/llm.py` — `ClaudeCodeProvider._build_cmd()` (line 118) builds the `claude` CLI command, `_run()` (line 183) executes it via `subprocess.run`

### Platform (TypeScript)  
- `platform/src/services/causal-agent.ts` — `getMcpConfigPath()` (line 368) generates `.causal-mcp-config.json`, `invokeCausalAgent()` (line 398) calls ML service, `checkCausalMcpHealth()` (line 447) health check
- `platform/src/services/causal-mcp.ts` — standalone MCP server entry point
- `platform/src/test/harness/causal-integration.test.ts` — the failing test

### MCP Config (generated at runtime)
Location: `platform/.causal-mcp-config.json`
```json
{
  "mcpServers": {
    "mnemo-causal": {
      "command": "npx",
      "args": ["tsx", "src/services/causal-mcp.ts"],
      "cwd": "C:\\Users\\bruce.mckay\\dev\\nmemo\\platform"
    }
  }
}
```

## Changes Made During Debugging (may need review/revert)

1. **`llm.py`**: Changed `--system-prompt` to `--system-prompt-file` using a temp file — theory was CLI length limits, never confirmed
2. **`llm.py`**: Added `tools == "mcp"` special case to skip `--tools` flag — idea was MCP tools come from `--mcp-config` not `--tools`
3. **`llm.py`**: Added logging (`.info` calls for cmd, rc, stdout/stderr lengths)
4. **`causal_reason.py`**: System prompt was rewritten to heavily emphasize "MUST call MCP tools"

## What to Do Next

**Step 1: Prove MCP tool execution through subprocess.** Write a minimal Python script that:
1. Builds the exact `claude` command that `ClaudeCodeProvider` would build
2. Runs it via `subprocess.run` (same as `_run()`)
3. Prints stdout, stderr, return code
4. Checks if the MCP tool was actually called (e.g., prompt: "Call the get_causal_history MCP tool with entity_id X" where X is a known entity)
5. Checks the DB for side effects

This isolates whether the problem is in subprocess invocation, MCP config discovery, or the prompt/model behavior.

**Step 2: Fix whatever Step 1 reveals.** Likely candidates:
- Path format issue (forward vs backslash) in the MCP config path passed to `--mcp-config`
- The temp file for `--system-prompt-file` not being readable by the subprocess
- `--no-session-persistence` preventing MCP server discovery
- Need for `--allowedTools` or similar flag to permit MCP tool calls
- Claude Code reading CLAUDE.md from the CWD and getting confused

**Step 3: Get the integration test green.** Once MCP tools are confirmed working through subprocess, the test should pass.

**Step 4: Run the multi-input chain test** (`causal-chains.test.ts`) — requires 3 sequential ingest() calls with Claude Code creating edges across them.

**Step 5: Review.** All Phase B changes with a fresh-context subagent.

## Infrastructure Required

- **PostgreSQL** with pgvector + Apache AGE on port 5433 (`make up`)
- **Qdrant** on port 6335 (`make up`)
- **Ollama** on port 11434 with nomic-embed-text model (host)
- **Python ML services** on port 8000 — `cd ml-services && make ml` (runs with `--reload`)
- **Claude Code CLI** on PATH

## Important Conventions

- No `Co-Authored-By` lines in commits
- Run `bd prime` first to load workflow context
- Always run concrete acceptance checks before closing beads (see `memory/feedback_verify_tasks.md`)
- Test helpers in `src/test/setup.ts`: `testDb`, `createTestEntity()`, `createTestFact()`, etc.
