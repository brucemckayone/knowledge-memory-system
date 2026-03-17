# Work Packet W35: HTTP Ingest API

**Status:** ❌ Not Started
**Dependencies:** W34 (Source Adapter Framework)
**Estimated Time:** 2–3 hours

---

## Objective

Expose an HTTP API for programmatic content ingestion. Any tool, script, or integration that can make HTTP requests can push content into Mnemo. This also serves as the foundation for the MCP server (W41).

---

## Implementation

### API Routes

Add to `platform/src/routes/ingest.ts`:

```typescript
import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { IngestRouter, computeContentHash } from '../services/ingest/router.js';
import { randomUUID } from 'crypto';

const ingestRoutes = new Hono();

/**
 * Single content ingest.
 */
const IngestBody = z.object({
  content: z.string().min(1).max(100_000),
  type: z.enum(['text', 'markdown', 'transcript', 'document', 'link']).default('text'),
  metadata: z.record(z.unknown()).optional().default({}),
  source_label: z.string().optional(),
});

ingestRoutes.post('/api/ingest', zValidator('json', IngestBody), async (c) => {
  const body = c.req.valid('json');
  const router = c.get('ingestRouter') as IngestRouter;

  const job = {
    traceId: randomUUID(),
    platform: 'api' as const,
    rawType: body.type,
    content: body.content,
    contentHash: computeContentHash(body.content),
    metadata: { ...body.metadata, source_label: body.source_label },
    createdAt: new Date().toISOString(),
  };

  const result = await router.route(job);

  if (result.duplicate) {
    return c.json({ trace_id: job.traceId, status: 'duplicate' }, 409);
  }

  return c.json({ trace_id: job.traceId, status: 'queued' }, 202);
});

/**
 * Batch ingest (up to 50 items).
 */
const BatchIngestBody = z.object({
  items: z.array(IngestBody).min(1).max(50),
});

ingestRoutes.post('/api/ingest/batch', zValidator('json', BatchIngestBody), async (c) => {
  const { items } = c.req.valid('json');
  const router = c.get('ingestRouter') as IngestRouter;

  const results = await Promise.all(
    items.map(async (item) => {
      const job = {
        traceId: randomUUID(),
        platform: 'api' as const,
        rawType: item.type,
        content: item.content,
        contentHash: computeContentHash(item.content),
        metadata: { ...item.metadata, source_label: item.source_label },
        createdAt: new Date().toISOString(),
      };
      const result = await router.route(job);
      return { trace_id: job.traceId, status: result.duplicate ? 'duplicate' : 'queued' };
    }),
  );

  return c.json({ results }, 202);
});

export { ingestRoutes };
```

### Authentication Middleware

Add API key authentication to `platform/src/middleware/api-auth.ts`:

```typescript
import { Context, Next } from 'hono';
import { config } from '../config.js';

/**
 * Bearer token auth for API routes.
 * Key is configured via MNEMO_API_KEY env var.
 */
export async function apiKeyAuth(c: Context, next: Next) {
  const authHeader = c.req.header('Authorization');

  if (!authHeader?.startsWith('Bearer ')) {
    return c.json({ error: 'Missing Authorization header' }, 401);
  }

  const token = authHeader.slice(7);
  if (token !== config.MNEMO_API_KEY) {
    return c.json({ error: 'Invalid API key' }, 403);
  }

  await next();
}
```

### Config Addition

Add to `platform/src/config.ts`:

```typescript
MNEMO_API_KEY: z.string().min(16).describe('API key for HTTP ingest endpoints'),
```

### Route Registration

Wire into `platform/src/index.ts`:

```typescript
import { ingestRoutes } from './routes/ingest.js';
import { apiKeyAuth } from './middleware/api-auth.js';

app.use('/api/ingest/*', apiKeyAuth);
app.route('/', ingestRoutes);
```

---

## Verification

### Automated Tests

```typescript
// platform/src/test/integration/ingest-api.test.ts
import { describe, it, expect } from 'vitest';

describe('POST /api/ingest', () => {
  it('should return 202 with trace_id for valid content', async () => {
    const res = await fetch('http://localhost:3001/api/ingest', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.MNEMO_API_KEY}`,
      },
      body: JSON.stringify({ content: 'Test memory from API' }),
    });
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.trace_id).toBeDefined();
    expect(body.status).toBe('queued');
  });

  it('should return 409 for duplicate content', async () => {
    const content = 'Duplicate test content ' + Date.now();
    // First request
    await fetch('http://localhost:3001/api/ingest', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.MNEMO_API_KEY}`,
      },
      body: JSON.stringify({ content }),
    });
    // Second request — same content
    const res = await fetch('http://localhost:3001/api/ingest', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.MNEMO_API_KEY}`,
      },
      body: JSON.stringify({ content }),
    });
    expect(res.status).toBe(409);
  });

  it('should return 401 without auth header', async () => {
    const res = await fetch('http://localhost:3001/api/ingest', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'No auth' }),
    });
    expect(res.status).toBe(401);
  });
});
```

### Manual Verification

```bash
# Single ingest
curl -X POST http://localhost:3001/api/ingest \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $MNEMO_API_KEY" \
  -d '{"content": "Meeting decision: switch to Hono framework", "type": "text"}'

# Batch ingest
curl -X POST http://localhost:3001/api/ingest/batch \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $MNEMO_API_KEY" \
  -d '{"items": [{"content": "Note 1"}, {"content": "Note 2", "type": "markdown"}]}'

# Verify it hit the queue
psql -d cognitive -c "SELECT * FROM content_hashes WHERE platform = 'api' ORDER BY created_at DESC LIMIT 5;"
```

---

## Acceptance Criteria

- [ ] `POST /api/ingest` accepts content with Zod validation
- [ ] `POST /api/ingest/batch` handles up to 50 items
- [ ] API key auth via `Authorization: Bearer <key>`
- [ ] Duplicate content returns 409
- [ ] Valid content returns 202 with `trace_id`
- [ ] Content flows through to message processor
- [ ] `MNEMO_API_KEY` added to config schema

---

## Next Packet

- [W41: Mnemo MCP Server](./W41-mnemo-mcp-server.md) — Exposes this API to Claude Code
