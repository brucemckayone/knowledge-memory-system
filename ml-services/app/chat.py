"""
Chat Endpoint
Simple conversational AI endpoint for Telegram bot integration.
"""

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from .core.llm import llm_client

router = APIRouter()


class ChatRequest(BaseModel):
    """Request body for chat"""
    message: str
    system_prompt: str = "You are a helpful AI assistant for a knowledge management system. You help users capture thoughts, tasks, and information naturally."


class ChatResponse(BaseModel):
    """Response from chat endpoint"""
    response: str


@router.post("/chat", response_model=ChatResponse)
async def chat(request: ChatRequest):
    """
    Process a chat message and return AI response.

    Simple conversational endpoint for Telegram bot integration.
    Returns natural language responses to user queries.
    """
    try:
        response = llm_client.generate(
            prompt=request.message,
            options={
                "task": "chat",
                "system_prompt": request.system_prompt,
            }
        )

        return ChatResponse(response=response)

    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Chat LLM request failed: {str(e)}")