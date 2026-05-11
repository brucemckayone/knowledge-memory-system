/**
 * Contradiction Scanner Agent Tests (W33)
 *
 * Tests the scheduled contradiction detection agent.
 * Requires PostgreSQL; ML services are mocked.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  testDb,
  createTestEntity,
  createTestFact,
  mockMLService,
  deleteFromTables,
} from '../setup.js';
import { contradictionScannerAgent } from '../../gardener/agents/contradiction-scanner.agent.js';
import type { AgentContext } from '../../gardener/controller.js';
import { ml } from '../../services/ml-client.js';

function makeContext(payload: Record<string, unknown> = {}): AgentContext {
  return {
    job: { id: 'test-job-id', data: payload } as any,
    log: vi.fn(),
    checkpoint: vi.fn(),
    restoreCheckpoint: vi.fn().mockResolvedValue(null),
    traceId: null,
    config: {} as any,
    services: { ml, controller: {} as any },
    signal: new AbortController().signal,
  };
}

describe('Contradiction Scanner Agent', () => {
  beforeEach(async () => {
    await deleteFromTables('contradiction_reviews', 'facts', 'entities');
  });

  it('has correct name and tier', () => {
    expect(contradictionScannerAgent.name).toBe('contradiction-scanner');
    expect(contradictionScannerAgent.tier).toBe('periodic');
  });

  it('returns success with zero facts when none exist', async () => {
    const ctx = makeContext({ sinceHours: 24 });
    const result = await contradictionScannerAgent.execute(ctx);
    expect(result.success).toBe(true);
    expect(result.outputs?.factsScanned).toBe(0);
  });

  it('detects and records contradictions', async () => {
    // Create entities and contradicting facts
    const person = await createTestEntity({ canonicalName: 'Alice', entityType: 'person' });
    const company1 = await createTestEntity({ canonicalName: 'Acme', entityType: 'company' });
    const company2 = await createTestEntity({ canonicalName: 'Beta Corp', entityType: 'company' });

    await createTestFact({
      subjectEntityId: person.id,
      predicate: 'works_at',
      objectEntityId: company1.id,
    });
    await createTestFact({
      subjectEntityId: person.id,
      predicate: 'works_at',
      objectEntityId: company2.id,
    });

    // Mock ML service to return contradiction
    const fetchMock = mockMLService({
      'check-contradiction': {
        contradicts: true,
        type: 'temporal_override',
        resolution: 'supersede',
        confidence: 0.92,
        reasoning: 'Newer fact supersedes older',
      },
    });

    try {
      const ctx = makeContext({ sinceHours: 1 });
      const result = await contradictionScannerAgent.execute(ctx);

      expect(result.success).toBe(true);
      expect(result.outputs?.reviewsCreated).toBeGreaterThanOrEqual(1);

      // Verify review was written to DB
      const reviews = await testDb`SELECT * FROM contradiction_reviews`;
      expect(reviews.length).toBeGreaterThanOrEqual(1);
    } finally {
      fetchMock.mockRestore();
    }
  });

  it('auto-resolves high-confidence supersessions', async () => {
    const person = await createTestEntity({ canonicalName: 'Bob', entityType: 'person' });
    await createTestFact({
      subjectEntityId: person.id,
      predicate: 'has_role',
      objectValue: 'Junior Engineer',
    });
    // Slight delay to ensure ordering
    await new Promise(r => setTimeout(r, 50));
    await createTestFact({
      subjectEntityId: person.id,
      predicate: 'has_role',
      objectValue: 'Senior Engineer',
    });

    const fetchMock = mockMLService({
      'check-contradiction': {
        contradicts: true,
        type: 'temporal_override',
        resolution: 'supersede',
        confidence: 0.95,
        reasoning: 'Role change detected',
      },
    });

    try {
      const ctx = makeContext({ sinceHours: 1 });
      const result = await contradictionScannerAgent.execute(ctx);

      expect(result.outputs?.autoResolved).toBeGreaterThanOrEqual(1);

      // Older fact should be expired
      const expiredFacts = await testDb`
        SELECT * FROM facts WHERE expired_at IS NOT NULL
      `;
      expect(expiredFacts.length).toBeGreaterThanOrEqual(1);
    } finally {
      fetchMock.mockRestore();
    }
  });
});
