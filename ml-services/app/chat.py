"""
Chat Endpoint
Simple conversational AI endpoint for Telegram bot integration.
"""

from fastapi import APIRouter
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
                "temperature": 0.7,  # Higher temperature for more natural conversation
                "num_predict": 1024,  # Allow longer responses
            }
        )

        return ChatResponse(response=response)

    except Exception as e:
        # Return error as response instead of raising HTTPException
        # This makes it easier for the bot to handle
        return ChatResponse(response=f"Sorry, I encountered an error: {str(e)}")


@router.get("/chat/health")
async def health_check():
    """Health check for chat endpoint"""
    return {"status": "healthy", "service": "chat"}
