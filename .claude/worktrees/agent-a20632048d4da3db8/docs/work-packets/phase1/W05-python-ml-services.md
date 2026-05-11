# Work Packet W05: Python ML Services

**Status:** ⚠️ PARTIAL (Embedding works, Transcription disabled)  
**Completed:** 2026-01-24  
**Dependencies:** W02 (Docker)  
**Estimated Time:** 1-2 hours

---

## Implementation Progress

| Item | Status | Notes |
|------|--------|-------|
| app/main.py | ✅ Done | FastAPI with routers |
| app/embed.py | ✅ Done | Ollama embedding working |
| app/transcribe.py | ⚠️ Partial | Returns 503 (Whisper disabled) |
| /health endpoint | ✅ Done | |
| /embed endpoint | ✅ Done | 768-dim vectors |
| /embed/batch endpoint | ✅ Done | |
| /embed/models endpoint | ✅ Done | |
| /transcribe endpoint | ❌ Disabled | faster-whisper build failed |
| /transcribe/upload endpoint | ❌ Disabled | faster-whisper build failed |
| /transcribe/status endpoint | ✅ Done | Reports availability |
| Docker container | ✅ Done | Builds successfully |

### Known Issues
- **faster-whisper build failure:** PyAV requires FFmpeg development headers. Attempted to add libav packages but build still failed.
- **Workaround:** Transcription endpoint returns 503 with helpful message. Text capture works fully.

### Deviations from Spec
- Removed `faster-whisper` from requirements.txt to allow build to succeed
- Added graceful fallback in transcribe.py for missing Whisper
- httpx version pinned to 0.25.2 (compatibility with ollama 0.1.6)

### Future Fix Options
1. Use pre-built Docker image with Whisper already installed
2. Use OpenAI Whisper API instead of local
3. Use whisper.cpp as alternative implementation

---

## Objective

Create FastAPI service with embedding and transcription endpoints using Ollama and faster-whisper.

---

## Prerequisites

- [ ] W02 completed (Docker running)
- [ ] Ollama running on host with models:
  - `nomic-embed-text`
  - `llama3`

Verify models:
```bash
ollama list
```

---

## Step 1: Create FastAPI Application

### ml-services/app/main.py

```python
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
```

---

## Step 2: Create Embedding Endpoint

### ml-services/app/embed.py

```python
import os
from typing import List, Optional
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
import ollama

router = APIRouter()

# Ollama host (host.docker.internal for Docker on Mac)
OLLAMA_HOST = os.getenv("OLLAMA_HOST", "http://localhost:11434")

# Configure ollama client
ollama_client = ollama.Client(host=OLLAMA_HOST)


class EmbedRequest(BaseModel):
    """Request body for embedding generation"""
    text: str
    model: str = "nomic-embed-text"


class EmbedResponse(BaseModel):
    """Response body with embedding vector"""
    vector: List[float]
    model: str
    dimensions: int


class BatchEmbedRequest(BaseModel):
    """Request body for batch embedding"""
    texts: List[str]
    model: str = "nomic-embed-text"


class BatchEmbedResponse(BaseModel):
    """Response body with multiple embeddings"""
    embeddings: List[List[float]]
    model: str
    dimensions: int
    count: int


@router.post("/embed", response_model=EmbedResponse)
def embed(request: EmbedRequest):
    """
    Generate embedding vector for text.
    
    Uses Ollama's embedding API with the specified model.
    Default model: nomic-embed-text (768 dimensions)
    """
    try:
        response = ollama_client.embeddings(
            model=request.model,
            prompt=request.text
        )
        
        vector = response["embedding"]
        
        return EmbedResponse(
            vector=vector,
            model=request.model,
            dimensions=len(vector)
        )
        
    except ollama.ResponseError as e:
        raise HTTPException(
            status_code=500,
            detail=f"Ollama error: {str(e)}"
        )
    except Exception as e:
        raise HTTPException(
            status_code=500,
            detail=f"Embedding failed: {str(e)}"
        )


@router.post("/embed/batch", response_model=BatchEmbedResponse)
def embed_batch(request: BatchEmbedRequest):
    """
    Generate embeddings for multiple texts.
    
    Processes texts sequentially (Ollama doesn't support batch).
    """
    try:
        embeddings = []
        dimensions = 0
        
        for text in request.texts:
            response = ollama_client.embeddings(
                model=request.model,
                prompt=text
            )
            vector = response["embedding"]
            embeddings.append(vector)
            dimensions = len(vector)
        
        return BatchEmbedResponse(
            embeddings=embeddings,
            model=request.model,
            dimensions=dimensions,
            count=len(embeddings)
        )
        
    except Exception as e:
        raise HTTPException(
            status_code=500,
            detail=f"Batch embedding failed: {str(e)}"
        )


@router.get("/embed/models")
def list_models():
    """List available embedding models"""
    try:
        models = ollama_client.list()
        embedding_models = [
            m["name"] for m in models.get("models", [])
            if "embed" in m["name"].lower()
        ]
        return {"models": embedding_models}
    except Exception as e:
        raise HTTPException(
            status_code=500,
            detail=f"Failed to list models: {str(e)}"
        )
```

