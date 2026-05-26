/**
 * Ontology State Machine Tests (Test 2)
 *
 * Proves that predicate status transitions follow the designed lifecycle.
 * Valid transitions succeed, invalid transitions throw.
 *
 * NOTE (nmemo-2yv.23): `transitionPredicateStatus` is currently @deprecated
 * — no production code walks predicates through the staging → candidate →
 * provisional → canonical lifecycle. This suite is retained as a regression
 * guard on the state-machine API's correctness so that if/when an
 * orchestrator is revived (per doc 02 §6), the lifecycle invariants don't
 * have to be re-derived. Do NOT remove without reviving or striking §6.
 */

import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { testDb ,
  skipCtx,
} from '../setup.js';
import { transitionPredicateStatus } from '../../services/predicates.js';

const TS = Date.now();
let tablesReady = false;

async function insertPredicate(name: string, status: string): Promise<void> {
  await testDb`
    INSERT INTO fact_predicates (predicate, status, description)
    VALUES (${name}, ${status}, 'test predicate')
    ON CONFLICT (predicate) DO UPDATE SET status = ${status}
  `;
}

describe('Ontology State Machine', () => {
  beforeAll(async (ctx) => {
    try {
      await testDb`SELECT 1 FROM fact_predicates WHERE status IS NOT NULL LIMIT 1`;
      tablesReady = true;
    } catch {
      skipCtx(ctx);
    }
  });

  afterEach(async () => {
    if (!tablesReady) return;
    await testDb`DELETE FROM fact_predicates WHERE predicate LIKE ${'test_sm_%'}`;
  });

  describe('Valid transitions', () => {
    it('staging → canonical (alias auto-merge)', async () => {
      const pred = `test_sm_s2c_${TS}`;
      await insertPredicate(pred, 'staging');
      await transitionPredicateStatus(pred, 'canonical');
      const result = await testDb`SELECT status FROM fact_predicates WHERE predicate = ${pred}`;
      expect(result[0]!.status).toBe('canonical');
    });

    it('staging → candidate (threshold met)', async () => {
      const pred = `test_sm_s2cand_${TS}`;
      await insertPredicate(pred, 'staging');
      await transitionPredicateStatus(pred, 'candidate');
      const result = await testDb`SELECT status FROM fact_predicates WHERE predicate = ${pred}`;
      expect(result[0]!.status).toBe('candidate');
    });

    it('candidate → provisional (LLM approves)', async () => {
      const pred = `test_sm_c2p_${TS}`;
      await insertPredicate(pred, 'candidate');
      await transitionPredicateStatus(pred, 'provisional', { promotedAt: new Date() });
      const result = await testDb`SELECT status, promoted_at FROM fact_predicates WHERE predicate = ${pred}`;
      expect(result[0]!.status).toBe('provisional');
      expect(result[0]!.promoted_at).toBeDefined();
    });

    it('candidate → rejected (LLM rejects)', async () => {
      const pred = `test_sm_c2r_${TS}`;
      await insertPredicate(pred, 'candidate');
      await transitionPredicateStatus(pred, 'rejected', {
        rejectedAt: new Date(),
        rejectionReason: 'Noise predicate',
      });
      const result = await testDb`SELECT status, rejection_reason FROM fact_predicates WHERE predicate = ${pred}`;
      expect(result[0]!.status).toBe('rejected');
      expect(result[0]!.rejection_reason).toBe('Noise predicate');
    });

    it('provisional → canonical (probation passed)', async () => {
      const pred = `test_sm_p2c_${TS}`;
      await insertPredicate(pred, 'provisional');
      await transitionPredicateStatus(pred, 'canonical');
      const result = await testDb`SELECT status FROM fact_predicates WHERE predicate = ${pred}`;
      expect(result[0]!.status).toBe('canonical');
    });

    it('provisional → staging (demoted)', async () => {
      const pred = `test_sm_p2s_${TS}`;
      await insertPredicate(pred, 'provisional');
      await transitionPredicateStatus(pred, 'staging');
      const result = await testDb`SELECT status FROM fact_predicates WHERE predicate = ${pred}`;
      expect(result[0]!.status).toBe('staging');
    });

    it('rejected → staging (TTL expired, re-enters)', async () => {
      const pred = `test_sm_r2s_${TS}`;
      await insertPredicate(pred, 'rejected');
      await transitionPredicateStatus(pred, 'staging');
      const result = await testDb`SELECT status FROM fact_predicates WHERE predicate = ${pred}`;
      expect(result[0]!.status).toBe('staging');
    });
  });

  describe('Invalid transitions', () => {
    it('canonical → staging should throw', async () => {
      const pred = `test_sm_inv1_${TS}`;
      await insertPredicate(pred, 'canonical');
      await expect(transitionPredicateStatus(pred, 'staging'))
        .rejects.toThrow(/Invalid status transition/);
    });

    it('canonical → rejected should throw', async () => {
      const pred = `test_sm_inv2_${TS}`;
      await insertPredicate(pred, 'canonical');
      await expect(transitionPredicateStatus(pred, 'rejected'))
        .rejects.toThrow(/Invalid status transition/);
    });

    it('rejected → canonical should throw (must go through staging first)', async () => {
      const pred = `test_sm_inv3_${TS}`;
      await insertPredicate(pred, 'rejected');
      await expect(transitionPredicateStatus(pred, 'canonical'))
        .rejects.toThrow(/Invalid status transition/);
    });

    it('rejected → provisional should throw', async () => {
      const pred = `test_sm_inv4_${TS}`;
      await insertPredicate(pred, 'rejected');
      await expect(transitionPredicateStatus(pred, 'provisional'))
        .rejects.toThrow(/Invalid status transition/);
    });

    it('staging → provisional should throw (must go through candidate)', async () => {
      const pred = `test_sm_inv5_${TS}`;
      await insertPredicate(pred, 'staging');
      await expect(transitionPredicateStatus(pred, 'provisional'))
        .rejects.toThrow(/Invalid status transition/);
    });

    it('nonexistent predicate should throw', async () => {
      await expect(transitionPredicateStatus(`test_sm_missing_${TS}`, 'canonical'))
        .rejects.toThrow(/not found/);
    });
  });
});
