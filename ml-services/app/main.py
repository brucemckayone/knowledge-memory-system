from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .embed import router as embed_router
from .transcribe import router as transcribe_router

app = FastAPI(
    title="Cognitive ML Services",
    version="0.1.0",
    description="Embedding and transcription services for Cognitive Platform"
)

# CORS for local development
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Include routers
app.include_router(embed_router, tags=["Embeddings"])
app.include_router(transcribe_router, tags=["Transcription"])


@app.get("/health")
def health():
    """Health check endpoint"""
    return {
        "status": "ok",
        "service": "ml-services",
        "version": "0.1.0"
    }


@app.get("/")
def root():
    """Root endpoint with API info"""
    return {
        "name": "Cognitive ML Services",
        "endpoints": {
            "health": "/health",
            "embed": "/embed",
            "transcribe": "/transcribe"
        }
    }
