/**
 * HTTP Ingest API Routes (W35)
 *
 * REST API for ingesting content from external sources.
 * Supports single and batch ingest with Zod validation.
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { createHash } from 'crypto';
import { apiAuth } from '../middleware/api-auth.js';
import { ingestRouter } from '../services/ingest/router.js';
import type { IngestItem } from '../services/ingest/types.js';

const ingestApi = new Hono();

// All routes require API key
ingestApi.use('*', apiAuth);

// --- Validation schemas ---

const ingestItemSchema = z.object({
  content: z.string().min(1).max(100_000),
  contentType: z.enum(['text', 'voice', 'document', 'link', 'markdown', 'transcript', 'meeting']).default('text'),
  source: z.string().min(1).max(50).default('http-api'),
  sender: z.object({
    id: z.string().min(1),
    name: z.string().min(1),
    handle: z.string().optional(),
  }).optional(),
  channel: z.object({
    id: z.string().min(1),
    name: z.string().optional(),
    platform: z.string().default('api'),
  }).optional(),
  metadata: z.record(z.unknown()).optional(),
  timestamp: z.string().datetime().optional(),
});

const batchSchema = z.object({
  items: z.array(ingestItemSchema).min(1).max(100),
});

// --- Routes ---

/**
 * POST /api/ingest — Ingest a single item
 */
ingestApi.post('/', async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body) {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  const parsed = ingestItemSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Validation failed', details: parsed.error.flatten() }, 400);
  }

  const data = parsed.data;
  const contentHash = createHash('sha256')
    .update(`${data.source}:${data.content}`)
    .digest('hex');

  const item: IngestItem = {
    id: crypto.randomUUID(),
    source: data.source,
    contentType: data.contentType,
    content: data.content,
    sender: data.sender || { id: 'api-user', name: 'API User' },
    channel: data.channel || { id: 'api-default', platform: 'api' },
    contentHash,
    originTimestamp: data.timestamp || new Date().toISOString(),
    metadata: data.metadata,
  };

  const result = await ingestRouter.ingest(item);

  return c.json(result, result.accepted ? 201 : 200);
});

/**
 * POST /api/ingest/batch — Ingest multiple items
 */
ingestApi.post('/batch', async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body) {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  const parsed = batchSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Validation failed', details: parsed.error.flatten() }, 400);
  }

  const items: IngestItem[] = parsed.data.items.map(data => {
    const contentHash = createHash('sha256')
      .update(`${data.source}:${data.content}`)
      .digest('hex');

    return {
      id: crypto.randomUUID(),
      source: data.source || 'http-api',
      contentType: data.contentType,
      content: data.content,
      sender: data.sender || { id: 'api-user', name: 'API User' },
      channel: data.channel || { id: 'api-default', platform: 'api' },
      contentHash,
      originTimestamp: data.timestamp || new Date().toISOString(),
      metadata: data.metadata,
    };
  });

  const results = await ingestRouter.ingestBatch(items);

  const accepted = results.filter(r => r.accepted).length;
  const duplicates = results.filter(r => r.duplicate).length;

  return c.json({
    total: results.length,
    accepted,
    duplicates,
    results,
  });
});

export { ingestApi };
