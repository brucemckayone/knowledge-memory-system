/**
 * Integration: valid_trigger_type CHECK constraint on gardening_reports.
 *
 * Regression guard for bead nmemo-2yv.69. Migration
 * 031_trigger_type_check.sql adds CONSTRAINT valid_trigger_type
 * restricting the column to the two values enumerated in
 * TRIGGER_TYPE_VALUES (src/services/enums.ts). Mirrors the
 * CANDIDATE_SOURCE_VALUES canary pattern from bead nmemo-2yv.93
 * (candidate-source-check.test.ts), which in turn mirrors the
 * RESOLUTION_VALUES canary from bead nmemo-2yv.130.
 *
 * Two assertions:
 *   1. Every literal in TRIGGER_TYPE_VALUES is accepted by the CHECK.
 *      Catches future drift where the SSOT module gains a value but the
 *      migration doesn't (or vice versa).
 *   2. A typo'd value (the bug class the bead exists to prevent) is
 *      rejected with a check_violation error. Pins the fail-closed
 *      contract.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { testDb } from '../setup.js';
import { TRIGGER_TYPE_VALUES } from '../../services/enums.js';

const TEST_REPORT_PREFIX = '[bead-69-test]';

describe('valid_trigger_type CHECK (nmemo-2yv.69)', () => {
  afterEach(async () => {
    await testDb`
      DELETE FROM public.gardening_reports
      WHERE report_text LIKE ${`${TEST_REPORT_PREFIX}%`}
    `.catch(() => {});
  });

  // SSOT canary: every value in TRIGGER_TYPE_VALUES must satisfy the
  // CHECK. Catches future drift where the TS tuple and the migration
  // disagree.
  it.each(TRIGGER_TYPE_VALUES)(
    'CHECK admits "%s" from TRIGGER_TYPE_VALUES (SSOT alignment)',
    async (value) => {
      const rows = await testDb<Array<{ id: string; trigger_type: string }>>`
        INSERT INTO public.gardening_reports (
          trigger_type, report_text
        )
        VALUES (
          ${value}, ${`${TEST_REPORT_PREFIX} ${value}`}
        )
        RETURNING id, trigger_type
      `;
      const inserted = rows[0]!;
      expect(inserted.trigger_type).toBe(value);
    },
  );

  // Fail-closed: an unknown trigger string (the bug class the bead
  // exists to prevent — a typo in any future writer) is rejected by
  // the CHECK.
  it('CHECK rejects an unknown trigger_type value (fail-closed typo guard)', async () => {
    // A plausible typo: 'manuel' instead of 'manual'.
    await expect(
      testDb`
        INSERT INTO public.gardening_reports (
          trigger_type, report_text
        )
        VALUES (
          'manuel', ${`${TEST_REPORT_PREFIX} typo`}
        )
      `,
    ).rejects.toThrow(/valid_trigger_type|check constraint/i);
  });
});
