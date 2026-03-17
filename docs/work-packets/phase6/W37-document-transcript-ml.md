# Work Packet W37: Document & Transcript ML Endpoints

**Status:** ❌ Not Started
**Dependencies:** None (Python-side work, parallel with W34)
**Estimated Time:** 4–5 hours

---

## Objective

Add ML service endpoints for parsing VTT/SRT transcripts (with speaker diarization and action-item extraction), PDF/DOCX document text extraction, and Markdown structural parsing. These endpoints are consumed by the file watcher (W36), Obsidian adapter (W39), and meeting capture pipeline (W38).

---

## Implementation

### POST /parse-transcript

Create `ml-services/app/parse_transcript.py`:

```python
import re
from typing import Optional
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from app.core.llm import call_llm

router = APIRouter()


class TranscriptSegment(BaseModel):
    """A single timestamped segment from a transcript."""
    start: str           # "00:01:23.456"
    end: str
    speaker: Optional[str] = None
    text: str


class ParseTranscriptRequest(BaseModel):
    content: str         # Raw VTT or SRT content
    format: str = "vtt"  # "vtt" or "srt"
    extract_actions: bool = True


class ParseTranscriptResponse(BaseModel):
    segments: list[TranscriptSegment]
    speakers: list[str]
    full_text: str
    action_items: list[str]
    duration_estimate: Optional[str] = None


def parse_vtt(content: str) -> list[TranscriptSegment]:
    """Parse WebVTT format with optional <v Speaker> tags."""
    segments = []
    # Split on blank lines, skip WEBVTT header
    blocks = re.split(r'\n\n+', content.strip())

    for block in blocks:
        if block.startswith('WEBVTT') or block.startswith('NOTE'):
            continue

        lines = block.strip().split('\n')

        # Find timestamp line
        timestamp_line = None
        text_lines = []
        for line in lines:
            if '-->' in line:
                timestamp_line = line
            elif timestamp_line is not None:
                text_lines.append(line)

        if not timestamp_line or not text_lines:
            continue

        # Parse timestamps
        times = timestamp_line.split('-->')
        start = times[0].strip().split(' ')[0]  # Remove position info
        end = times[1].strip().split(' ')[0]

        # Extract speaker from <v Speaker> tag
        raw_text = ' '.join(text_lines)
        speaker = None
        speaker_match = re.match(r'<v\s+([^>]+)>', raw_text)
        if speaker_match:
            speaker = speaker_match.group(1)
            raw_text = re.sub(r'<v\s+[^>]+>', '', raw_text)
            raw_text = raw_text.replace('</v>', '').strip()

        # Strip remaining HTML/VTT tags
        clean_text = re.sub(r'<[^>]+>', '', raw_text).strip()

        if clean_text:
            segments.append(TranscriptSegment(
                start=start, end=end, speaker=speaker, text=clean_text
            ))

    return segments


def parse_srt(content: str) -> list[TranscriptSegment]:
    """Parse SRT subtitle format."""
    segments = []
    blocks = re.split(r'\n\n+', content.strip())

    for block in blocks:
        lines = block.strip().split('\n')
        if len(lines) < 3:
            continue

        # Line 1: sequence number, Line 2: timestamps, Line 3+: text
        timestamp_line = lines[1]
        text = ' '.join(lines[2:])

        times = timestamp_line.split('-->')
        start = times[0].strip().replace(',', '.')
        end = times[1].strip().replace(',', '.')

        segments.append(TranscriptSegment(
            start=start, end=end, speaker=None, text=text.strip()
        ))

    return segments


async def extract_action_items(full_text: str) -> list[str]:
    """Use LLM to extract action items from transcript text."""
    prompt = f"""Extract action items from this meeting transcript.
Return ONLY a JSON array of strings, each being one action item.
If no action items found, return [].

Transcript:
{full_text[:8000]}"""

    response = await call_llm(prompt, max_tokens=1000)
    try:
        import json
        items = json.loads(response)
        return items if isinstance(items, list) else []
    except (json.JSONDecodeError, TypeError):
        return []


@router.post("/parse-transcript", response_model=ParseTranscriptResponse)
async def parse_transcript(request: ParseTranscriptRequest):
    """Parse VTT or SRT transcript into structured segments with speaker attribution."""
    try:
        if request.format == "srt":
            segments = parse_srt(request.content)
        else:
            segments = parse_vtt(request.content)

        speakers = list({s.speaker for s in segments if s.speaker})
        full_text = ' '.join(s.text for s in segments)

        action_items = []
        if request.extract_actions and full_text:
            action_items = await extract_action_items(full_text)

        return ParseTranscriptResponse(
            segments=segments,
            speakers=speakers,
            full_text=full_text,
            action_items=action_items,
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Transcript parsing failed: {e}")
```

