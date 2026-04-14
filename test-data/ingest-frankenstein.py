"""
Ingest Frankenstein into Mnemo
==============================

Breaks the novel into paragraph-sized chunks and feeds them through
the HTTP ingest endpoint. Tracks what's ingested for verification.

Run: py test-data/ingest-frankenstein.py
Requires: Platform running on localhost:3001 with MNEMO_API_KEY set
"""

import json
import os
import sys
import time
import urllib.request
import re

PLATFORM_URL = os.environ.get("PLATFORM_URL", "http://127.0.0.1:3001")
NOVEL_PATH = "test-data/frankenstein.txt"

# Skip Project Gutenberg header/footer
START_MARKER = "Letter 1"
END_MARKER = "*** END OF THE PROJECT GUTENBERG EBOOK"


def load_and_chunk(path: str, min_chars: int = 500, max_chars: int = 4000, overlap: int = 200) -> list[str]:
    """Load the novel and break into chunks with overlap for relationship continuity."""
    with open(path, "r", encoding="utf-8") as f:
        text = f.read()

    # Find the actual novel content
    start = text.find(START_MARKER)
    end = text.find(END_MARKER)
    if start == -1 or end == -1:
        print(f"Could not find content markers in {path}")
        sys.exit(1)

    content = text[start:end].strip()

    # Split on double newlines (paragraphs)
    paragraphs = re.split(r'\n\s*\n', content)

    # Merge paragraphs into chunks up to max_chars
    raw_chunks = []
    current = ""

    for para in paragraphs:
        para = para.strip()
        if not para:
            continue

        # Keep chapter headings with surrounding text
        if len(para) < 50 and re.match(r'^(Chapter|Letter|CHAPTER)\s', para):
            if current:
                current += f"\n\n{para}"
            else:
                current = para
            continue

        if len(current) + len(para) < max_chars:
            current = f"{current}\n\n{para}" if current else para
        else:
            if len(current) >= min_chars:
                raw_chunks.append(current.strip())
            current = para

    if current and len(current) >= min_chars:
        raw_chunks.append(current.strip())

    # Add overlap: copy trailing text from previous chunk to start of next
    if overlap <= 0 or len(raw_chunks) <= 1:
        return raw_chunks

    chunks = [raw_chunks[0]]
    for i in range(1, len(raw_chunks)):
        prev = raw_chunks[i - 1]
        # Take the last `overlap` chars from previous chunk as prefix
        prefix = prev[-overlap:] if len(prev) > overlap else prev
        # Find a word boundary to avoid splitting mid-word
        space_idx = prefix.find(' ')
        if space_idx > 0:
            prefix = prefix[space_idx + 1:]
        chunks.append(f"{prefix}\n\n{raw_chunks[i]}")

    return chunks


def ingest_chunk(content: str, chunk_id: int) -> dict:
    """Send a chunk to the ingest endpoint."""
    body = json.dumps({
        "text": content,
        "source": f"frankenstein-test/chunk-{chunk_id}",
    }).encode()

    req = urllib.request.Request(
        f"{PLATFORM_URL}/ingest",
        data=body,
        headers={
            "Content-Type": "application/json",
        },
    )

    try:
        resp = urllib.request.urlopen(req, timeout=600)
        return json.loads(resp.read())
    except Exception as e:
        return {"error": str(e)}


def check_health() -> bool:
    """Check if the platform is healthy."""
    try:
        req = urllib.request.Request(f"{PLATFORM_URL}/health")
        resp = urllib.request.urlopen(req, timeout=5)
        data = json.loads(resp.read())
        return data.get("status") == "ok"
    except Exception:
        return False


def main():
    print("=" * 60)
    print("FRANKENSTEIN INGESTION TEST")
    print(f"Target: {PLATFORM_URL}")
    print("=" * 60)

    # Health check
    if not check_health():
        print("ERROR: Platform not available at", PLATFORM_URL)
        sys.exit(1)
    print("Platform: OK")

    # Load and chunk
    chunks = load_and_chunk(NOVEL_PATH)
    print(f"Novel chunked into {len(chunks)} pieces")
    print(f"Avg chunk size: {sum(len(c) for c in chunks) // len(chunks)} chars")

    # Ingest one chunk at a time — sequential ordering is critical for
    # entity resolution, fact dedup, and causal graph integrity.
    total = min(len(chunks), 10)  # Cap at 10 for truth graph test
    succeeded = 0
    errors = 0

    print(f"\nIngesting {total} chunks sequentially (of {len(chunks)} total)...")

    for i in range(total):
        chunk_id = i + 1
        t0 = time.time()
        result = ingest_chunk(chunks[i], chunk_id)
        elapsed = time.time() - t0

        if result.get("error"):
            errors += 1
            print(f"  [{chunk_id}/{total}] ERROR ({elapsed:.1f}s): {result['error']}")
        else:
            succeeded += 1
            n_ents = len(result.get("entities", []))
            n_facts = len(result.get("facts", []))
            print(f"  [{chunk_id}/{total}] OK ({elapsed:.1f}s) entities={n_ents} facts={n_facts}")

    print(f"\nIngestion complete: {succeeded} succeeded, {errors} errors")

    # Check graph via viz stats endpoint
    try:
        req = urllib.request.Request(f"{PLATFORM_URL}/api/viz/stats")
        resp = urllib.request.urlopen(req, timeout=5)
        stats = json.loads(resp.read())
        print(f"\nGraph stats: {json.dumps(stats)}")
        print(f"  Open {PLATFORM_URL}/viz to visualize the graph")
    except Exception as e:
        print(f"\nStats query failed: {e}")


if __name__ == "__main__":
    main()
