from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .embed import router as embed_router
from .transcribe import router as transcribe_router
from .classify import router as classify_router
from .scrape import router as scrape_router
from .summarize import router as summarize_router
from .extract_task import router as extract_task_router

app = FastAPI(
    title="Cognitive ML Services",
    version="2.0.0",
    description="ML endpoints for the Cognitive Platform (Phase 2)"
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


@app.get("/health")
def health():
    """Health check endpoint"""
    return {
        "status": "ok",
        "service": "ml-services",
        "version": "2.0.0",
        "endpoints": [
            "embed",
            "transcribe",
            "classify",
            "scrape",
            "summarize",
            "extract-task"
        ]
    }


@app.get("/")
def root():
    """Root endpoint with API info"""
    return {
        "name": "Cognitive ML Services",
        "version": "2.0.0",
        "phase": 2,
        "endpoints": {
            "health": "/health",
            "embed": "/embed",
            "transcribe": "/transcribe",
            "transcribe_status": "/transcribe/status",
            "classify": "/classify",
            "classify_test": "/classify/test",
            "scrape": "/scrape",
            "scrape_test": "/scrape/test",
            "summarize": "/summarize",
            "summarize_test": "/summarize/test",
            "extract_task": "/extract-task",
            "extract_task_test": "/extract-task/test"
        }
    }
