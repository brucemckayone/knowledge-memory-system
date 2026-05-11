"""
Transcript Parsing Endpoint (W37)

Parses meeting transcripts and conversation logs into structured segments
with speaker identification, timestamps, and topic extraction.
"""

from fastapi import APIRouter
from pydantic import BaseModel
from typing import Optional, List
import re
from .core.llm import llm_client

router = APIRouter()


class TranscriptSegment(BaseModel):
    speaker: str
    text: str
    start_time: Optional[str] = None
    end_time: Optional[str] = None


class TranscriptTopic(BaseModel):
    topic: str
    start_segment: int
    end_segment: int
    summary: str


class ParseTranscriptRequest(BaseModel):
    content: str
    format_hint: Optional[str] = None  # 'vtt', 'srt', 'plain', 'diarized'


class ParseTranscriptResponse(BaseModel):
    segments: List[TranscriptSegment]
    topics: List[TranscriptTopic]
    speakers: List[str]
    duration_estimate: Optional[str] = None
    word_count: int
    summary: str
    action_items: List[str]
    used_fallback: bool = False


# Common transcript patterns
SPEAKER_PATTERN = re.compile(r'^(?:\[?(\d{1,2}:\d{2}(?::\d{2})?)\]?\s+)?([A-Z][a-zA-Z\s.]+?):\s*(.+)', re.MULTILINE)
VTT_TIME_PATTERN = re.compile(r'(\d{2}:\d{2}:\d{2}\.\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2}\.\d{3})')
SRT_TIME_PATTERN = re.compile(r'(\d{2}:\d{2}:\d{2},\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2},\d{3})')

TOPIC_PROMPT = """Analyze this transcript and extract:
1. Key topics discussed (with segment ranges)
2. A brief overall summary (2-3 sentences)
3. Action items mentioned

TRANSCRIPT:
{content}

Return raw JSON only, no markdown code fences:
{{
  "topics": [{{"topic": "...", "summary": "..."}}],
  "summary": "...",
  "action_items": ["..."]
}}
"""


def parse_vtt(content: str) -> List[TranscriptSegment]:
    """Parse WebVTT format transcript."""
    segments = []
    blocks = content.strip().split('\n\n')
    for block in blocks:
        lines = block.strip().split('\n')
        time_match = VTT_TIME_PATTERN.search(block)
        if time_match:
            start = time_match.group(1)
            end = time_match.group(2)
            text_lines = [l for l in lines if not VTT_TIME_PATTERN.search(l) and l.strip() != 'WEBVTT' and not l.strip().isdigit()]
            text = ' '.join(text_lines).strip()
            if text:
                # Check for speaker prefix
                speaker_match = re.match(r'<v\s+([^>]+)>(.*)', text)
                if speaker_match:
                    segments.append(TranscriptSegment(speaker=speaker_match.group(1), text=speaker_match.group(2).strip(), start_time=start, end_time=end))
                else:
                    segments.append(TranscriptSegment(speaker='Unknown', text=text, start_time=start, end_time=end))
    return segments


def parse_diarized(content: str) -> List[TranscriptSegment]:
    """Parse speaker-diarized transcript (Speaker: text format)."""
    segments = []
    for match in SPEAKER_PATTERN.finditer(content):
        timestamp = match.group(1)
        speaker = match.group(2).strip()
        text = match.group(3).strip()
        segments.append(TranscriptSegment(speaker=speaker, text=text, start_time=timestamp))
    return segments


def parse_plain(content: str) -> List[TranscriptSegment]:
    """Parse plain text transcript (split into paragraph segments)."""
    paragraphs = [p.strip() for p in content.split('\n\n') if p.strip()]
    return [TranscriptSegment(speaker='Unknown', text=p) for p in paragraphs]


def detect_format(content: str) -> str:
    """Auto-detect transcript format."""
    if 'WEBVTT' in content[:100] or VTT_TIME_PATTERN.search(content[:500]):
        return 'vtt'
    if SRT_TIME_PATTERN.search(content[:500]):
        return 'srt'
    if SPEAKER_PATTERN.search(content[:1000]):
        return 'diarized'
    return 'plain'


@router.post("/parse-transcript", response_model=ParseTranscriptResponse)
async def parse_transcript(request: ParseTranscriptRequest):
    """Parse a transcript into structured segments with topic extraction."""
    content = request.content
    fmt = request.format_hint or detect_format(content)
    word_count = len(content.split())

    # Parse segments based on format
    if fmt == 'vtt':
        segments = parse_vtt(content)
    elif fmt in ('srt', 'diarized'):
        segments = parse_diarized(content)
    else:
        segments = parse_plain(content)

    # If parsing found nothing, treat as single block
    if not segments:
        segments = [TranscriptSegment(speaker='Unknown', text=content.strip())]

    speakers = sorted(set(s.speaker for s in segments if s.speaker != 'Unknown'))

    # Use LLM for topic extraction and summarization
    topics: List[TranscriptTopic] = []
    summary = content[:200].strip()
    action_items: List[str] = []
    used_fallback = True

    try:
        prompt = TOPIC_PROMPT.format(content=content[:3000])
        result = llm_client.generate_json(prompt, options={"task": "parse_transcript"})

        summary = result.get('summary', summary)
        action_items = result.get('action_items', [])
        for i, t in enumerate(result.get('topics', [])):
            topics.append(TranscriptTopic(
                topic=t.get('topic', ''),
                start_segment=0,
                end_segment=min(i + 1, len(segments) - 1),
                summary=t.get('summary', ''),
            ))
        used_fallback = False
    except Exception as e:
        print(f"LLM topic extraction failed: {e}")

    # Estimate duration from timestamps if available
    duration_estimate = None
    timed = [s for s in segments if s.end_time]
    if timed:
        duration_estimate = timed[-1].end_time

    return ParseTranscriptResponse(
        segments=segments,
        topics=topics,
        speakers=speakers,
        duration_estimate=duration_estimate,
        word_count=word_count,
        summary=summary,
        action_items=action_items,
        used_fallback=used_fallback,
    )
