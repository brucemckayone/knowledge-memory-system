from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .embed import router as embed_router
from .transcribe import router as transcribe_router
from .classify import router as classify_router
from .scrape import router as scrape_router
from .summarize import router as summarize_router
from .extract_task import router as extract_task_router
# Phase 3
from .extract_entities import router as extract_entities_router
from .check_contradiction import router as check_contradiction_router
# Phase 4
from .reader import router as reader_router
from .relationships import router as relationships_router

app = FastAPI(
    title="Cognitive ML Services",
    version="4.0.0",
    description="ML endpoints for the Cognitive Platform (Phase 4)"
)

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
# Phase 3
app.include_router(extract_entities_router, tags=["Entity Extraction"])
app.include_router(check_contradiction_router, tags=["Contradiction Detection"])
# Phase 4
app.include_router(reader_router, tags=["Content Reader"])
app.include_router(relationships_router, tags=["Relationship Extraction"])


@app.get("/health")
def health():
    """Health check endpoint"""
    return {
        "status": "ok",
        "service": "ml-services",
        "version": "4.0.0",
        "endpoints": [
            "embed",
            "transcribe",
            "classify",
            "scrape",
            "summarize",
            "extract-task",
            "extract-entities",
            "check-contradiction",
            "parse-content",
            "extract-relationships"
        ]
    }


@app.get("/")
def root():
    """Root endpoint with API info"""
    return {
        "name": "Cognitive ML Services",
        "version": "4.0.0",
        "phase": 4,
        "endpoints": {
            "health": "/health",
            "embed": "/embed",
            "transcribe": "/transcribe",
            "classify": "/classify",
            "scrape": "/scrape",
            "summarize": "/summarize",
            "extract_task": "/extract-task",
            "extract_entities": "/extract-entities",
            "resolve_entity": "/resolve-entity",
            "check_contradiction": "/check-contradiction",
            "parse_content": "/parse-content",
            "extract_relationships": "/extract-relationships"
        }
    }

