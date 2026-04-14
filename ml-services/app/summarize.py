from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from typing import List
import re
from .core.llm import llm_client
from .core.concurrency import llm_pool, QueueFullError

router = APIRouter()

# Max content length for summarization (to fit in context)
MAX_CONTENT_LENGTH = 8000

SUMMARIZE_PROMPT = """Summarize the following article.

Title: {title}

Content:
{content}

Return a JSON object with:
- "summary": 2-3 concise sentences summarizing the article
- "key_points": array of 3-5 key point strings
"""


class SummarizeRequest(BaseModel):
    """Request body for summarization"""
    content: str
    title: str = "Untitled"


class SummarizeResponse(BaseModel):
    """Summarization result"""
    summary: str
    key_points: List[str]
    word_count: int



@router.post("/summarize", response_model=SummarizeResponse)
async def summarize_content(request: SummarizeRequest):
    """
    Summarize text content using LLM.

    Returns a concise summary and key points.
    Uses llama3.2 for summary quality.
    """
    try:
        # Truncate content if too long
        content = request.content[:MAX_CONTENT_LENGTH]
        if len(request.content) > MAX_CONTENT_LENGTH:
            content += "\n\n[Content truncated...]"

        # Build prompt
        prompt = SUMMARIZE_PROMPT.format(
            title=request.title,
            content=content
        )

        print(f"📝 Summarizing: {request.title}")

        # Call LLM Service (via work queue)
        result = await llm_pool.submit(
            llm_client.generate_json, prompt, None, {"task": "summarize"},
        )

        summary = result.get("summary", content[:200].strip())
        key_points = result.get("key_points", [])

        # Fallback: split summary into sentences if no key points returned
        if not key_points:
            sentences = re.split(r'[.!?]\s+', summary)
            key_points = [s.strip() for s in sentences[:3] if s.strip()]

        print(f"✅ Summary: {len(summary)} chars, {len(key_points)} points")

        return SummarizeResponse(
            summary=summary,
            key_points=key_points,
            word_count=len(content.split())
        )

    except Exception as e:
        print(f"❌ Summarize error: {e}")
        raise HTTPException(
            status_code=500,
            detail=f"Summarization failed: {str(e)}"
        )
