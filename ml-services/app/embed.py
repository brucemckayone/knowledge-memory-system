import asyncio
import os
from typing import List
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
import ollama

router = APIRouter()

# Ollama host (host.docker.internal for Docker on Mac)
OLLAMA_HOST = os.getenv("OLLAMA_HOST", "http://localhost:11434")
EMBED_MODEL = os.getenv("EMBED_MODEL", "nomic-embed-text")

# Configure ollama client
ollama_client = ollama.Client(host=OLLAMA_HOST, timeout=1200.0)


class EmbedRequest(BaseModel):
    """Request body for embedding generation"""
    text: str
    model: str = EMBED_MODEL


class EmbedResponse(BaseModel):
    """Response body with embedding vector"""
    vector: List[float]
    model: str
    dimensions: int


class BatchEmbedRequest(BaseModel):
    """Request body for batch embedding"""
    texts: List[str]
    model: str = EMBED_MODEL


class BatchEmbedResponse(BaseModel):
    """Response body with multiple embeddings"""
    embeddings: List[List[float]]
    model: str
    dimensions: int
    count: int


@router.post("/embed", response_model=EmbedResponse)
async def embed(request: EmbedRequest):
    """
    Generate embedding vector for text.

    Uses Ollama's embedding API with the specified model.
    Default model: nomic-embed-text (768 dimensions)
    """
    try:
        response = await asyncio.to_thread(
            ollama_client.embeddings,
            model=request.model,
            prompt=request.text,
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
async def embed_batch(request: BatchEmbedRequest):
    """
    Generate embeddings for multiple texts.

    Processes texts concurrently via thread pool (Ollama doesn't support batch).
    """
    try:
        async def _embed_one(text: str) -> List[float]:
            response = await asyncio.to_thread(
                ollama_client.embeddings,
                model=request.model,
                prompt=text,
            )
            return response["embedding"]

        vectors = await asyncio.gather(*[_embed_one(t) for t in request.texts])
        dimensions = len(vectors[0]) if vectors else 0

        return BatchEmbedResponse(
            embeddings=list(vectors),
            model=request.model,
            dimensions=dimensions,
            count=len(vectors)
        )

    except Exception as e:
        raise HTTPException(
            status_code=500,
            detail=f"Batch embedding failed: {str(e)}"
        )
