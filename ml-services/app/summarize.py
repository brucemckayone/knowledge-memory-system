from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from typing import List
import re
from .core.llm import llm_client

router = APIRouter()

# Max content length for summarization (to fit in context)
MAX_CONTENT_LENGTH = 8000

SUMMARIZE_PROMPT = """Summarize the following article in 2-3 concise sentences.
Also extract 3-5 key points as a bullet list.

Title: {title}

Content:
{content}

Format your response as:
SUMMARY: <your 2-3 sentence summary>

KEY POINTS:
- <point 1>
- <point 2>
- <point 3>
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


def parse_summary_response(text: str) -> dict:
    """Parse LLM response into structured format"""
    result = {
        'summary': '',
        'key_points': []
    }

    # Flexible summary header: SUMMARY:, ## Summary, **Summary:**, Summary: etc.
    summary_pattern = r'(?:\#{1,3}\s*)?(?:\*{0,2})summary(?:\*{0,2})\s*:?\s*(.+?)(?=(?:\#{1,3}\s*)?(?:\*{0,2})(?:key\s*points?|main\s*points?|highlights?|takeaways?)(?:\*{0,2})\s*:?|$)'
    summary_match = re.search(summary_pattern, text, re.DOTALL | re.IGNORECASE)
    if summary_match:
        result['summary'] = summary_match.group(1).strip()
    else:
        # Fallback: use first paragraph
        lines = text.strip().split('\n')
        result['summary'] = lines[0] if lines else text[:200]

    # Flexible key points header
    key_points_pattern = r'(?:\#{1,3}\s*)?(?:\*{0,2})(?:key\s*points?|main\s*points?|highlights?|takeaways?)(?:\*{0,2})\s*:?\s*(.+)'
    key_points_match = re.search(key_points_pattern, text, re.DOTALL | re.IGNORECASE)
    if key_points_match:
        points_text = key_points_match.group(1)
        # Match bullets (- * •) and numbered lists (1. 1) )
        points = re.findall(r'(?:[-•*]|\d+[.)]\s*)\s*(.+?)(?=\n(?:[-•*]|\d+[.)])\s|\Z)', points_text, re.DOTALL)
        result['key_points'] = [p.strip() for p in points if p.strip()]

    # Fallback if no key points found
    if not result['key_points']:
        # Try to extract sentences as points
        sentences = re.split(r'[.!?]\s+', result['summary'])
        result['key_points'] = [s.strip() for s in sentences[:3] if s.strip()]

    return result


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

        # Call LLM Service
        # We don't use generate_json here because the prompt asks for text format
        response_text = llm_client.generate(
            prompt,
            options={
                "temperature": 0.3,  # Some creativity but mostly factual
                "num_predict": 512,  # Longer output for summary
            }
        )

        # Parse response
        result = parse_summary_response(response_text)

        print(f"✅ Summary: {len(result['summary'])} chars, {len(result['key_points'])} points")

        return SummarizeResponse(
            summary=result['summary'],
            key_points=result['key_points'],
            word_count=len(content.split())
        )

    except Exception as e:
        print(f"❌ Summarize error: {e}")
        raise HTTPException(
            status_code=500,
            detail=f"Summarization failed: {str(e)}"
        )