### POST /parse-document

Create `ml-services/app/parse_document.py`:

```python
import os
import tempfile
from fastapi import APIRouter, HTTPException, UploadFile, File
from pydantic import BaseModel

router = APIRouter()


class ParseDocumentResponse(BaseModel):
    text: str
    pages: int
    metadata: dict


@router.post("/parse-document", response_model=ParseDocumentResponse)
async def parse_document(file: UploadFile = File(...)):
    """Extract text from PDF or DOCX files."""
    ext = os.path.splitext(file.filename or "")[1].lower()

    with tempfile.NamedTemporaryFile(suffix=ext, delete=False) as f:
        content = await file.read()
        f.write(content)
        temp_path = f.name

    try:
        if ext == ".pdf":
            return parse_pdf(temp_path)
        elif ext == ".docx":
            return parse_docx(temp_path)
        else:
            raise HTTPException(400, f"Unsupported format: {ext}")
    finally:
        os.unlink(temp_path)


def parse_pdf(path: str) -> ParseDocumentResponse:
    """Extract text from PDF using pymupdf."""
    import pymupdf

    doc = pymupdf.open(path)
    pages = []
    for page in doc:
        pages.append(page.get_text())
    doc.close()

    return ParseDocumentResponse(
        text='\n\n'.join(pages),
        pages=len(pages),
        metadata={"format": "pdf"},
    )


def parse_docx(path: str) -> ParseDocumentResponse:
    """Extract text from DOCX using python-docx."""
    from docx import Document

    doc = Document(path)
    paragraphs = [p.text for p in doc.paragraphs if p.text.strip()]

    return ParseDocumentResponse(
        text='\n\n'.join(paragraphs),
        pages=1,  # DOCX doesn't have a reliable page count without rendering
        metadata={"format": "docx"},
    )
```

### POST /parse-markdown

Create `ml-services/app/parse_markdown.py`:

```python
import re
import yaml
from typing import Optional
from fastapi import APIRouter
from pydantic import BaseModel

router = APIRouter()


class ParseMarkdownRequest(BaseModel):
    content: str


class ParseMarkdownResponse(BaseModel):
    frontmatter: dict
    headings: list[dict]       # [{level: 1, text: "Title"}, ...]
    wikilinks: list[str]       # ["Person Name", "Project X"]
    tags: list[str]            # ["#meeting", "#project"]
    clean_text: str            # Markdown without frontmatter
    word_count: int


@router.post("/parse-markdown", response_model=ParseMarkdownResponse)
async def parse_markdown(request: ParseMarkdownRequest):
    """Parse Markdown into structured components: frontmatter, wikilinks, tags, headings."""
    content = request.content

    # Extract frontmatter
    frontmatter = {}
    clean = content
    fm_match = re.match(r'^---\s*\n(.*?)\n---\s*\n', content, re.DOTALL)
    if fm_match:
        try:
            frontmatter = yaml.safe_load(fm_match.group(1)) or {}
        except yaml.YAMLError:
            pass
        clean = content[fm_match.end():]

    # Extract headings
    headings = [
        {"level": len(m.group(1)), "text": m.group(2).strip()}
        for m in re.finditer(r'^(#{1,6})\s+(.+)$', clean, re.MULTILINE)
    ]

    # Extract wikilinks [[Target]] or [[Target|Display]]
    wikilinks = [
        m.group(1).split('|')[0]
        for m in re.finditer(r'\[\[([^\]]+)\]\]', clean)
    ]

    # Extract tags #tag (but not inside code blocks)
    tags = list({m.group(0) for m in re.finditer(r'(?<!\w)#[a-zA-Z][\w/-]*', clean)})

    word_count = len(clean.split())

    return ParseMarkdownResponse(
        frontmatter=frontmatter,
        headings=headings,
        wikilinks=wikilinks,
        tags=tags,
        clean_text=clean.strip(),
        word_count=word_count,
    )
```

