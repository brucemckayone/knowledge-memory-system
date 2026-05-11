"""
Markdown Parsing Endpoint (W37)

Parses markdown content (including YAML frontmatter) into structured sections.
Used by Obsidian and file-watcher adapters.
"""

from fastapi import APIRouter
from pydantic import BaseModel
from typing import Optional, List, Dict, Any
import re

router = APIRouter()


class MarkdownSection(BaseModel):
    heading: Optional[str] = None
    level: int = 0
    content: str


class ParseMarkdownRequest(BaseModel):
    content: str
    filename: Optional[str] = None


class ParseMarkdownResponse(BaseModel):
    title: str
    frontmatter: Dict[str, Any]
    sections: List[MarkdownSection]
    links: List[str]
    wikilinks: List[str]
    tags: List[str]
    word_count: int


FRONTMATTER_PATTERN = re.compile(r'^---\s*\n(.*?)\n---\s*\n', re.DOTALL)
HEADING_PATTERN = re.compile(r'^(#{1,6})\s+(.+)$', re.MULTILINE)
LINK_PATTERN = re.compile(r'\[([^\]]*)\]\(([^)]+)\)')
WIKILINK_PATTERN = re.compile(r'\[\[([^\]|]+?)(?:\|[^\]]+)?\]\]')
TAG_PATTERN = re.compile(r'(?:^|\s)#([a-zA-Z][a-zA-Z0-9_/-]*)', re.MULTILINE)


def parse_frontmatter(content: str) -> tuple[Dict[str, Any], str]:
    """Extract YAML frontmatter from markdown content."""
    match = FRONTMATTER_PATTERN.match(content)
    if not match:
        return {}, content

    yaml_text = match.group(1)
    remaining = content[match.end():]

    try:
        import yaml
        frontmatter = yaml.safe_load(yaml_text) or {}
        if not isinstance(frontmatter, dict):
            frontmatter = {"value": frontmatter}
        return frontmatter, remaining
    except Exception:
        # Fall back to simple key: value parsing
        fm: Dict[str, Any] = {}
        for line in yaml_text.split('\n'):
            if ':' in line:
                key, _, value = line.partition(':')
                key = key.strip()
                value = value.strip()
                if value.startswith('[') and value.endswith(']'):
                    value = [v.strip().strip('"').strip("'") for v in value[1:-1].split(',')]
                fm[key] = value
        return fm, remaining


def extract_sections(content: str) -> List[MarkdownSection]:
    """Split markdown into heading-delimited sections."""
    sections: List[MarkdownSection] = []
    lines = content.split('\n')
    current_heading: Optional[str] = None
    current_level = 0
    current_lines: List[str] = []

    for line in lines:
        heading_match = HEADING_PATTERN.match(line)
        if heading_match:
            # Save previous section
            text = '\n'.join(current_lines).strip()
            if text or current_heading:
                sections.append(MarkdownSection(
                    heading=current_heading,
                    level=current_level,
                    content=text,
                ))
            current_heading = heading_match.group(2).strip()
            current_level = len(heading_match.group(1))
            current_lines = []
        else:
            current_lines.append(line)

    # Final section
    text = '\n'.join(current_lines).strip()
    if text or current_heading:
        sections.append(MarkdownSection(
            heading=current_heading,
            level=current_level,
            content=text,
        ))

    return sections


@router.post("/parse-markdown", response_model=ParseMarkdownResponse)
async def parse_markdown(request: ParseMarkdownRequest):
    """
    Parse markdown content into structured sections with metadata extraction.

    Handles YAML frontmatter, headings, links, wikilinks, and tags.
    """
    content = request.content

    # Extract frontmatter
    frontmatter, body = parse_frontmatter(content)

    # Extract sections
    sections = extract_sections(body)

    # Extract links
    links = [url for _, url in LINK_PATTERN.findall(body)]

    # Extract wikilinks (Obsidian [[link]] syntax)
    wikilinks = WIKILINK_PATTERN.findall(body)

    # Extract tags (including frontmatter tags)
    tags = list(set(TAG_PATTERN.findall(body)))
    fm_tags = frontmatter.get('tags', [])
    if isinstance(fm_tags, list):
        tags = list(set(tags + [str(t) for t in fm_tags]))
    elif isinstance(fm_tags, str):
        tags = list(set(tags + [fm_tags]))

    # Determine title
    title = frontmatter.get('title', '')
    if not title and sections and sections[0].heading:
        title = sections[0].heading
    if not title and request.filename:
        title = request.filename.replace('.md', '').replace('-', ' ').replace('_', ' ')
    if not title:
        title = body[:100].strip().split('\n')[0]

    word_count = len(body.split())

    return ParseMarkdownResponse(
        title=str(title),
        frontmatter=frontmatter,
        sections=sections,
        links=links,
        wikilinks=wikilinks,
        tags=tags,
        word_count=word_count,
    )
