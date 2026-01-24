# Work Packet W13: Web Scraper (Python)

**Status:** Ready to Implement  
**Dependencies:** None (can be done in parallel)  
**Estimated Time:** 1-2 hours

---

## Objective

Create Python endpoints to fetch web pages, extract clean content, and summarize text. These endpoints power the link processing workflow.

---

## Background

When a user shares a URL, we need to:
1. **Fetch** the raw HTML
2. **Extract** the main content (remove nav, ads, etc.)
3. **Convert** to clean text
4. **Summarize** using LLM

This packet creates the `/scrape` and `/summarize` Python endpoints.

---

## Architecture

### Endpoints

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/scrape` | POST | Fetch URL and extract content |
| `/summarize` | POST | Summarize text using Ollama |

---

## Step 1: Install Dependencies

Update `ml-services/requirements.txt`:

```
fastapi==0.109.0
uvicorn==0.27.0
httpx==0.25.2
python-multipart==0.0.6
pydantic==2.5.3
ollama>=0.1.6
groq>=0.4.0
aiofiles>=23.0.0
# New for web scraping
readability-lxml>=0.8.1
beautifulsoup4>=4.12.0
lxml>=5.0.0
```

---

## Step 2: Create Scrape Endpoint

Create `ml-services/app/scrape.py`:

```python
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from typing import Optional
from urllib.parse import urlparse
import httpx
from readability import Document
from bs4 import BeautifulSoup
import re

router = APIRouter()

# User agent to avoid being blocked
USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/120.0.0.0 Safari/537.36"
)

# Timeout for fetching
FETCH_TIMEOUT = 15.0

# Max content length (5MB)
MAX_CONTENT_LENGTH = 5 * 1024 * 1024


class ScrapeRequest(BaseModel):
    """Request body for scraping"""
    url: str


class ScrapeResponse(BaseModel):
    """Scraped content response"""
    url: str
    title: str
    content: str  # Clean HTML
    text: str     # Plain text
    domain: str
    word_count: int
    description: Optional[str] = None
    image: Optional[str] = None


def clean_url(url: str) -> str:
    """Normalize URL"""
    url = url.strip()
    if not url.startswith(('http://', 'https://')):
        url = 'https://' + url
    return url


def extract_text(html: str) -> str:
    """Extract plain text from HTML"""
    soup = BeautifulSoup(html, 'lxml')
    
    # Remove script, style, and nav elements
    for element in soup(['script', 'style', 'nav', 'header', 'footer', 'aside']):
        element.decompose()
    
    # Get text and clean whitespace
    text = soup.get_text(separator=' ')
    text = re.sub(r'\s+', ' ', text).strip()
    
    return text


def extract_metadata(soup: BeautifulSoup) -> dict:
    """Extract metadata from page"""
    metadata = {}
    
    # Description
    desc = soup.find('meta', attrs={'name': 'description'})
    if desc and desc.get('content'):
        metadata['description'] = desc['content']
    
    # OG description fallback
    og_desc = soup.find('meta', attrs={'property': 'og:description'})
    if og_desc and og_desc.get('content') and 'description' not in metadata:
        metadata['description'] = og_desc['content']
    
    # Image
    og_image = soup.find('meta', attrs={'property': 'og:image'})
    if og_image and og_image.get('content'):
        metadata['image'] = og_image['content']
    
    return metadata