### Python Dependencies

Add to `ml-services/requirements.txt`:

```
pymupdf>=1.24.0
python-docx>=1.1.0
pyyaml>=6.0
```

### Route Registration

Update `ml-services/app/main.py`:

```python
from app.parse_transcript import router as transcript_router
from app.parse_document import router as document_router
from app.parse_markdown import router as markdown_router

app.include_router(transcript_router)
app.include_router(document_router)
app.include_router(markdown_router)
```

---

## Verification

### Automated Tests

```python
# ml-services/tests/test_parse_transcript.py
from app.parse_transcript import parse_vtt, parse_srt

def test_parse_vtt_with_speakers():
    vtt = """WEBVTT

00:00:01.000 --> 00:00:05.000
<v Alice>Hello everyone, let's get started.

00:00:05.500 --> 00:00:10.000
<v Bob>Sure, first item on the agenda is the API redesign.
"""
    segments = parse_vtt(vtt)
    assert len(segments) == 2
    assert segments[0].speaker == "Alice"
    assert segments[1].speaker == "Bob"

def test_parse_vtt_without_speakers():
    vtt = """WEBVTT

00:00:01.000 --> 00:00:05.000
Hello everyone

00:00:05.500 --> 00:00:10.000
Let's discuss the roadmap
"""
    segments = parse_vtt(vtt)
    assert len(segments) == 2
    assert segments[0].speaker is None

def test_parse_srt():
    srt = """1
00:00:01,000 --> 00:00:05,000
Hello everyone

2
00:00:05,500 --> 00:00:10,000
Let's discuss the roadmap
"""
    segments = parse_srt(srt)
    assert len(segments) == 2
    assert segments[0].start == "00:00:01.000"
```

### Manual Verification

```bash
# Test transcript parsing
curl -X POST http://localhost:8000/parse-transcript \
  -H "Content-Type: application/json" \
  -d '{"content": "WEBVTT\n\n00:00:01.000 --> 00:00:05.000\n<v Alice>Hello everyone", "format": "vtt"}'

# Test document parsing
curl -X POST http://localhost:8000/parse-document \
  -F "file=@document.pdf"

# Test markdown parsing
curl -X POST http://localhost:8000/parse-markdown \
  -H "Content-Type: application/json" \
  -d '{"content": "---\ntitle: Test\n---\n# Heading\n\n[[Person Name]] said #important"}'
```

---

## Acceptance Criteria

- [ ] `/parse-transcript` handles VTT with `<v>` speaker tags
- [ ] `/parse-transcript` handles SRT format
- [ ] Speaker names extracted into `speakers` array
- [ ] Action items extracted via LLM when `extract_actions: true`
- [ ] `/parse-document` extracts text from PDF (pymupdf)
- [ ] `/parse-document` extracts text from DOCX (python-docx)
- [ ] `/parse-markdown` extracts frontmatter, wikilinks, tags, headings
- [ ] All endpoints registered in `main.py`
- [ ] Python dependencies added to `requirements.txt`

---

## Next Packet

- [W38: Meeting Capture](./W38-meeting-capture.md) — Consumes transcript parsing
- [W39: Obsidian Read Adapter](./W39-obsidian-read.md) — Consumes markdown parsing
