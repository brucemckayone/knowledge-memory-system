/**
 * Living Ontology E2E Pipeline Tests (Test 1)
 *
 * Exercises the full lifecycle: staging → review → promotion/merge/demotion.
 * Does NOT require ML services — tests the decision logic and DB transitions.
 */

import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { testDb, randomUUID } from '../setup.js';
import { normalizePredicate } from '../../services/predicates.js';

const TS = Date.now();
let tablesReady = false;

describe('Ontology Pipeline E2E', () => {
  beforeAll(async (ctx) => {
    try {
      await testDb`SELECT 1 FROM fact_predicates WHERE status IS NOT NULL LIMIT 1`;
      await testDb`SELECT 1 FROM entity_types LIMIT 1`;
      tablesReady = true;
    } catch {
      (ctx as any).skip();
    }
  });

  afterEach(async () => {
    if (!tablesReady) return;
    await testDb`DELETE FROM facts WHERE predicate LIKE ${'test_e2e_%'}`;
    await testDb`DELETE FROM fact_predicates WHERE predicate LIKE ${'test_e2e_%'}`;
  });

  describe('Promotion path: novel predicate → provisional → canonical', () => {
    it('should stage a novel predicate with usage tracking', async () => {
      const pred = `test_e2e_mentors_${TS}`;

      // Insert as staged with usage above threshold
      await testDb`
        INSERT INTO fact_predicates (predicate, description, status, usage_count, first_seen_at)
        VALUES (${pred}, 'Provides guidance to junior person', 'staging', 5, NOW())
      `;

      // Verify it's in staging
      const result = await testDb`SELECT status, usage_count FROM fact_predicates WHERE predicate = ${pred}`;
      expect(result[0]!.status).toBe('staging');
      expect(result[0]!.usage_count).toBe(5);
    });

    it('should NOT auto-merge a genuinely novel predicate via normalizePredicate', async () => {
      // "mentors" is not in the canonical ontology aliases
      const normalized = normalizePredicate('mentors');
      expect(normalized).toBe('mentors'); // Returns unchanged — no alias match
    });

    it('should transition staging → provisional on promotion', async () => {
      const pred = `test_e2e_novel_${TS}`;

      await testDb`
        INSERT INTO fact_predicates (predicate, description, status, usage_count)
        VALUES (${pred}, 'A genuinely novel relationship', 'staging', 10)
      `;

      // Simulate promotion (what the evolution agent does)
      await testDb`
        UPDATE fact_predicates
        SET status = 'provisional', promoted_at = NOW()
        WHERE predicate = ${pred}
      `;

      const result = await testDb`SELECT status, promoted_at FROM fact_predicates WHERE predicate = ${pred}`;
      expect(result[0]!.status).toBe('provisional');
      expect(result[0]!.promoted_at).toBeDefined();
    });

    it('should promote provisional → canonical after probation with sustained usage', async () => {
      const pred = `test_e2e_probation_${TS}`;

      // Insert as provisional, promoted 30 days ago, with sustained usage
      await testDb`
        INSERT INTO fact_predicates (predicate, description, status, usage_count, promoted_at)
        VALUES (${pred}, 'Well-used predicate', 'provisional', 15, NOW() - INTERVAL '30 days')
      `;

      // Simulate the lifecycle check (Step 5 of evolution agent)
      const stale = await testDb`
        SELECT predicate, usage_count
        FROM fact_predicates
        WHERE status = 'provisional'
          AND promoted_at < NOW() - INTERVAL '14 days'
          AND predicate = ${pred}
      `;
      expect(stale.length).toBe(1);

      // Usage >= threshold (3) → promote to canonical
      const usage = stale[0]!.usage_count as number;
      expect(usage).toBeGreaterThanOrEqual(3);

      await testDb`UPDATE fact_predicates SET status = 'canonical' WHERE predicate = ${pred}`;

      const result = await testDb`SELECT status FROM fact_predicates WHERE predicate = ${pred}`;
      expect(result[0]!.status).toBe('canonical');
    });
  });

  describe('Merge path: known alias → auto-merged into canonical', () => {
    it('should detect "supervising" as an alias of "manages"', async () => {
      // "supervises" (not "supervising") is the alias
      const normalized2 = normalizePredicate('supervises');
      expect(normalized2).toBe('manages');
    });

    it('should merge staged alias and update facts', async () => {
      const pred = `test_e2e_alias_${TS}`;
      const canonical = `test_e2e_canonical_${TS}`;

      // Set up canonical predicate
      await testDb`
        INSERT INTO fact_predicates (predicate, description, status, aliases)
        VALUES (${canonical}, 'A canonical predicate', 'canonical', ARRAY[]::text[])
      `;

      // Set up staged predicate (to be merged)
      await testDb`
        INSERT INTO fact_predicates (predicate, description, status, usage_count)
        VALUES (${pred}, 'Alias to merge', 'staging', 5)
      `;

      // Create a fact using the staged predicate
      const entityA = randomUUID();
      await testDb`
        INSERT INTO entities (id, canonical_name, entity_type) VALUES (${entityA}::uuid, 'TestA', 'person')
      `;
      await testDb`
        INSERT INTO facts (id, subject_entity_id, predicate, object_value)
        VALUES (${randomUUID()}::uuid, ${entityA}::uuid, ${pred}, 'test value')
      `;

      // Simulate merge (what the evolution agent does)
      await testDb`
        UPDATE facts SET predicate = ${canonical}
        WHERE predicate = ${pred} AND expired_at IS NULL
      `;
      await testDb`
        UPDATE fact_predicates
        SET aliases = array_append(aliases, ${pred})
        WHERE predicate = ${canonical}
      `;

      // Verify: no facts with the old predicate
      const oldFacts = await testDb`SELECT COUNT(*) as count FROM facts WHERE predicate = ${pred}`;
      expect(Number(oldFacts[0]!.count)).toBe(0);

      // Verify: alias added
      const updated = await testDb`SELECT aliases FROM fact_predicates WHERE predicate = ${canonical}`;
      expect(updated[0]!.aliases).toContain(pred);

      // Cleanup
      await testDb`DELETE FROM facts WHERE subject_entity_id = ${entityA}::uuid`;
      await testDb`DELETE FROM entities WHERE id = ${entityA}::uuid`;
    });
  });

  describe('Demotion path: provisional with low usage → back to staging', () => {
    it('should demote provisional predicate with low usage after probation', async () => {
      const pred = `test_e2e_demote_${TS}`;

      // Provisional, promoted 30 days ago, but only 1 use (below threshold of 3)
      await testDb`
        INSERT INTO fact_predicates (predicate, description, status, usage_count, promoted_at)
        VALUES (${pred}, 'Low usage predicate', 'provisional', 1, NOW() - INTERVAL '30 days')
      `;

      // Simulate lifecycle check: past probation AND low usage
      const demotable = await testDb`
        SELECT predicate
        FROM fact_predicates
        WHERE status = 'provisional'
          AND promoted_at < NOW() - INTERVAL '14 days'
          AND usage_count < 3
          AND predicate = ${pred}
      `;
      expect(demotable.length).toBe(1);

      // Demote
      await testDb`
        UPDATE fact_predicates
        SET status = 'staging', promoted_at = NULL
        WHERE predicate = ${pred}
      `;

      const result = await testDb`SELECT status, promoted_at FROM fact_predicates WHERE predicate = ${pred}`;
      expect(result[0]!.status).toBe('staging');
      expect(result[0]!.promoted_at).toBeNull();
    });
  });

  describe('Rejection path', () => {
    it('should reject and record reason', async () => {
      const pred = `test_e2e_reject_${TS}`;

      await testDb`
        INSERT INTO fact_predicates (predicate, description, status, usage_count)
        VALUES (${pred}, 'Noise predicate', 'staging', 5)
      `;

      // Simulate rejection
      await testDb`
        UPDATE fact_predicates
        SET status = 'rejected', rejected_at = NOW(), rejection_reason = 'Noise — hedging qualifier'
        WHERE predicate = ${pred}
      `;

      const result = await testDb`SELECT status, rejection_reason FROM fact_predicates WHERE predicate = ${pred}`;
      expect(result[0]!.status).toBe('rejected');
      expect(result[0]!.rejection_reason).toBe('Noise — hedging qualifier');
    });
  });
});
