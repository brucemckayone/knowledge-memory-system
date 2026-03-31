"""
Ingest Frankenstein into Mnemo
==============================

Breaks the novel into paragraph-sized chunks and feeds them through
the HTTP ingest endpoint. Tracks what's ingested for verification.

Run: py test-data/ingest-frankenstein.py
Requires: Platform running on localhost:3001 with MNEMO_API_KEY set
"""

import json
import sys
import time
import urllib.request
import re

PLATFORM_URL = "http://127.0.0.1:3001"
API_KEY = "test-api-key-dev"
NOVEL_PATH = "test-data/frankenstein.txt"

# Skip Project Gutenberg header/footer
START_MARKER = "Letter 1"
END_MARKER = "*** END OF THE PROJECT GUTENBERG EBOOK"


def load_and_chunk(path: str, min_chars: int = 200, max_chars: int = 1500) -> list[str]:
    """Load the novel and break into paragraph-sized chunks."""
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

    # Merge small paragraphs, split large ones
    chunks = []
    current = ""

    for para in paragraphs:
        para = para.strip()
        if not para:
            continue

        # Skip chapter headings on their own
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
                chunks.append(current.strip())
            current = para

    if current and len(current) >= min_chars:
        chunks.append(current.strip())

    return chunks


def ingest_chunk(content: str, chunk_id: int) -> dict:
    """Send a chunk to the ingest endpoint."""
    body = json.dumps({
        "content": content,
        "source": "frankenstein-test",
        "type": "text",
    }).encode()

    req = urllib.request.Request(
        f"{PLATFORM_URL}/api/ingest",
        data=body,
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {API_KEY}",
        },
    )

    try:
        resp = urllib.request.urlopen(req, timeout=15)
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


def get_stats() -> dict:
    """Get current ontology stats."""
    try:
        req = urllib.request.Request(f"{PLATFORM_URL}/api/ontology/stats")
        resp = urllib.request.urlopen(req, timeout=5)
        return json.loads(resp.read())
    except Exception:
        return {}


def main():
    print("=" * 60)
    print("FRANKENSTEIN INGESTION TEST")
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
    print()

    # Ingest stats before
    stats_before = get_stats()
    print(f"Before: {json.dumps(stats_before.get('predicates', {}).get('byStatus', {}))}")

    # Ingest in batches
    batch_size = 10
    total = min(len(chunks), 10)  # Cap at 10 for truth graph test
    accepted = 0
    duplicates = 0
    errors = 0

    print(f"\nIngesting {total} chunks (of {len(chunks)} total)...")

    for i in range(0, total, batch_size):
        batch = chunks[i:i + batch_size]
        for j, chunk in enumerate(batch):
            chunk_id = i + j + 1
            result = ingest_chunk(chunk, chunk_id)

            if result.get("accepted"):
                accepted += 1
                dup = " (dup)" if result.get("duplicate") else ""
                if result.get("duplicate"):
                    duplicates += 1
            elif result.get("error"):
                errors += 1

            sys.stdout.write(f"\r  Progress: {chunk_id}/{total} (accepted: {accepted}, errors: {errors})")
            sys.stdout.flush()

        # Brief pause between batches to let the pipeline process
        time.sleep(2)

    print(f"\n\nIngestion complete: {accepted} accepted, {duplicates} duplicates, {errors} errors")

    # Wait for processing
    print("\nWaiting 30s for pipeline to process...")
    time.sleep(30)

    # Check results
    stats_after = get_stats()
    print(f"\nAfter: {json.dumps(stats_after.get('predicates', {}).get('byStatus', {}))}")

    # Query entities
    try:
        req = urllib.request.Request(f"{PLATFORM_URL}/api/entities?q=frankenstein&limit=20")
        resp = urllib.request.urlopen(req, timeout=10)
        entities = json.loads(resp.read())
        print(f"\nEntities matching 'frankenstein': {json.dumps(entities, indent=2)[:500]}")
    except Exception as e:
        print(f"\nEntity query failed: {e}")

    # Query all entities
    try:
        from urllib.parse import urlencode
        req = urllib.request.Request(f"{PLATFORM_URL}/api/entities?limit=30")
        resp = urllib.request.urlopen(req, timeout=10)
        entities = json.loads(resp.read())
        if isinstance(entities, list):
            print(f"\nAll entities ({len(entities)}):")
            for e in entities[:20]:
                name = e.get("canonicalName") or e.get("canonical_name", "?")
                etype = e.get("entityType") or e.get("entity_type", "?")
                print(f"  {name:30s} ({etype})")
        elif isinstance(entities, dict) and "entities" in entities:
            ents = entities["entities"]
            print(f"\nAll entities ({len(ents)}):")
            for e in ents[:20]:
                name = e.get("canonicalName") or e.get("canonical_name", "?")
                etype = e.get("entityType") or e.get("entity_type", "?")
                print(f"  {name:30s} ({etype})")
    except Exception as e:
        print(f"\nEntity list failed: {e}")

    # Check predicate usage
    print("\nPredicate usage (top 15):")
    try:
        req = urllib.request.Request(f"{PLATFORM_URL}/api/ontology/stats")
        resp = urllib.request.urlopen(req, timeout=5)
        stats = json.loads(resp.read())
        print(f"  Status counts: {json.dumps(stats.get('predicates', {}).get('byStatus', {}))}")
    except Exception as e:
        print(f"  Stats failed: {e}")


if __name__ == "__main__":
    main()
