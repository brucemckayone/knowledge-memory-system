import os
from typing import List
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from openai import OpenAI

router = APIRouter()

# Z.AI API key
ZAI_API_KEY = os.getenv("ZAI_API_KEY")
if not ZAI_API_KEY:
    raise ValueError("ZAI_API_KEY environment variable is required")

# Configure Z.AI embedding client
# Note: Embeddings use a different base URL than chat completions
embedding_client = OpenAI(
    api_key=ZAI_API_KEY,
    base_url="https://open.bigmodel.cn/api/paas/v4/"
)


class EmbedRequest(BaseModel):
    """Request body for embedding generation"""
    text: str
    model: str = "embedding-3"


class EmbedResponse(BaseModel):
    """Response body with embedding vector"""
    vector: List[float]
    model: str
    dimensions: int


class BatchEmbedRequest(BaseModel):
    """Request body for batch embedding"""
    texts: List[str]
    model: str = "embedding-3"


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

    Uses Z.AI's embedding-3 model with configurable dimensions.
    Default: 768 dimensions (matches previous nomic-embed-text).
    """
    try:
        # Always use embedding-3 model
        model = "embedding-3"

        response = embedding_client.embeddings.create(
            model=model,
            input=request.text,
            dimensions=768  # Match previous nomic-embed-text dimensions
        )

        vector = response.data[0].embedding

        return EmbedResponse(
            vector=vector,
            model=model,
            dimensions=len(vector)
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

    Z.AI supports true batch requests (more efficient than Ollama's sequential approach).
    """
    try:
        model = "embedding-3"

        response = embedding_client.embeddings.create(
            model=model,
            input=request.texts,
            dimensions=768
        )

        embeddings = [item.embedding for item in response.data]
        dimensions = len(embeddings[0]) if embeddings else 0

        return BatchEmbedResponse(
            embeddings=embeddings,
            model=model,
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
    return {
        "models": ["embedding-3"],
        "default_dimensions": [512, 768, 1024, 1536]
    }
