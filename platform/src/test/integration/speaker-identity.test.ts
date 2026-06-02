/**
 * Stream-scoped speaker identity + assistant entity type (nmemo-3f9.1)
 *
 * Acceptance:
 * - `assistant` is an accepted catalog-canonical entity type that round-trips
 *   through create/read (and is returned by getValidEntityTypes).
 * - findOrCreateSpeaker returns a stable entity per (streamId, speakerKey).
 * - Two different streamIds NEVER collapse onto one speaker entity even with
 *   identical display labels — the deterministic key bypasses resolveEntity's
 *   embedding auto-merge and createEntity's name dedup.
 */

import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import {
  testDb,
  createTestEntity,
  isMLServiceAvailable,
} from '../setup.js';
import {
  findOrCreateSpeaker,
  getValidEntityTypes,
  invalidateEntityTypeCache,
  createEntity,
} from '../../services/entities.js';

const RUN = `test-3f9-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const createdEntityIds: string[] = [];

async function entityType(id: string): Promise<string | null> {
  const rows = await testDb`SELECT entity_type FROM public.entities WHERE id = ${id}`;
  return rows[0]?.entity_type ?? null;
}

afterEach(async () => {
  // stream_participants is NOT in the deleteFromTables allowlist; deleting the
  // entity cascades (ON DELETE CASCADE) to its participant rows. Clean only
  // what this suite created so the shared DB is left untouched otherwise.
  if (createdEntityIds.length > 0) {
    await testDb`DELETE FROM public.entities WHERE id = ANY(${createdEntityIds})`;
    createdEntityIds.length = 0;
  }
});

describe('assistant entity type (catalog)', () => {
  beforeAll(() => invalidateEntityTypeCache());

  it('assistant is a catalog-canonical type returned by getValidEntityTypes', async () => {
    invalidateEntityTypeCache();
    const types = await getValidEntityTypes();
    expect(types).toContain('assistant');
  });

  it('an assistant-typed entity round-trips through create/read', async () => {
    // ML-free create/read path via the test helper.
    const { id } = await createTestEntity({
      canonicalName: `${RUN}-assistant-entity`,
      entityType: 'assistant',
    });
    createdEntityIds.push(id);
    expect(await entityType(id)).toBe('assistant');
  });

  it('createEntity accepts the assistant type (agentic write path)', async () => {
    if (!(await isMLServiceAvailable())) return; // createEntity embeds the name
    const { id } = await createEntity({ name: `${RUN}-assistant-svc`, type: 'assistant' });
    createdEntityIds.push(id);
    expect(await entityType(id)).toBe('assistant');
  });
});

describe('findOrCreateSpeaker (stream-scoped identity)', () => {
  it('returns a stable entity for the same (streamId, speakerKey)', async () => {
    const stream = `${RUN}-A`;
    const first = await findOrCreateSpeaker(stream, 'user', 'user');
    createdEntityIds.push(first.id);
    expect(first.isNew).toBe(true);

    const second = await findOrCreateSpeaker(stream, 'user', 'user');
    expect(second.id).toBe(first.id);
    expect(second.isNew).toBe(false);
  });

  it('never collapses identical speakers across different streams', async () => {
    const a = await findOrCreateSpeaker(`${RUN}-S1`, 'user', 'user');
    const b = await findOrCreateSpeaker(`${RUN}-S2`, 'user', 'user');
    createdEntityIds.push(a.id, b.id);
    // Same display label ("User (stream ...)"), same role/embedding shape — but
    // distinct streams MUST yield distinct entities.
    expect(a.id).not.toBe(b.id);
  });

  it('maps the assistant role to the assistant entity type', async () => {
    const { id } = await findOrCreateSpeaker(`${RUN}-asst`, 'assistant', 'assistant');
    createdEntityIds.push(id);
    expect(await entityType(id)).toBe('assistant');
  });

  it('persists a participant row keyed by (streamId, speakerKey)', async () => {
    const stream = `${RUN}-P`;
    const { id } = await findOrCreateSpeaker(stream, 'user', 'user');
    createdEntityIds.push(id);
    const rows = await testDb`
      SELECT entity_id, role FROM public.stream_participants
      WHERE stream_id = ${stream} AND speaker_key = 'user'`;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.entity_id).toBe(id);
    expect(rows[0]?.role).toBe('user');
  });
});
