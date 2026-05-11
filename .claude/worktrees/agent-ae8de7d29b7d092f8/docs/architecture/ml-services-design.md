# ML Services - Architecture & Design Document

**Service:** Cognitive ML Services v6.0.0 (Phase 6: Multi-Source Processing)  
**Runtime:** Python 3.11 / FastAPI 0.109.0 / Uvicorn 0.27.0  
**Port:** 8000  
**Role:** Stateless HTTP microservice providing LLM reasoning, embedding, transcription, and NLP extraction to the Mnemo platform.

---

## 1. High-Level Architecture

The ML service is a single-process async Python application. All endpoints are async coroutines. Blocking work (LLM subprocess calls, Ollama HTTP, file I/O) is offloaded to a shared thread pool via `asyncio.to_thread()`. The service holds no database connections and no persistent state -- it is purely request/response.

```d2
direction: right

client: Platform Service {
  shape: rectangle
  style.fill: "#e8f4fd"
  style.font-color: "#1a1a1a"
}

ml: ML Services (FastAPI) {
  style.fill: "#fff3e0"
  style.font-color: "#1a1a1a"

  event_loop: Uvicorn Event Loop {
    shape: oval
    style.fill: "#fff9c4"
    style.font-color: "#1a1a1a"
  }

  routers: 17 Async Routers {
    shape: rectangle
    style.fill: "#e8f5e9"
    style.font-color: "#1a1a1a"
  }

  thread_pool: ThreadPoolExecutor (20 workers) {
    shape: hexagon
    style.fill: "#fce4ec"
    style.font-color: "#1a1a1a"
  }

  event_loop -> routers: dispatch
  routers -> thread_pool: asyncio.to_thread()
  thread_pool -> routers: result
}

claude_cli: Claude Code CLI {
  shape: rectangle
  style.fill: "#f3e5f5"
  style.font-color: "#1a1a1a"
}

ollama: Ollama (nomic-embed-text) {
  shape: cylinder
  style.fill: "#e0f2f1"
  style.font-color: "#1a1a1a"
}

whisper: faster-whisper (in-process) {
  shape: rectangle
  style.fill: "#fbe9e7"
  style.font-color: "#1a1a1a"
}

client -> ml: HTTP/JSON
ml.thread_pool -> claude_cli: subprocess.run()
ml.thread_pool -> ollama: HTTP (port 11434)
ml.thread_pool -> whisper: Python call
```

- **Platform Service** is the primary consumer, calling ML services at `http://localhost:8000`
- **Claude Code CLI** is spawned as a subprocess per LLM call (timeout: 300s, no persistent connection)
- **Ollama** serves embeddings via HTTP (model: `nomic-embed-text`, 768 dimensions, client timeout: 1200s)
- **faster-whisper** runs in-process, lazy-loaded on first `/transcribe` call (model: `small`, CPU int8, ~300MB RAM)

---

## 2. Process & Threading Model

The service runs as a **single OS process** under Uvicorn's default configuration (1 worker). Inside that process:

| Layer | What | Concurrency |
|-------|------|-------------|
| **Uvicorn ASGI server** | Accepts TCP connections, parses HTTP | Single-threaded async (h11 on Windows, httptools on Linux) |
| **asyncio event loop** | Dispatches to FastAPI route handlers | Cooperative multitasking -- one coroutine runs at a time |
| **ThreadPoolExecutor** | Runs blocking calls (LLM subprocesses, Ollama HTTP, file parsing) | **20 OS threads**, configured at startup |

```d2
direction: down

process: Python Process (PID) {
  style.fill: "#f5f5f5"
  style.font-color: "#1a1a1a"

  uvicorn: Uvicorn ASGI Server {
    style.fill: "#e3f2fd"
    style.font-color: "#1a1a1a"
  }

  loop: asyncio Event Loop (single-threaded) {
    style.fill: "#fff9c4"
    style.font-color: "#1a1a1a"

    r1: Request A handler {style.font-color: "#1a1a1a"}
    r2: Request B handler {style.font-color: "#1a1a1a"}
    r3: Request C handler {style.font-color: "#1a1a1a"}
  }

  pool: ThreadPoolExecutor (20 threads) {
    style.fill: "#fce4ec"
    style.font-color: "#1a1a1a"

    t1: Thread 1 - Claude CLI subprocess {style.font-color: "#1a1a1a"}
    t2: Thread 2 - Ollama HTTP call {style.font-color: "#1a1a1a"}
    t3: Thread 3 - Claude CLI subprocess {style.font-color: "#1a1a1a"}
    t4: Thread 4 - Whisper inference {style.font-color: "#1a1a1a"}
    t5: Thread 5-20 (idle) {style.font-color: "#1a1a1a"}
  }

  uvicorn -> loop: hand off parsed request
  loop.r1 -> pool.t1: asyncio.to_thread()
  loop.r2 -> pool.t2: asyncio.to_thread()
  loop.r3 -> pool.t3: asyncio.to_thread()
  pool.t1 -> loop.r1: return result
  pool.t2 -> loop.r2: return result
}
```