@router.post("/scrape", response_model=ScrapeResponse)
async def scrape_url(request: ScrapeRequest):
    """
    Fetch and extract content from a URL.
    
    Uses readability to extract main content and removes
    boilerplate (nav, ads, sidebars, etc.).
    """
    url = clean_url(request.url)
    parsed = urlparse(url)
    domain = parsed.netloc.replace('www.', '')
    
    try:
        # Fetch page
        print(f"📥 Fetching: {url}")
        async with httpx.AsyncClient(timeout=FETCH_TIMEOUT) as client:
            response = await client.get(
                url,
                headers={"User-Agent": USER_AGENT},
                follow_redirects=True
            )
            response.raise_for_status()
            
            # Check content length
            content_length = len(response.content)
            if content_length > MAX_CONTENT_LENGTH:
                raise HTTPException(
                    status_code=400,
                    detail=f"Page too large: {content_length / 1024 / 1024:.1f}MB"
                )
            
            html = response.text
        
        # Extract main content using readability
        doc = Document(html)
        title = doc.title()
        content_html = doc.summary()
        
        # Convert to plain text
        text = extract_text(content_html)
        word_count = len(text.split())
        
        # Extract metadata
        soup = BeautifulSoup(html, 'lxml')
        metadata = extract_metadata(soup)
        
        print(f"✅ Scraped: '{title}' ({word_count} words)")
        
        return ScrapeResponse(
            url=url,
            title=title,
            content=content_html,
            text=text,
            domain=domain,
            word_count=word_count,
            description=metadata.get('description'),
            image=metadata.get('image'),
        )
        
    except httpx.TimeoutException:
        raise HTTPException(
            status_code=408,
            detail=f"Timeout fetching {domain}"
        )
    except httpx.HTTPStatusError as e:
        raise HTTPException(
            status_code=e.response.status_code,
            detail=f"HTTP {e.response.status_code} from {domain}"
        )
    except Exception as e:
        print(f"❌ Scrape error: {e}")
        raise HTTPException(
            status_code=500,
            detail=f"Failed to scrape: {str(e)}"
        )


@router.get("/scrape/test")
async def test_scrape():
    """Test scraping with a sample URL"""
    try:
        result = await scrape_url(
            ScrapeRequest(url="https://example.com")
        )
        return {
            "success": True,
            "title": result.title,
            "word_count": result.word_count,
            "preview": result.text[:200]
        }
    except Exception as e:
        return {"success": False, "error": str(e)}
```

---

## Step 3: Create Summarize Endpoint

Create `ml-services/app/summarize.py`:

```python
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from typing import List, Optional
import ollama
import re

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
    
    # Extract summary
    summary_match = re.search(
        r'SUMMARY:\s*(.+?)(?=KEY POINTS:|$)', 
        text, 
        re.DOTALL | re.IGNORECASE
    )
    if summary_match:
        result['summary'] = summary_match.group(1).strip()
    else:
        # Fallback: use first paragraph
        lines = text.strip().split('\n')
        result['summary'] = lines[0] if lines else text[:200]
    
    # Extract key points
    key_points_match = re.search(
        r'KEY POINTS:\s*(.+)', 
        text, 
        re.DOTALL | re.IGNORECASE
    )
    if key_points_match:
        points_text = key_points_match.group(1)
        # Find all bullet points
        points = re.findall(r'[-•*]\s*(.+?)(?=\n[-•*]|\Z)', points_text, re.DOTALL)
        result['key_points'] = [p.strip() for p in points if p.strip()]
    
    # Fallback if no key points found
    if not result['key_points']:
        # Try to extract sentences as points
        sentences = re.split(r'[.!?]\s+', result['summary'])
        result['key_points'] = sentences[:3]
    
    return result


