# Continuation Prompt — Phase B Testing & Verification

## Branch & Context

Branch: `feat/sparse-truth-graph`. Phase B (Graph C Causal Layer) is code-complete — all 29 beads closed, committed at `c275941`. The MCP integration blocker is resolved. The full Claude Code → MCP → DB chain is proven working.

Run `bd prime` then `bd list --all` to see all closed beads. Read `CLAUDE.md` for project conventions.

## What's Proven (this session)

1. **MCP server starts and exposes 7 tools** — `causal-integration.test.ts` test 1 passes (~1.3s)
2. **Claude Code calls MCP tools through the ML service subprocess chain** — `causal-integration.test.ts` test 2 passes (~45s). Claude Code received a causal delta, called `create_causal_edge` via MCP, and inserted a real edge into PostgreSQL with reasoning + source references.
3. **46/48 causal harness tests pass** — the 2 failures are infrastructure-only (Ollama not running for embeddings).

## What Needs Testing

### Step 1: Start infrastructure
```bash
# Ollama (host) — needed for embeddings
ollama serve
# Verify
curl http://127.0.0.1:11434/api/tags

# ML service (host, port 8000)
cd ml-services && make ml   # or from repo root: make ml

# PostgreSQL + Qdrant should already be running via Docker
make up   # if not running
```

### Step 2: Run the 2 remaining tests
```bash
cd platform
npx vitest run src/test/harness/causal-pipeline.test.ts --reporter verbose
npx vitest run src/test/harness/causal-chains.test.ts --reporter verbose
```

- **causal-pipeline.test.ts** (`B08`): Calls `ingest()` with causal language, verifies the conditional trigger fires and Claude Code creates edges via MCP.
- **causal-chains.test.ts** (`B09`): 3 sequential `ingest()` calls, verifies causal chains span multiple memories with valid reasoning quality.

Both failed previously with: `ML /embed failed (500): Embedding failed: [WinError 10061]` — Ollama was not running. With Ollama up, they should pass.

### Step 3: Run the full causal test suite
```bash
cd platform
npx vitest run src/test/harness/causal-*.test.ts --reporter verbose
```

Expected: 48/48 pass. If any fail, check:
- Ollama on 11434 (embeddings)
- ML service on 8000 (extraction + causal reasoning)
- PostgreSQL on 5433 (graph storage)
- Qdrant on 6335 (vector search)

### Step 4: Run all harness tests (Phase A + B)
```bash
cd platform
npx vitest run src/test/harness/ --reporter verbose
```

This includes the Frankenstein regression and entity resolution convergence tests from Phase A. These are LLM-backed and take ~2-5 minutes.

## MCP Fix Summary (for context)

Three issues blocked MCP tool calls through the subprocess chain. All fixed in commit `c275941`:

| Issue | File | Fix |
|---|---|---|
| Claude Code ignores `cwd` in MCP config | `platform/src/services/causal-agent.ts:377` | Use absolute path to `causal-mcp.ts` in args |
| MCP tools need explicit allowlisting in `-p` mode | `ml-services/app/core/llm.py:171` | Added `--allowedTools "mcp__mnemo-causal__*"` |
| MCP subprocess doesn't inherit env vars | `platform/src/services/causal-agent.ts:382-388` | Pass `DATABASE_URL` etc. via config `env` field |
| Global MCP servers pollute tool list | `ml-services/app/core/llm.py:170` | Added `--strict-mcp-config` |

## Key Files

- `platform/src/services/causal-agent.ts` — tool definitions, `getMcpConfigPath()`, `invokeCausalAgent()`, MCP health check
- `platform/src/services/causal-mcp.ts` — standalone MCP server (stdio transport, 7 tools)
- `platform/src/services/causal-trigger.ts` — conditional trigger logic (when causal agent runs)
- `platform/src/pipeline.ts` — `ingest()` / `store()` / `extract()` with causal integration
- `ml-services/app/causal_reason.py` — `/causal-reason` endpoint, system prompt, delta formatter
- `ml-services/app/core/llm.py` — `ClaudeCodeProvider._build_cmd()` with MCP flags
- `platform/src/services/causal.ts` — causal service read/write/query functions

## Conventions

- No `Co-Authored-By` lines in commits
- Always run concrete acceptance checks before closing beads
- Test helpers in `src/test/setup.ts`: `testDb`, `createTestEntity()`, `createTestFact()`, etc.
- Infrastructure: PostgreSQL+AGE on 5433, Qdrant on 6335, Ollama on 11434, ML services on 8000
