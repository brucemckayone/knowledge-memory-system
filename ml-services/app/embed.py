import os
from typing import List
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
