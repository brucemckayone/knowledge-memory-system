/**
 * Qdrant collection isolation — bead nmemo-wow.
 *
 * Root cause: qdrant.ts hard-coded COLLECTIONS.MEMORIES='memories', so any
 * suite using store()/the qdrant wrappers wrote to the SHARED production
 * 'memories' collection with no cleanup, corrupting production/benchmark data
 * when tests ran against a shared Qdrant.
 *
 * Fix: COLLECTIONS.MEMORIES is now a LAZY getter reading
 * process.env.QDRANT_COLLECTION at access time. The vitest setupFile
 * (src/test/setup.ts) sets QDRANT_COLLECTION='memories_test' before any test
 * imports qdrant.ts, so all Qdrant ops under test target the isolated
 * collection. Production (no env var) still resolves to 'memories'.
 *
 * These assertions encode the ACCEPTANCE contract:
 *   - under vitest, the resolved collection is 'memories_test' (never 'memories')
 *   - the resolution is lazy: clearing the env var falls back to the production
 *     default 'memories', and restoring it returns to 'memories_test'.
 */
import { describe, it, expect } from 'vitest';
import { COLLECTIONS } from '../../services/qdrant.js';

describe('Qdrant collection isolation (nmemo-wow)', () => {
  it('resolves to memories_test under the vitest test env', () => {
    // setup.ts sets QDRANT_COLLECTION='memories_test'.
    expect(process.env.QDRANT_COLLECTION).toBe('memories_test');
    expect(COLLECTIONS.MEMORIES).toBe('memories_test');
    // The production collection name must NOT be what tests target.
    expect(COLLECTIONS.MEMORIES).not.toBe('memories');
  });

  it('is a LAZY getter — falls back to production default when env unset, no import-time binding', () => {
    const saved = process.env.QDRANT_COLLECTION;
    try {
      // No env var → production default. Proves the name is read at access
      // time, not captured once at module import (the contamination trap).
      delete process.env.QDRANT_COLLECTION;
      expect(COLLECTIONS.MEMORIES).toBe('memories');

      // An explicit value is honoured at access time too.
      process.env.QDRANT_COLLECTION = 'memories_other';
      expect(COLLECTIONS.MEMORIES).toBe('memories_other');
    } finally {
      process.env.QDRANT_COLLECTION = saved;
    }
    // Restored to the test isolation collection for the rest of the run.
    expect(COLLECTIONS.MEMORIES).toBe('memories_test');
  });
});
