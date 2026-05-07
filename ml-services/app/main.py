import asyncio
import sys
import os
from concurrent.futures import ThreadPoolExecutor

# Fix Windows console encoding for emoji in log output
if sys.platform == "win32":
    os.environ.setdefault("PYTHONIOENCODING", "utf-8")
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    if hasattr(sys.stderr, "reconfigure"):
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .embed import router as embed_router
from .transcribe import router as transcribe_router
from .classify import router as classify_router
from .scrape import router as scrape_router
from .summarize import router as summarize_router
from .extract_task import router as extract_task_router
from .chat import router as chat_router
# Phase 3
from .extract_entities import router as extract_entities_router
from .check_contradiction import router as check_contradiction_router
# Phase 4
from .reader import router as reader_router
from .relationships import router as relationships_router
# Phase 5
from .extract_task_enhanced import router as extract_task_enhanced_router
# Phase 6
from .parse_transcript import router as parse_transcript_router
from .parse_document import router as parse_document_router
from .parse_markdown import router as parse_markdown_router
from .compare_predicates import router as compare_predicates_router
from .causal_reason import router as causal_reason_router
from .extract_agentic import router as extract_agentic_router
from .graph_agent import router as graph_agent_router
from .reconciliation_agent import router as reconciliation_agent_router
from .gardener_agent import router as gardener_agent_router
from .reasoning_agent import router as reasoning_agent_router
from .core.llm import LLM_PROVIDER
from .core.concurrency import ollama_pool, llm_pool, THREAD_POOL_SIZE

app = FastAPI(
    title="Cognitive ML Services",
    version="6.0.0",
    description="ML endpoints for the Cognitive Platform (Phase 6: Multi-Source)"
)

# Expand the default asyncio thread pool so concurrent blocking calls
# (LLM subprocess, Ollama HTTP) don't exhaust it.  Default is only ~5 threads.
_thread_pool = ThreadPoolExecutor(max_workers=THREAD_POOL_SIZE)


@app.on_event("startup")
async def _set_thread_pool() -> None:
    loop = asyncio.get_running_loop()
    loop.set_default_executor(_thread_pool)


# CORS for local development
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Include all routers
app.include_router(embed_router, tags=["Embeddings"])
app.include_router(transcribe_router, tags=["Transcription"])
app.include_router(classify_router, tags=["Classification"])
app.include_router(scrape_router, tags=["Web Scraping"])
app.include_router(summarize_router, tags=["Summarization"])
app.include_router(extract_task_router, tags=["Task Extraction"])
app.include_router(chat_router, tags=["Chat"])
# Phase 3
app.include_router(extract_entities_router, tags=["Entity Extraction"])
app.include_router(check_contradiction_router, tags=["Contradiction Detection"])
# Phase 4
app.include_router(reader_router, tags=["Content Reader"])
app.include_router(relationships_router, tags=["Relationship Extraction"])
# Phase 5
app.include_router(extract_task_enhanced_router, tags=["Enhanced Task Extraction"])
# Phase 6
app.include_router(parse_transcript_router, tags=["Transcript Parsing"])
app.include_router(parse_document_router, tags=["Document Parsing"])
app.include_router(parse_markdown_router, tags=["Markdown Parsing"])
app.include_router(compare_predicates_router, tags=["Predicate Comparison"])
# Phase B: Graph C
app.include_router(causal_reason_router, tags=["Causal Reasoning"])
# Agentic extraction
app.include_router(extract_agentic_router, tags=["Agentic Extraction"])
# Unified graph agent
app.include_router(graph_agent_router, tags=["Graph Agent"])
# Reconciliation agent
app.include_router(reconciliation_agent_router, tags=["Reconciliation Agent"])
# Graph gardener
app.include_router(gardener_agent_router, tags=["Graph Gardener"])
app.include_router(reasoning_agent_router, tags=["Reasoning Agent"])
# Phase 2: Topology primitives (T0)
from .topology import router as topology_router
app.include_router(topology_router, tags=["Topology"])


@app.get("/health")
async def health():
    """Health check endpoint with concurrency stats"""
    return {
        "status": "ok",
        "provider": LLM_PROVIDER,
        "service": "ml-services",
        "version": "6.0.0",
        "phase": 6,
        "concurrency": {
            "ollama": ollama_pool.stats,
            "llm": llm_pool.stats,
        },
        "endpoints": [
            "embed",
            "transcribe",
            "classify",
            "scrape",
            "summarize",
            "extract-task",
            "chat",
            "extract-task-enhanced",
            "extract-entities",
            "check-contradiction",
            "parse-content",
            "extract-relationships",
            "parse-transcript",
            "parse-document",
            "parse-markdown",
            "compare-predicates",
            "causal-reason"
        ]
    }


@app.get("/")
def root():
    """Root endpoint with API info"""
    return {
        "name": "Cognitive ML Services",
        "version": "6.0.0",
        "phase": 6,
        "endpoints": {
            "health": "/health",
            "embed": "/embed",
            "transcribe": "/transcribe",
            "classify": "/classify",
            "scrape": "/scrape",
            "summarize": "/summarize",
            "extract_task": "/extract-task",
            "chat": "/chat",
            "extract_task_enhanced": "/extract-task-enhanced",
            "extract_entities": "/extract-entities",
            "resolve_entity": "/resolve-entity",
            "check_contradiction": "/check-contradiction",
            "parse_content": "/parse-content",
            "extract_relationships": "/extract-relationships",
            "parse_transcript": "/parse-transcript",
            "parse_document": "/parse-document",
            "parse_markdown": "/parse-markdown",
            "compare_predicates": "/compare-predicates"
        }
    }