---

## Step 3: Create Transcription Endpoint

### ml-services/app/transcribe.py

```python
import os
import tempfile
from typing import Optional
from fastapi import APIRouter, HTTPException, UploadFile, File
from pydantic import BaseModel
import httpx

router = APIRouter()

# Lazy load whisper model
_whisper_model = None


def get_whisper_model():
    """Lazy load the Whisper model"""
    global _whisper_model
    if _whisper_model is None:
        from faster_whisper import WhisperModel
        # Use 'small' model for balance of speed and accuracy
        # compute_type='int8' for faster inference on CPU
        _whisper_model = WhisperModel(
            "small",
            device="cpu",
            compute_type="int8"
        )
        print("✅ Whisper model loaded")
    return _whisper_model


class TranscribeUrlRequest(BaseModel):
    """Request body for URL-based transcription"""
    audio_url: str
    language: Optional[str] = None


class TranscribeResponse(BaseModel):
    """Response body with transcription"""
    text: str
    language: str
    duration_ms: int
    segments: Optional[list] = None


@router.post("/transcribe", response_model=TranscribeResponse)
async def transcribe_url(request: TranscribeUrlRequest):
    """
    Transcribe audio from URL.
    
    Downloads the audio file and transcribes using faster-whisper.
    Supports: mp3, wav, ogg, m4a, webm
    """
    try:
        # Download audio file
        async with httpx.AsyncClient() as client:
            response = await client.get(request.audio_url, follow_redirects=True)
            response.raise_for_status()
            audio_data = response.content
        
        # Save to temp file
        with tempfile.NamedTemporaryFile(suffix=".ogg", delete=False) as f:
            f.write(audio_data)
            temp_path = f.name
        
        try:
            # Transcribe
            model = get_whisper_model()
            segments, info = model.transcribe(
                temp_path,
                language=request.language,
                beam_size=5,
                vad_filter=True
            )
            
            # Collect results
            text_parts = []
            segment_list = []
            
            for segment in segments:
                text_parts.append(segment.text)
                segment_list.append({
                    "start": segment.start,
                    "end": segment.end,
                    "text": segment.text.strip()
                })
            
            full_text = " ".join(text_parts).strip()
            duration_ms = int(info.duration * 1000)
            
            return TranscribeResponse(
                text=full_text,
                language=info.language,
                duration_ms=duration_ms,
                segments=segment_list
            )
            
        finally:
            # Clean up temp file
            os.unlink(temp_path)
            
    except httpx.HTTPError as e:
        raise HTTPException(
            status_code=400,
            detail=f"Failed to download audio: {str(e)}"
        )
    except Exception as e:
        raise HTTPException(
            status_code=500,
            detail=f"Transcription failed: {str(e)}"
        )


@router.post("/transcribe/upload", response_model=TranscribeResponse)
async def transcribe_upload(file: UploadFile = File(...)):
    """
    Transcribe uploaded audio file.
    
    Supports: mp3, wav, ogg, m4a, webm
    """
    try:
        # Get file extension
        ext = os.path.splitext(file.filename or "audio.ogg")[1]
        
        # Save uploaded file
        with tempfile.NamedTemporaryFile(suffix=ext, delete=False) as f:
            content = await file.read()
            f.write(content)
            temp_path = f.name
        
        try:
            # Transcribe
            model = get_whisper_model()
            segments, info = model.transcribe(
                temp_path,
                beam_size=5,
                vad_filter=True
            )
            
            # Collect results
            text_parts = []
            for segment in segments:
                text_parts.append(segment.text)
            
            full_text = " ".join(text_parts).strip()
            duration_ms = int(info.duration * 1000)
            
            return TranscribeResponse(
                text=full_text,
                language=info.language,
                duration_ms=duration_ms
            )
            
        finally:
            os.unlink(temp_path)
            
    except Exception as e:
        raise HTTPException(
            status_code=500,
            detail=f"Transcription failed: {str(e)}"
        )
```