@router.post("/summarize", response_model=SummarizeResponse)
async def summarize_content(request: SummarizeRequest):
    """
    Summarize text content using LLM.
    
    Returns a concise summary and key points.
    Uses llama3 for better summary quality.
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
        
        # Call Ollama (using llama3 for better quality)
        response = ollama.generate(
            model="llama3",  # Use larger model for summaries
            prompt=prompt,
            options={
                "temperature": 0.3,  # Some creativity but mostly factual
                "num_predict": 512,  # Longer output for summary
            }
        )
        
        # Parse response
        result = parse_summary_response(response['response'])
        
        print(f"✅ Summary: {len(result['summary'])} chars, {len(result['key_points'])} points")
        
        return SummarizeResponse(
            summary=result['summary'],
            key_points=result['key_points'],
            word_count=len(content.split())
        )
        
    except ollama.ResponseError as e:
        raise HTTPException(
            status_code=503,
            detail=f"LLM unavailable: {str(e)}"
        )
    except Exception as e:
        print(f"❌ Summarize error: {e}")
        raise HTTPException(
            status_code=500,
            detail=f"Summarization failed: {str(e)}"
        )


@router.get("/summarize/test")
async def test_summarize():
    """Test summarization with sample content"""
    sample_content = """
    Artificial intelligence (AI) is transforming industries worldwide. 
    From healthcare to finance, AI systems are being deployed to automate 
    complex tasks and provide insights that were previously impossible.
    
    In healthcare, AI is being used for drug discovery, medical imaging 
    analysis, and personalized treatment recommendations. Financial institutions 
    are using AI for fraud detection, algorithmic trading, and risk assessment.
    
    However, the rapid advancement of AI also raises concerns about job 
    displacement, privacy, and the need for ethical guidelines. Experts 
    emphasize the importance of responsible AI development and the need 
    for regulations to ensure AI benefits society as a whole.
    """
    
    try:
        result = await summarize_content(
            SummarizeRequest(
                content=sample_content,
                title="AI Transformation in Industries"
            )
        )
        return {
            "success": True,
            "summary": result.summary,
            "key_points": result.key_points
        }
    except Exception as e:
        return {"success": False, "error": str(e)}
```

---

## Step 4: Register Routers

Update `ml-services/app/main.py`:

```python
from fastapi import FastAPI
from app.embed import router as embed_router
from app.transcribe import router as transcribe_router
from app.classify import router as classify_router
from app.extract_task import router as extract_task_router
from app.scrape import router as scrape_router
from app.summarize import router as summarize_router

app = FastAPI(
    title="Cognitive ML Services",
    description="ML endpoints for the Cognitive Platform",
    version="2.0.0"
)

# Register all routers
app.include_router(embed_router)
app.include_router(transcribe_router)
app.include_router(classify_router)
app.include_router(extract_task_router)
app.include_router(scrape_router)
app.include_router(summarize_router)


@app.get("/health")
def health():
    return {
        "status": "ok",
        "services": [
            "embed",
            "transcribe", 
            "classify",
            "extract-task",
            "scrape",
            "summarize"
        ]
    }
```

---

## Step 5: Rebuild Docker

```bash
# Rebuild with new dependencies
docker compose build ml-services

# Restart
docker compose up -d ml-services

# Check logs
docker compose logs -f ml-services
```

---

## Testing

### Test Scrape Endpoint

```bash
# Test with example.com
curl -X POST http://localhost:8000/scrape \
  -H "Content-Type: application/json" \
  -d '{"url": "https://example.com"}'

# Expected response
{
  "url": "https://example.com",
  "title": "Example Domain",
  "content": "<div>...</div>",
  "text": "This domain is for use in illustrative examples...",
  "domain": "example.com",
  "word_count": 45
}
```

### Test Scrape with Real Article

```bash
curl -X POST http://localhost:8000/scrape \
  -H "Content-Type: application/json" \
  -d '{"url": "https://news.ycombinator.com"}'
```

### Test Summarize Endpoint

```bash
curl -X POST http://localhost:8000/summarize \
  -H "Content-Type: application/json" \
  -d '{
    "title": "AI News",
    "content": "Artificial intelligence is transforming how we work and live..."
  }'

# Expected response
{
  "summary": "AI is transforming industries worldwide...",
  "key_points": [
    "AI automates complex tasks",
    "Used in healthcare and finance",
    "Raises ethical concerns"
  ],
  "word_count": 150
}
```

### Test Endpoints

```bash
# Scrape test
curl http://localhost:8000/scrape/test

# Summarize test
curl http://localhost:8000/summarize/test
```

---

## Error Handling

| Error | Status | Description |
|-------|--------|-------------|
| Timeout | 408 | Page took too long to load |
| 404 | 404 | Page not found |
| 403 | 403 | Access denied (blocked) |
| Page too large | 400 | Content > 5MB |
| LLM unavailable | 503 | Ollama not responding |

---

## Acceptance Criteria

- [ ] `/scrape` fetches and extracts content
- [ ] `/scrape/test` returns success
- [ ] `/summarize` generates summary with key points
- [ ] `/summarize/test` returns success
- [ ] Handles timeouts gracefully
- [ ] Handles blocked sites gracefully
- [ ] Docker builds successfully
- [ ] Health endpoint lists new services

---

## Performance Considerations

- **Timeout**: 15 seconds for fetch (prevents hanging)
- **Max size**: 5MB content limit
- **Truncation**: 8000 chars for summarization
- **Model**: Uses `llama3` for summaries (higher quality)

---

## Site Compatibility Notes

Some sites may block scrapers:
- **Blocked**: Facebook, LinkedIn (require auth)
- **Works**: Most blogs, news sites, docs
- **Partial**: Twitter/X (may need API)

For blocked sites, we fall back to storing just the URL without content.

---

## Next Packet

After completing W13, proceed to:
- [W11: Link Processing](./W11-link-processing.md) - Uses scrape/summarize endpoints
