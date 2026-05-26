/**
 * nmemo-2yv.53 — update_entity_summary handler T8 hardening
 *
 * Locks the write-side contract: oversize input is rejected with a structured
 * error and not persisted; control chars + CRLF + runs of newlines are
 * normalised before write. The companion read-back surfaces
 * (search_entity_aliases, get_entity_neighborhood) wrap persisted summary in
 * <persisted_summary> markers — that wrapping ships in .62 but is asserted
 * here at the dispatcher boundary so the .53 contract is testable end-to-end.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { testDb, createTestEntity } from '../setup.js';
import { handleToolCall } from '../../services/causal-agent.js';
import { db } from '../../db/index.js';
import { entityMeta, entityAliases } from '../../db/schema.js';
import { eq } from 'drizzle-orm';

describe('nmemo-2yv.53: update_entity_summary write-side hardening', () => {
  let entityId: string;

  beforeAll(async () => {
    const entity = await createTestEntity({
      canonicalName: '2yv.53 Test Entity',
      entityType: 'person',
    });
    entityId = entity.id;
  });

  afterAll(async () => {
    await db.delete(entityMeta).where(eq(entityMeta.entityId, entityId)).catch(() => {});
    await db.delete(entityAliases).where(eq(entityAliases.entityId, entityId)).catch(() => {});
    await testDb.unsafe(`DELETE FROM entities WHERE id = '${entityId}'`).catch(() => {});
  });

  it('rejects oversize input (>3000 chars) with structured error and does not persist', async () => {
    const oversize = 'x'.repeat(3001);
    const result = await handleToolCall('update_entity_summary', {
      entity_id: entityId,
      summary: oversize,
    });
    const parsed = JSON.parse(result);
    expect(parsed.error).toContain('exceeds 3000 character limit');
    expect(parsed.length).toBe(3001);
    expect(parsed.limit).toBe(3000);
    expect(parsed.updated).toBeUndefined();

    // Verify nothing was persisted.
    const rows = await db
      .select({ summary: entityMeta.summary })
      .from(entityMeta)
      .where(eq(entityMeta.entityId, entityId));
    expect(rows.length).toBe(0);
  });

  it('accepts exactly 3000 chars (boundary inclusive)', async () => {
    const atLimit = 'a'.repeat(3000);
    const result = await handleToolCall('update_entity_summary', {
      entity_id: entityId,
      summary: atLimit,
    });
    const parsed = JSON.parse(result);
    expect(parsed.updated).toBe(true);

    // Cleanup for the next test.
    await db.delete(entityMeta).where(eq(entityMeta.entityId, entityId));
  });

  it('normalises CRLF, control chars, and runs of newlines before persisting', async () => {
    // Mixed CRLF, a C0 control char (0x01), three consecutive newlines, and
    // leading/trailing whitespace.
    const dirty = '  line one\r\nline two\x01\n\n\n\nline three\r\n  ';
    const result = await handleToolCall('update_entity_summary', {
      entity_id: entityId,
      summary: dirty,
    });
    expect(JSON.parse(result).updated).toBe(true);

    const rows = await db
      .select({ summary: entityMeta.summary })
      .from(entityMeta)
      .where(eq(entityMeta.entityId, entityId));
    expect(rows.length).toBe(1);
    const stored = rows[0]!.summary!;
    // No CRLF, no CR.
    expect(stored).not.toContain('\r');
    // No C0 control char.
    expect(stored).not.toContain('\x01');
    // 3+ newlines collapsed to exactly 2.
    expect(stored).not.toMatch(/\n{3,}/);
    // After CRLF→LF + C0 strip + 3+ → 2 newline collapse, the surviving
    // separator between "line two" and "line three" is exactly two newlines.
    expect(stored).toContain('line one\nline two\n\nline three');
    // Edges trimmed.
    expect(stored.startsWith(' ')).toBe(false);
    expect(stored.endsWith(' ')).toBe(false);
    expect(stored.endsWith('line three')).toBe(true);
  });

  it('persisted summary is returned wrapped in <persisted_summary> markers by get_neighbourhood_profile', async () => {
    // Seed a clean summary via the handler (so we exercise the write path).
    await db.delete(entityMeta).where(eq(entityMeta.entityId, entityId));
    await handleToolCall('update_entity_summary', {
      entity_id: entityId,
      summary: 'Walton is the narrator of the framing letters.',
    });

    const raw = await handleToolCall('get_neighbourhood_profile', {
      entity_id: entityId,
    });
    const parsed = JSON.parse(raw);
    expect(typeof parsed.summary).toBe('string');
    expect(parsed.summary).toContain('<persisted_summary');
    expect(parsed.summary).toContain('</persisted_summary>');
    expect(parsed.summary).toContain('Walton is the narrator of the framing letters.');
  });

  it('persisted summary is returned wrapped in <persisted_summary> markers by search_entity_aliases', async () => {
    // Reset summary state.
    await db.delete(entityMeta).where(eq(entityMeta.entityId, entityId));
    await handleToolCall('update_entity_summary', {
      entity_id: entityId,
      summary: 'Walton — captain of the Arctic expedition.',
    });

    // search_entity_aliases needs an alias row to match against.
    const aliasInsertRes = await handleToolCall('add_entity_alias', {
      entity_id: entityId,
      alias: '2yv53 captain alias',
      alias_type: 'role',
    });
    expect(JSON.parse(aliasInsertRes).added).toBe(true);

    const raw = await handleToolCall('search_entity_aliases', {
      query: '2yv53 captain',
    });
    const matches = JSON.parse(raw) as Array<{ entityId: string; summary: string }>;
    const ours = matches.find(m => m.entityId === entityId);
    expect(ours).toBeDefined();
    expect(ours!.summary).toContain('<persisted_summary');
    expect(ours!.summary).toContain('</persisted_summary>');
    expect(ours!.summary).toContain('captain of the Arctic expedition');
  });
});