The event loop is a **single-threaded cooperative scheduler**. All `async def` handlers run here. It never blocks -- all blocking work is offloaded via `asyncio.to_thread()` to the 20-thread pool.

**Key implication:** The event loop itself never blocks. But the **thread pool is the bottleneck** -- if all 20 threads are occupied by long-running LLM subprocess calls (up to 300s each), new requests queue in the thread pool's work queue until a thread frees up. The event loop remains responsive for health checks and connection handling throughout.

---

## 3. Request Lifecycle

Every request follows the same pattern: validate input (Pydantic), do async orchestration in the event loop, offload blocking work to a thread, return structured JSON.

```d2
direction: down

req: Incoming HTTP Request {shape: oval}
pydantic: Pydantic Validation {shape: diamond}
handler: async def endpoint() {shape: rectangle}
offload: asyncio.to_thread(blocking_fn) {shape: hexagon}
blocking: Blocking Work {
  shape: rectangle
  style.fill: "#fce4ec"
  style.font-color: "#1a1a1a"
}
parse: Parse and Validate Response {shape: rectangle}
resp: JSON Response {shape: oval}

err_422: 422 Validation Error {
  shape: rectangle
  style.fill: "#ffcdd2"
  style.font-color: "#1a1a1a"
}
err_5xx: 500 / 502 / 504 Error {
  shape: rectangle
  style.fill: "#ffcdd2"
  style.font-color: "#1a1a1a"
}

req -> pydantic
pydantic -> err_422: invalid {style.stroke-dash: 3}
pydantic -> handler: valid
handler -> offload
offload -> blocking: runs in thread pool
blocking -> parse: stdout or response body
blocking -> err_5xx: timeout or failure {style.stroke-dash: 3}
parse -> resp
```

**Blocking Work** includes: subprocess calls to Claude CLI, HTTP calls to Ollama, file I/O for document parsing, and in-process Whisper inference.

---

## 4. LLM Provider Architecture

The core LLM abstraction lives in `app/core/llm.py`. A `LLMProvider` protocol defines the interface; the active provider is selected at startup via the `LLM_PROVIDER` env var.

```d2
direction: down

protocol: LLMProvider Protocol {
  shape: class
  style.fill: "#e8eaf6"
  style.font-color: "#1a1a1a"
  generate: "generate(prompt, options) -> str"
  generate_json: "generate_json(prompt, model, options) -> Any"
  extract_json: "extract_json(text) -> dict"
}

claude: ClaudeCodeProvider (primary) {
  shape: class
  style.fill: "#f3e5f5"
  style.font-color: "#1a1a1a"
  _build_cmd: "_build_cmd() -> list"
  _run: "_run(cmd) -> dict"
  _resolve: "_resolve(key) -> str"
}

zai: ZAIProvider (legacy) {
  shape: class
  style.fill: "#efebe9"
  style.font-color: "#1a1a1a"
}

singleton: llm_client singleton {
  shape: oval
  style.fill: "#c8e6c9"
  style.font-color: "#1a1a1a"
}

claude -> protocol: implements {style.stroke-dash: 3}
zai -> protocol: implements {style.stroke-dash: 3}
claude -> singleton: if LLM_PROVIDER=claude
zai -> singleton: if LLM_PROVIDER=zai
```

- **ClaudeCodeProvider** shells out to the Claude Code CLI as a subprocess per call. It is the primary and default provider.
- **ZAIProvider** is a legacy fallback using the OpenAI-compatible Z.AI GLM-4.7 HTTP API.
- **`llm_client`** is a module-level singleton imported by all endpoint routers.

### Claude Code CLI Call Flow