---

## Step 4: Update Requirements

### ml-services/requirements.txt

```
# Web framework
fastapi==0.109.0
uvicorn[standard]==0.27.0
pydantic==2.5.3

# ML / AI
ollama==0.1.6
faster-whisper==0.10.0

# HTTP client (for downloading audio)
httpx==0.26.0

# File uploads
python-multipart==0.0.6
```

---

## Step 5: Update Dockerfile

### ml-services/Dockerfile

```dockerfile
FROM python:3.11-slim

WORKDIR /app

# Install system dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    libsndfile1 \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Copy requirements first for caching
COPY requirements.txt .

# Install Python dependencies
RUN pip install --no-cache-dir -r requirements.txt

# Download whisper model on build (optional, can be slow)
# RUN python -c "from faster_whisper import WhisperModel; WhisperModel('small', device='cpu')"

# Copy application
COPY app/ ./app/

# Set environment
ENV PYTHONUNBUFFERED=1
ENV PYTHONDONTWRITEBYTECODE=1
ENV OLLAMA_HOST=http://host.docker.internal:11434

EXPOSE 8000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
  CMD curl -f http://localhost:8000/health || exit 1

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
```

---

## Step 6: Build and Test

```bash
# Rebuild ML services
docker compose build ml-services

# Start
docker compose up -d ml-services

# Check logs
docker compose logs -f ml-services
```

---

## Step 7: Test Endpoints

### Test Health
```bash
curl http://localhost:8000/health
```

### Test Embedding
```bash
curl -X POST http://localhost:8000/embed \
  -H "Content-Type: application/json" \
  -d '{"text": "Hello, this is a test message for embedding"}'
```

Expected response:
```json
{
  "vector": [0.123, -0.456, ...],
  "model": "nomic-embed-text",
  "dimensions": 768
}
```

### Test Batch Embedding
```bash
curl -X POST http://localhost:8000/embed/batch \
  -H "Content-Type: application/json" \
  -d '{"texts": ["First text", "Second text"]}'
```

### Test Transcription (with file upload)
```bash
# First, get a sample audio file
curl -o test.mp3 "https://www2.cs.uic.edu/~i101/SoundFiles/gettysburg.wav"

# Then transcribe
curl -X POST http://localhost:8000/transcribe/upload \
  -F "file=@test.mp3"
```

---

## Acceptance Criteria

- [x] `app/main.py` runs without errors
- [x] `app/embed.py` compiles without errors
- [x] `app/transcribe.py` compiles without errors *(graceful fallback)*
- [x] Docker container builds successfully
- [x] `/health` returns 200
- [x] `/embed` returns 768-dimensional vector
- [x] `/embed/batch` returns multiple vectors
- [ ] `/transcribe/upload` transcribes audio file *(BLOCKED: Whisper disabled)*
- [ ] Whisper model loads on first transcription *(BLOCKED: build issues)*

---

## Next Packet

After completing W05, proceed to [W06-telegram-bot.md](./W06-telegram-bot.md).
