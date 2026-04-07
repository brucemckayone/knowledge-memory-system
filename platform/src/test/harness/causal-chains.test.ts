/**
 * B09: Multi-input causality — causal chains across sequential ingests
 *
 * Ingests 3 related texts sequentially and verifies the causal agent
 * connects events across separate ingest() calls.
 *
 * Requires: ML service with /causal-reason endpoint + Claude Code CLI.
 * Skips gracefully if not available.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { testDb } from '../setup.js';
import { traceCauses } from '../../services/causal.js';

/**
 * Check if the full integration stack is available.
 */
async function isIntegrationAvailable(): Promise<boolean> {
  try {
    const res = await fetch('http://127.0.0.1:8000/health', {
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return false;
    const health = await res.json() as { endpoints?: string[] };
    // Need both ML service running AND the causal-reason endpoint registered
    return health.endpoints?.includes('causal-reason') ?? false;
  } catch {
    return false;
  }
}

describe('B09: Multi-input causal chains', () => {
  let available: boolean;

  beforeAll(async () => {
    available = await isIntegrationAvailable();
    if (!available) {
      console.log(
        'Skipping multi-input causal chain test: ML service /causal-reason not available.\n' +
        'Restart ML service to pick up the new endpoint, then re-run.'
      );
    }
  });

  it('3 sequential ingests produce causal chain spanning multiple memories', async () => {
    if (!available) return;

    const { ingest } = await import('../../pipeline.js');

    // Ingest 1: new job
    const r1 = await ingest('John started a new job at TechCorp last month');
    expect(r1.entities.length).toBeGreaterThanOrEqual(1);

    // Ingest 2: stress (explicitly causal — should trigger agent)
    const r2 = await ingest('John has been stressed because of the heavy workload at TechCorp');
    expect(r2.causal).toBeDefined();
    expect(r2.causal!.triggered).toBe(true);

    // Ingest 3: sleep problems (explicitly causal — should trigger agent)
    const r3 = await ingest('John cannot sleep this week because the stress has been overwhelming');
    expect(r3.causal).toBeDefined();
    expect(r3.causal!.triggered).toBe(true);

    // Verify: traceCauses on the last fact should find a chain
    // spanning at least 2 of the 3 memories
    if (r3.facts.length > 0) {
      const chain = await traceCauses(r3.facts[0]!.id);

      // Chain should have more than just the leaf event
      expect(chain.length).toBeGreaterThanOrEqual(2);

      // Verify events come from different source memories
      const memoryIds = new Set(
        chain
          .map(node => node.event.sourceMemoryId)
          .filter((id): id is string => id != null)
      );
      expect(memoryIds.size).toBeGreaterThanOrEqual(2);
    }
  }, 300_000); // 5 min timeout — 3 Claude Code round-trips

  it('all edges created during this test have valid quality', async () => {
    if (!available) return;

    // Check all edges in the system (quality test)
    const badReasoning = await testDb`
      SELECT id FROM causal_edges
      WHERE reasoning IS NULL OR reasoning = '' OR LENGTH(TRIM(reasoning)) = 0
    `;
    expect(badReasoning.length).toBe(0);

    const badRefs = await testDb`
      SELECT id FROM causal_edges
      WHERE source_references IS NULL
         OR source_references::text = '[]'
         OR jsonb_array_length(source_references) = 0
    `;
    expect(badRefs.length).toBe(0);
  }, 10_000);
});