Each LLM call spawns a **short-lived subprocess**. The subprocess runs, writes JSON to stdout, and exits. The parent thread blocks on `subprocess.run()` until completion.

```d2
direction: right

endpoint: Endpoint Handler {shape: rectangle}
to_thread: asyncio.to_thread() {shape: hexagon}
build: _build_cmd() {shape: rectangle}
spawn: subprocess.run(claude -p ...) {
  shape: rectangle
  style.fill: "#f3e5f5"
  style.font-color: "#1a1a1a"
}
parse: json.loads(stdout) {shape: rectangle}
result: Return text or structured_output {shape: oval}

endpoint -> to_thread: offload to thread
to_thread -> build
build -> spawn: CLI args
spawn -> parse: JSON envelope
parse -> result
```

The CLI is invoked with flags: `--output-format json`, `--model <tier>`, `--effort <level>`, `--no-session-persistence`, `--tools ""` (disabled), `--max-turns 1`. When `--json-schema` is provided, `--max-turns` is bumped to 2 (the schema validation consumes an internal tool turn).

### Task-Based Model Routing

Endpoints pass a `task` name; the provider resolves it to a model tier and effort level. This prevents every endpoint from needing to know about model selection:

```d2
direction: right

tasks: Task Defaults {
  shape: sql_table
  task: task | model | effort
  classify: classify | haiku | low
  extract_task: extract_task | haiku | low
  extract_entities: extract_entities | sonnet | medium
  summarize: summarize | sonnet | medium
  relationships: extract_relationships | sonnet | medium
  contradiction: check_contradiction | opus | high
  judge: judge | opus | high
  causal: causal_reason | sonnet | high
}

fallback: Fallback Escalation {
  shape: rectangle
  style.fill: "#fff3e0"
  style.font-color: "#1a1a1a"
}

tasks -> fallback: if call fails
```

**Fallback escalation** is automatic: `haiku -> sonnet -> opus`. If a haiku call fails, the provider retries with sonnet. If sonnet fails, it escalates to opus.

---

## 5. Concurrency Under Load

This is how the service handles multiple simultaneous requests:

```d2
direction: down

requests: Concurrent Requests {
  style.fill: "#e3f2fd"
  style.font-color: "#1a1a1a"
  r1: POST /classify {style.font-color: "#1a1a1a"}
  r2: POST /extract-entities {style.font-color: "#1a1a1a"}
  r3: POST /embed/batch (5 texts) {style.font-color: "#1a1a1a"}
  r4: POST /check-contradiction {style.font-color: "#1a1a1a"}
  r5: POST /summarize {style.font-color: "#1a1a1a"}
}

loop: asyncio Event Loop {
  style.fill: "#fff9c4"
  style.font-color: "#1a1a1a"
}

pool: Thread Pool (20 threads) {
  style.fill: "#fce4ec"
  style.font-color: "#1a1a1a"

  t1: T1 - claude haiku (~2s) {style.fill: "#e1bee7"; style.font-color: "#1a1a1a"}
  t2: T2 - claude sonnet (~5s) {style.fill: "#e1bee7"; style.font-color: "#1a1a1a"}
  t3: T3 - ollama embed {style.fill: "#b2dfdb"; style.font-color: "#1a1a1a"}
  t4: T4 - ollama embed {style.fill: "#b2dfdb"; style.font-color: "#1a1a1a"}
  t5: T5 - ollama embed {style.fill: "#b2dfdb"; style.font-color: "#1a1a1a"}
  t6: T6 - ollama embed {style.fill: "#b2dfdb"; style.font-color: "#1a1a1a"}
  t7: T7 - ollama embed {style.fill: "#b2dfdb"; style.font-color: "#1a1a1a"}
  t8: T8 - claude advocate opus (~10s) {style.fill: "#e1bee7"; style.font-color: "#1a1a1a"}
  t9: T9 - claude defender opus (~10s) {style.fill: "#e1bee7"; style.font-color: "#1a1a1a"}
  t10: T10 - claude sonnet (~5s) {style.fill: "#e1bee7"; style.font-color: "#1a1a1a"}
  t11: T11-20 idle {style.font-color: "#1a1a1a"}
}

requests.r1 -> loop
requests.r2 -> loop
requests.r3 -> loop
requests.r4 -> loop
requests.r5 -> loop

loop -> pool.t1: classify
loop -> pool.t2: extract entities
loop -> pool.t3: embed batch (gather)
loop -> pool.t4: embed batch (gather)
loop -> pool.t5: embed batch (gather)
loop -> pool.t6: embed batch (gather)
loop -> pool.t7: embed batch (gather)
loop -> pool.t8: contradiction advocate
loop -> pool.t9: contradiction defender (parallel)
loop -> pool.t10: summarize
```

