"""
Content Reader/Parser Endpoint
Phase 4: Parse and classify content, extract metadata

W23 Reader Agent uses this to parse memory content.
"""

from fastapi import APIRouter
from pydantic import BaseModel
from typing import Optional, List
import ollama
import json
import re
from datetime import datetime

router = APIRouter()

PARSE_CONTENT_PROMPT = """Analyze this content and extract structured metadata.

CONTENT:
{content}

HINT (if provided): {hint}

Extract the following:
1. Content type: thought, task, link, event, note, question, idea, reference
2. Title: A brief title (max 100 chars) capturing the essence
3. Summary: 1-2 sentence summary
4. Mentions: People, companies, or places mentioned (just names)
5. Dates: Any dates/times mentioned (ISO format or natural language)
6. Links: Any URLs mentioned
7. Tags: Relevant topic tags (lowercase, no #)

Return JSON only:
{{
  "content_type": "...",
  "title": "...",
  "summary": "...",
  "mentions": ["name1", "name2"],
  "dates": ["2024-01-15", "next week"],
  "links": ["https://..."],
  "tags": ["tag1", "tag2"],
  "sentiment": "positive|negative|neutral",
  "language": "en"
}}
"""


class ParseContentRequest(BaseModel):
    content: str
    hint: Optional[str] = None


class ParseContentResponse(BaseModel):
    content_type: str
    title: str
    summary: str
    mentions: List[str]
    dates: List[str]
    links: List[str]
    tags: List[str]
    sentiment: str
    language: str
    word_count: int


# Quick heuristics before LLM
URL_PATTERN = re.compile(r'https?://[^\s<>"{}|\\^`\[\]]+')
DATE_PATTERNS = [
    re.compile(r'\d{4}-\d{2}-\d{2}'),  # ISO
    re.compile(r'\d{1,2}/\d{1,2}/\d{2,4}'),  # US format
    re.compile(r'(today|tomorrow|yesterday|next week|last week|monday|tuesday|wednesday|thursday|friday|saturday|sunday)', re.I),
]
TASK_INDICATORS = ['todo', 'remind me', 'need to', 'must', 'should', 'have to', 'dont forget', "don't forget"]
QUESTION_INDICATORS = ['?', 'what is', 'how do', 'why does', 'when will', 'where is', 'who is']
LINK_INDICATORS = ['http://', 'https://', 'www.']


def quick_classify(content: str) -> str:
    """Quick heuristic classification"""
    content_lower = content.lower()

    # Check for URLs first
    if any(ind in content_lower for ind in LINK_INDICATORS):
        return 'link'

    # Check for task indicators
    if any(ind in content_lower for ind in TASK_INDICATORS):
        return 'task'

    # Check for questions
    if any(ind in content_lower for ind in QUESTION_INDICATORS):
        return 'question'

    # Default to thought
    return 'thought'


def extract_urls(content: str) -> List[str]:
    """Extract URLs from content"""
    return URL_PATTERN.findall(content)


def extract_dates(content: str) -> List[str]:
    """Extract date mentions from content"""
    dates = []
    for pattern in DATE_PATTERNS:
        matches = pattern.findall(content)
        dates.extend(matches)
    return list(set(dates))


def extract_mentions(content: str) -> List[str]:
    """Extract @mentions from content"""
    return re.findall(r'@(\w+)', content)


def extract_tags(content: str) -> List[str]:
    """Extract #tags from content"""
    return [tag.lower() for tag in re.findall(r'#(\w+)', content)]


@router.post("/parse-content", response_model=ParseContentResponse)
async def parse_content(request: ParseContentRequest):
    """
    Parse content and extract structured metadata.

    Uses quick heuristics first, then LLM for detailed analysis.
    """
    content = request.content
    word_count = len(content.split())

    # Quick extractions
    urls = extract_urls(content)
    dates = extract_dates(content)
    at_mentions = extract_mentions(content)
    hashtags = extract_tags(content)
    quick_type = quick_classify(content)

    # For short content or when we have enough info, skip LLM
    if word_count < 20 or (quick_type == 'link' and urls):
        return ParseContentResponse(
            content_type=quick_type,
            title=content[:100].strip(),
            summary=content[:200].strip(),
            mentions=at_mentions,
            dates=dates,
            links=urls,
            tags=hashtags,
            sentiment='neutral',
            language='en',
            word_count=word_count,
        )

    # Use LLM for richer extraction
    try:
        prompt = PARSE_CONTENT_PROMPT.format(
            content=content[:2000],  # Limit content length
            hint=request.hint or "none",
        )

        response = ollama.generate(
            model="llama3.2:3b",
            prompt=prompt,
            options={
                "temperature": 0.1,
                "num_predict": 512,
            }
        )

        # Parse response
        match = re.search(r'\{[\s\S]*\}', response['response'])
        if match:
            result = json.loads(match.group())

            # Merge LLM results with quick extractions
            all_links = list(set(urls + result.get('links', [])))
            all_dates = list(set(dates + result.get('dates', [])))
            all_mentions = list(set(at_mentions + result.get('mentions', [])))
            all_tags = list(set(hashtags + result.get('tags', [])))

            return ParseContentResponse(
                content_type=result.get('content_type', quick_type),
                title=result.get('title', content[:100].strip()),
                summary=result.get('summary', content[:200].strip()),
                mentions=all_mentions,
                dates=all_dates,
                links=all_links,
                tags=all_tags,
                sentiment=result.get('sentiment', 'neutral'),
                language=result.get('language', 'en'),
                word_count=word_count,
            )

    except Exception as e:
        print(f"LLM parsing failed: {e}")

    # Fallback to quick results
    return ParseContentResponse(
        content_type=quick_type,
        title=content[:100].strip(),
        summary=content[:200].strip(),
        mentions=at_mentions,
        dates=dates,
        links=urls,
        tags=hashtags,
        sentiment='neutral',
        language='en',
        word_count=word_count,
    )


@router.get("/parse-content/test")
async def test_parse():
    """Test content parsing with samples"""
    samples = [
        {
            "content": "Meeting with @john tomorrow at 3pm to discuss the new project proposal",
            "expected_type": "event"
        },
        {
            "content": "Check out this article: https://example.com/interesting-stuff #tech #reading",
            "expected_type": "link"
        },
        {
            "content": "Need to remind myself to call mom on her birthday next week",
            "expected_type": "task"
        },
        {
            "content": "What is the best way to handle async errors in Python?",
            "expected_type": "question"
        },
    ]

    results = []
    for sample in samples:
        result = await parse_content(ParseContentRequest(content=sample["content"]))
        results.append({
            "sample": sample,
            "result": result.model_dump(),
        })

    return {"tests": results}
