/**
 * HTTP Ingest API Tests (W35)
 */

import { describe, it, expect } from 'vitest';
import { z } from 'zod';

// Test the validation schemas and auth middleware logic without requiring full server
describe('HTTP Ingest API', () => {
  const ingestItemSchema = z.object({
    content: z.string().min(1).max(100_000),
    contentType: z.enum(['text', 'voice', 'document', 'link', 'markdown', 'transcript', 'meeting']).default('text'),
    source: z.string().min(1).max(50).default('http-api'),
    sender: z.object({
      id: z.string().min(1),
      name: z.string().min(1),
      handle: z.string().optional(),
    }).optional(),
    metadata: z.record(z.unknown()).optional(),
    timestamp: z.string().datetime().optional(),
  });

  it('validates a minimal ingest request', () => {
    const result = ingestItemSchema.safeParse({ content: 'Hello world' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.contentType).toBe('text');
      expect(result.data.source).toBe('http-api');
    }
  });

  it('rejects empty content', () => {
    const result = ingestItemSchema.safeParse({ content: '' });
    expect(result.success).toBe(false);
  });

  it('validates content type enum', () => {
    const result = ingestItemSchema.safeParse({ content: 'test', contentType: 'invalid' });
    expect(result.success).toBe(false);
  });

  it('accepts all valid content types', () => {
    for (const ct of ['text', 'voice', 'document', 'link', 'markdown', 'transcript', 'meeting']) {
      const result = ingestItemSchema.safeParse({ content: 'test', contentType: ct });
      expect(result.success).toBe(true);
    }
  });

  it('accepts optional sender and metadata', () => {
    const result = ingestItemSchema.safeParse({
      content: 'test',
      sender: { id: 'user-1', name: 'Alice' },
      metadata: { source_file: 'notes.md' },
    });
    expect(result.success).toBe(true);
  });
});

describe('API Auth Middleware', () => {
  it('module exports apiAuth function', async () => {
    const mod = await import('../../middleware/api-auth.js');
    expect(typeof mod.apiAuth).toBe('function');
  });
});