All 5 handlers start immediately in the event loop. No request waits for another to finish its async work. The thread pool fans out blocking calls across OS threads.

**Saturation scenario:** With 20 threads and LLM calls averaging 5-10s, the service can sustain ~2-4 concurrent LLM-heavy requests comfortably. A burst of 20+ simultaneous LLM requests would fill the pool; request 21+ would queue. Embedding calls are fast (~100ms) and release threads quickly, so they rarely contribute to saturation.

---

## 6. Contradiction Detection -- Debate Protocol

The most architecturally interesting endpoint. It uses **parallel adversarial LLM calls** followed by a **judge** call:

```d2
direction: down

input: Two Facts {shape: oval}

heuristics: Quick Heuristics {
  shape: diamond
  style.fill: "#fff9c4"
  style.font-color: "#1a1a1a"
}

obvious: Return immediately (no LLM) {
  shape: oval
  style.fill: "#c8e6c9"
  style.font-color: "#1a1a1a"
}

debate: Debate Protocol {
  style.fill: "#e8eaf6"
  style.font-color: "#1a1a1a"

  parallel: asyncio.gather() {
    shape: hexagon
    style.fill: "#bbdefb"
    style.font-color: "#1a1a1a"
  }

  advocate: Advocate (Thread A) {
    shape: rectangle
    style.fill: "#f8bbd0"
    style.font-color: "#1a1a1a"
  }

  defender: Defender (Thread B) {
    shape: rectangle
    style.fill: "#c8e6c9"
    style.font-color: "#1a1a1a"
  }

  judge: Judge (Thread C) {
    shape: rectangle
    style.fill: "#d1c4e9"
    style.font-color: "#1a1a1a"
  }

  parallel -> advocate
  parallel -> defender
  advocate -> judge: argument
  defender -> judge: argument
}

fallback: Single LLM Fallback {
  shape: rectangle
  style.fill: "#fff3e0"
  style.font-color: "#1a1a1a"
}

result: CheckContradictionResponse {shape: oval}

input -> heuristics
heuristics -> obvious: clear case
heuristics -> debate: subtle case
debate.judge -> result
debate -> fallback: exception {style.stroke-dash: 3}
fallback -> result
```

**Quick Heuristics** (no LLM cost):
1. Different subjects? -> no contradiction, return immediately
2. Antonym predicates + overlapping time? -> contradiction
3. Exclusive predicate (e.g. `works_at`) + different objects + overlapping time? -> contradiction

**Debate Protocol** (3 LLM calls, opus tier):
- **Advocate** argues the facts contradict (runs in parallel with Defender)
- **Defender** argues the facts can coexist (runs in parallel with Advocate)
- **Judge** evaluates both arguments and renders a verdict (sequential, after both complete)

**Fallback:** If the debate protocol throws, a single LLM call replaces the 3-phase process.

**Cost:** 3 LLM calls (2 parallel + 1 sequential) for the debate path. The heuristic fast-path avoids LLM calls entirely for obvious cases.

---

## 7. Endpoint Map by Category

