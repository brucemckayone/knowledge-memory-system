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