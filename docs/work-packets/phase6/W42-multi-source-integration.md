# Work Packet W42: Multi-Source Integration & E2E Testing

**Status:** ❌ Not Started
**Dependencies:** W35 (HTTP API), W36 (File Watcher), W37 (ML Endpoints), W38 (Meeting Capture), W39 (Obsidian Read), W40 (Obsidian Write-back), W41 (MCP Server)
**Estimated Time:** 3–4 hours

---

## Objective

Validate that all Phase 6 components work together end-to-end. Content from Telegram, file drops, HTTP API, and Obsidian all appear in unified search. The Obsidian round-trip (ingest → process → write-back → edit → re-ingest) works correctly. MCP server tools return accurate results. Cross-source entity deduplication works.

---

## Implementation

### E2E Test Suite

Create `platform/src/test/e2e/multi-source.test.ts`:

```typescript
import { describe, it, expect, beforeAll } from 'vitest';

const API_URL = process.env.MNEMO_URL || 'http://localhost:3001';
const API_KEY = process.env.MNEMO_API_KEY || '';

function authHeaders() {
  return {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${API_KEY}`,
  };
}

describe('Multi-Source Integration', () => {

  describe('Cross-source unified search', () => {
    it('should find content ingested via HTTP API', async () => {
      // Ingest via API
      const ingestRes = await fetch(`${API_URL}/api/ingest`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({
          content: 'Project Alpha uses React and TypeScript for the frontend',
          type: 'text',
          metadata: { source_label: 'test' },
        }),
      });
      expect(ingestRes.status).toBe(202);

      // Wait for processing
      await new Promise((r) => setTimeout(r, 5000));

      // Search should find it
      const searchRes = await fetch(`${API_URL}/api/search`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ query: 'Project Alpha frontend', limit: 5 }),
      });
      const results = await searchRes.json();
      expect(results.length).toBeGreaterThan(0);
    });

    it('should find content from file drop alongside API content', async () => {
      // Assumes file watcher has processed a test file
      const searchRes = await fetch(`${API_URL}/api/search`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ query: 'meeting notes standup', limit: 10 }),
      });
      const results = await searchRes.json();
      // Results may come from any source — verify unified search works
      expect(Array.isArray(results)).toBe(true);
    });
  });

  describe('Content deduplication', () => {
    it('should reject duplicate content across sources', async () => {
      const content = `Dedup test content ${Date.now()}`;

      // First ingest via API
      const res1 = await fetch(`${API_URL}/api/ingest`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ content }),
      });
      expect(res1.status).toBe(202);

      // Same content again
      const res2 = await fetch(`${API_URL}/api/ingest`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ content }),
      });
      expect(res2.status).toBe(409);
    });
  });

  describe('Cross-source entity deduplication', () => {
    it('should merge entities mentioned from different sources', async () => {
      // Ingest mention of "Alice" from API
      await fetch(`${API_URL}/api/ingest`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({
          content: 'Alice presented the Q1 roadmap today',
          type: 'text',
        }),
      });

      // Ingest another mention from different source label
      await fetch(`${API_URL}/api/ingest`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({
          content: 'Had a great meeting with Alice about the API redesign',
          type: 'text',
          metadata: { source_label: 'file-import' },
        }),
      });

      // Wait for entity extraction
      await new Promise((r) => setTimeout(r, 10000));

      // Search should return one canonical "Alice" entity, not two
      const res = await fetch(`${API_URL}/api/entities/search?q=Alice`, {
        headers: authHeaders(),
      });
      const entities = await res.json();
      const aliceEntities = entities.filter((e: any) =>
        e.canonical_name.toLowerCase().includes('alice')
      );
      // Entity dedup should have merged these
      expect(aliceEntities.length).toBeLessThanOrEqual(1);
    });
  });
});
```

### Obsidian Round-Trip Test

```typescript
describe('Obsidian round-trip', () => {
  it('should complete: note → ingest → entity → write-back → edit → re-ingest', async () => {
    // This test requires OBSIDIAN_ENABLED=true and a test vault

    // Step 1: Create a note in vault (simulating user)
    // Step 2: Verify note was ingested (appears in content_hashes)
    // Step 3: Verify entity was extracted
    // Step 4: Verify vault-writer created entity page with mnemo_managed
    // Step 5: Edit the entity page (simulating user curation)
    // Step 6: Verify edited content was re-ingested (new hash in content_hashes)
  });
});
```

### MCP Server Test

```typescript
describe('MCP Server tools', () => {
  it('search_memories should return results matching query', async () => {
    // Call MCP server's search_memories tool
    // Verify results contain relevant content
  });

  it('ingest_content should create searchable memory', async () => {
    // Ingest via MCP tool
    // Search and verify content appears
  });
});
```

### Documentation Updates

#### docs/architecture/current.md

Add "Multi-Source Ingestion" section:

```markdown
## Multi-Source Ingestion (Phase 6)

The system accepts content from multiple sources via the Source Adapter pattern:
- **Telegram** — existing bot handler, wrapped as TelegramAdapter
- **File Watcher** — monitors directory for text, audio, document files
- **HTTP API** — programmatic POST /api/ingest endpoint
- **Obsidian** — bidirectional vault sync (read + write-back)
- **Claude Code** — MCP server exposing search, ingest, entity tools

All sources produce IngestJobData → IngestRouter (dedup) → pg-boss queue → Message Processor.
```

#### docs/INDEX.md

Update Phase 6 section with W34–W42 summary and status.

---

## Test Execution

```bash
# Run multi-source E2E tests (requires all services running)
pnpm test:e2e -- --grep "Multi-Source"

# Run with verbose output
pnpm vitest run src/test/e2e/multi-source.test.ts --reporter=verbose
```

### Pre-test Checklist

- [ ] PostgreSQL running with latest schema (content_hashes, obsidian_sync_state tables)
- [ ] ML Services running (parse-transcript, parse-document, parse-markdown endpoints)
- [ ] Qdrant running
- [ ] Platform running with `WATCH_ENABLED=true`
- [ ] `MNEMO_API_KEY` set in environment
- [ ] For Obsidian tests: `OBSIDIAN_ENABLED=true` and `OBSIDIAN_VAULT_PATH` set

---

## Acceptance Criteria

- [ ] Telegram + file drop + API content all appear in unified search
- [ ] Cross-source content dedup works (same text from different sources → 409)
- [ ] Cross-source entity dedup merges the same person from different sources
- [ ] Obsidian round-trip: ingest → process → write-back → user edit → re-ingest
- [ ] MCP server `search_memories` returns correct results
- [ ] MCP server `ingest_content` creates searchable content
- [ ] docs/architecture/current.md updated with multi-source ingestion section
- [ ] docs/INDEX.md Phase 6 section updated
- [ ] All Phase 6 work packets linked and cross-referenced correctly

---

## Related Documents

- [Phase 6 README](./README.md) — Overview and dependency graph
- [ARCHITECTURE.md](../../architecture/current.md) — System architecture (to update)
- [Documentation Index](../../INDEX.md) — Roadmap (to update)