```d2
direction: right

ml_service: ML Services v6.0.0 {
  style.fill: "#f5f5f5"
  style.font-color: "#1a1a1a"

  embeddings: Embeddings {
    style.fill: "#e0f2f1"
    style.font-color: "#1a1a1a"
    embed: /embed {style.font-color: "#1a1a1a"}
    batch: /embed/batch {style.font-color: "#1a1a1a"}
  }

  transcription: Transcription {
    style.fill: "#fbe9e7"
    style.font-color: "#1a1a1a"
    transcribe: /transcribe (URL) {style.font-color: "#1a1a1a"}
    upload: /transcribe/upload {style.font-color: "#1a1a1a"}
  }

  llm_light: LLM Light (haiku) {
    style.fill: "#e8f5e9"
    style.font-color: "#1a1a1a"
    classify: /classify {style.font-color: "#1a1a1a"}
    extract_task: /extract-task {style.font-color: "#1a1a1a"}
  }

  llm_medium: LLM Medium (sonnet) {
    style.fill: "#fff3e0"
    style.font-color: "#1a1a1a"
    entities: /extract-entities {style.font-color: "#1a1a1a"}
    resolve: /resolve-entity {style.font-color: "#1a1a1a"}
    relationships: /extract-relationships {style.font-color: "#1a1a1a"}
    reader: /parse-content {style.font-color: "#1a1a1a"}
    summarize: /summarize {style.font-color: "#1a1a1a"}
    chat: /chat {style.font-color: "#1a1a1a"}
    task_enhanced: /extract-task-enhanced {style.font-color: "#1a1a1a"}
    transcript: /parse-transcript {style.font-color: "#1a1a1a"}
    predicates: /compare-predicates {style.font-color: "#1a1a1a"}
  }

  llm_heavy: LLM Heavy (opus / sonnet-high) {
    style.fill: "#fce4ec"
    style.font-color: "#1a1a1a"
    contradiction: /check-contradiction {style.font-color: "#1a1a1a"}
    causal: /causal-reason {style.font-color: "#1a1a1a"}
  }

  parsing: Document Parsing (no LLM) {
    style.fill: "#e8eaf6"
    style.font-color: "#1a1a1a"
    pdf: /parse-document {style.font-color: "#1a1a1a"}
    markdown: /parse-markdown {style.font-color: "#1a1a1a"}
  }

  web: Web Scraping {
    style.fill: "#efebe9"
    style.font-color: "#1a1a1a"
    scrape: /scrape {style.font-color: "#1a1a1a"}
  }
}
```

| Category | Provider | Typical Latency |
|----------|----------|----------------|
| **Embeddings** | Ollama (`nomic-embed-text`, 768D) | ~100ms |
| **Transcription** | faster-whisper (CPU, int8) | seconds-minutes depending on audio length |
| **LLM Light** | Claude haiku, effort: low | ~1-2s |
| **LLM Medium** | Claude sonnet, effort: medium | ~3-8s |
| **LLM Heavy** | Claude opus/sonnet, effort: high | ~5-30s (debate: 3 calls) |
| **Document Parsing** | PyMuPDF / python-docx (no LLM) | <100ms |
| **Web Scraping** | httpx + readability-lxml (max 5MB) | ~1-5s (network bound) |

---

## 8. Graceful Degradation Strategy

Multiple endpoints implement fallback chains so the service degrades rather than fails:

```d2
direction: down

request: Incoming Request {shape: oval}

primary: Primary Path (full LLM) {
  style.fill: "#c8e6c9"
  style.font-color: "#1a1a1a"
}

fallback_1: Fallback 1 - Model Escalation {
  style.fill: "#fff9c4"
  style.font-color: "#1a1a1a"
}

fallback_2: Fallback 2 - Heuristic or Pattern {
  style.fill: "#ffe0b2"
  style.font-color: "#1a1a1a"
}

fallback_3: Fallback 3 - Error Response {
  style.fill: "#ffcdd2"
  style.font-color: "#1a1a1a"
}

request -> primary
primary -> fallback_1: LLM error {style.stroke-dash: 3}
fallback_1 -> fallback_2: all models fail {style.stroke-dash: 3}
fallback_2 -> fallback_3: heuristics fail {style.stroke-dash: 3}
```

**Fallback 1 -- Model Escalation:** `haiku -> sonnet -> opus`. Automatic via `FALLBACK_MAP` in `llm.py`.

**Fallback 2 -- Heuristic/Pattern extraction:**
- `/parse-content` (reader): quick heuristic extraction without LLM
- `/extract-relationships`: regex pattern matching for common relationship forms
- `/parse-transcript`: format detection + structural parsing
- `/check-contradiction`: single LLM call instead of debate protocol

**Fallback 3 -- Error responses:** `502` (LLM unavailable), `504` (timeout), `500` (unexpected)

---

## 9. External Dependencies

