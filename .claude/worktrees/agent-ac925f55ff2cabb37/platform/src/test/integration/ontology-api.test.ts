/**
 * Ontology API Integration Tests
 *
 * Tests the new API endpoints for the living ontology system.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { ML_SERVICES_URL, isMLServiceAvailable ,
  skipCtx,
} from '../setup.js';

const PLATFORM_URL = 'http://127.0.0.1:3001';

let mlAvailable = false;
let platformAvailable = false;

describe('Ontology API', () => {
  beforeAll(async () => {
    mlAvailable = await isMLServiceAvailable();
    try {
      const resp = await fetch(`${PLATFORM_URL}/health`, { signal: AbortSignal.timeout(3000) });
      platformAvailable = resp.ok;
    } catch {
      platformAvailable = false;
    }
  });

  describe('Compare Predicates Endpoint', () => {
    beforeAll(async (ctx) => {
      if (!mlAvailable) skipCtx(ctx);
    });

    it('should merge true synonyms', async () => {
      const response = await fetch(`${ML_SERVICES_URL}/compare-predicates`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          predicate_a: 'works_at',
          description_a: 'Employment relationship between person and organization',
          predicate_b: 'employed_at',
          description_b: 'Employed at an organization',
        }),
      });

      expect(response.ok).toBe(true);
      const result = await response.json() as Record<string, unknown>;
      expect(result.decision).toBe('merge');
      expect(result.confidence).toBeGreaterThan(0.5);
    }, 30000);

    it('should keep separate for inverse pairs', async () => {
      const response = await fetch(`${ML_SERVICES_URL}/compare-predicates`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          predicate_a: 'works_at',
          description_a: 'Employment relationship between person and organization',
          predicate_b: 'employs',
          description_b: 'Employs a person at the organization',
        }),
      });

      expect(response.ok).toBe(true);
      const result = await response.json() as Record<string, unknown>;
      expect(result.decision).toBe('keep_separate');
    }, 30000);

    it('should reject noise predicates', async () => {
      const response = await fetch(`${ML_SERVICES_URL}/compare-predicates`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          predicate_a: 'sort_of_works_at',
          description_a: 'Partially employed at organization',
          predicate_b: 'works_at',
          description_b: 'Employment relationship between person and organization',
        }),
      });

      expect(response.ok).toBe(true);
      const result = await response.json() as Record<string, unknown>;
      // Noise predicates should NOT be merged — either "keep_separate" or "defer" is correct
      expect(result.decision).not.toBe('merge');
    }, 30000);
  });

  describe('Ontology Stats Endpoint', () => {
    beforeAll(async (ctx) => {
      if (!platformAvailable) skipCtx(ctx);
    });

    it('should return ontology stats structure', async () => {
      const response = await fetch(`${PLATFORM_URL}/api/ontology/stats`);

      expect(response.ok).toBe(true);
      const result = await response.json() as Record<string, unknown>;

      expect(result.predicates).toBeDefined();
      expect(result.entityTypes).toBeDefined();

      const predicates = result.predicates as Record<string, unknown>;
      expect(predicates.byStatus).toBeDefined();
    }, 10000);
  });
});