```d2
direction: right

ml: ML Services (port 8000) {
  shape: rectangle
  style.fill: "#fff3e0"
  style.font-color: "#1a1a1a"
}

claude: Claude Code CLI {
  shape: rectangle
  style.fill: "#f3e5f5"
  style.font-color: "#1a1a1a"
}

ollama: Ollama Server (port 11434) {
  shape: cylinder
  style.fill: "#e0f2f1"
  style.font-color: "#1a1a1a"
}

whisper: faster-whisper (in-process) {
  shape: rectangle
  style.fill: "#fbe9e7"
  style.font-color: "#1a1a1a"
}

platform: Platform Service (Node.js) {
  shape: rectangle
  style.fill: "#e8f4fd"
  style.font-color: "#1a1a1a"
}

mcp: Causal MCP Server (Node.js) {
  shape: rectangle
  style.fill: "#e8eaf6"
  style.font-color: "#1a1a1a"
}

platform -> ml: HTTP/JSON (all endpoints)
ml -> claude: subprocess.run() per LLM call
ml -> ollama: HTTP (embeddings only)
ml -> whisper: Python call (transcription only)
claude -> mcp: MCP protocol (causal-reason only) {style.stroke-dash: 3}
```

| Dependency | Connection | Lifecycle |
|-----------|-----------|-----------|
| **Claude Code CLI** | Subprocess per call, no persistent connection | Must be on PATH and authenticated. Timeout: 300s configurable. |
| **Ollama** | HTTP client, connection pooled via SDK | Must be running with `nomic-embed-text` model pulled. Client timeout: 1200s. |
| **faster-whisper** | In-process Python | Lazy-loaded on first `/transcribe` call. Model `small` held in memory (~300MB) for process lifetime. |
| **Platform Service** | Inbound HTTP caller | Primary consumer at `http://localhost:8000`. |
| **Causal MCP Server** | Connected by Claude CLI via `--mcp-config` | Only used for `/causal-reason` endpoint. Claude Code connects to MCP server for knowledge graph tool calls. |

---

## 10. Deployment & Configuration

### Environment Variables

| Variable | Default | Controls |
|----------|---------|----------|
| `LLM_PROVIDER` | `claude` | LLM backend: `claude` (CLI) or `zai` (HTTP) |
| `OLLAMA_HOST` | `http://localhost:11434` | Ollama embedding server URL |
| `EMBED_MODEL` | `nomic-embed-text` | Embedding model name |
| `ZAI_API_KEY` | (none) | Required only if `LLM_PROVIDER=zai` |

### Resource Limits

| Resource | Limit | Configurable |
|----------|-------|-------------|
| Thread pool workers | 20 | Code change only (`main.py:48`) |
| LLM subprocess timeout | 300s | Per-call via `options.timeout` |
| Ollama client timeout | 1200s | Code change only (`embed.py:15`) |
| Web scrape content | 5MB | Code change only |
| Summarize input | 8000 chars | Code change only |

### Running Locally

```bash
make ml
# Equivalent to:
# cd ml-services && uv venv --python 3.11 .venv
# uv pip install -r requirements.txt
# uvicorn app.main:app --host 0.0.0.0 --port 8000 --http h11 --reload
```

### Docker (legacy profile)

```bash
docker compose --profile legacy up ml-services
```

Single container, no horizontal scaling configured. The `--profile legacy` flag indicates the preferred path is host-native via `make ml`.

---

## 11. Pressure Points & Scaling Characteristics

| Scenario | Bottleneck | Behavior |
|----------|-----------|----------|
| Many concurrent LLM calls (>20) | Thread pool exhaustion | Requests queue; event loop stays responsive for health checks |
| Long LLM calls (debate protocol) | 3 threads held for 10-30s each | Reduces available threads by 3 per contradiction check |
| Burst of embedding requests | Ollama throughput | Ollama is single-model, single-GPU; requests serialize at Ollama level even if threads are available |
| Whisper transcription | CPU-bound in-process | Blocks one thread for duration; model is ~300MB in memory |
| Mixed workload | Claude CLI subprocess spawning | Each LLM call spawns a full process; OS process table and memory are the limits |

### What is NOT a bottleneck

- **The event loop** -- it never blocks. Even under full thread pool saturation, it accepts connections and returns health checks.
- **Memory** -- models are external (Ollama, Claude CLI). Only Whisper lives in-process (~300MB).
- **Network** -- all backends are local (localhost ports or subprocesses). No remote API latency except Z.AI fallback.

### Scaling options (not currently implemented)

- **Uvicorn workers:** Add `--workers N` to run N processes, each with its own 20-thread pool. Linear scaling for CPU-bound work.
- **External thread pool tuning:** Increase from 20 if LLM call volume grows; diminishing returns past ~50 due to subprocess overhead.
- **Horizontal scaling:** The service is stateless -- put it behind a load balancer and run multiple instances.
