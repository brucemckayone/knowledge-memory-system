/**
 * Integration: reasoning_reports_query_question_required CHECK on
 * public.reasoning_reports. Regression guard for bead nmemo-2yv.74.
 *
 * Migration 032_reasoning_reports_query_question_check.sql adds
 * CONSTRAINT reasoning_reports_query_question_required enforcing
 *   mode <> 'query' OR (question IS NOT NULL AND length(trim(question)) > 0)
 *
 * Pattern mirrors trigger-type-check.test.ts (bead nmemo-2yv.69) /
 * candidate-source-check.test.ts (bead nmemo-2yv.93).
 *
 * Acceptance criteria covered:
 *   - INSERT (mode='query', question=NULL) raises check_violation.
 *   - INSERT (mode='query', question='') raises the same.
 *   - INSERT (mode='query', question='   ') raises the same (whitespace-only).
 *   - INSERT (mode='query', question='real question') succeeds.
 *   - INSERT (mode='patrol', question=NULL) still succeeds (patrol unaffected).
 *   - INSERT (mode='patrol', question='anything') still succeeds.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { testDb } from '../setup.js';

const TEST_REPORT_MARKER = '[bead-74-test]';

describe('reasoning_reports_query_question_required CHECK (nmemo-2yv.74)', () => {
  afterEach(async () => {
    await testDb`
      DELETE FROM public.reasoning_reports
      WHERE report LIKE ${`${TEST_REPORT_MARKER}%`}
    `.catch(() => {});
  });

  it('CHECK rejects (mode=query, question=NULL)', async () => {
    await expect(
      testDb`
        INSERT INTO public.reasoning_reports (mode, question, report)
        VALUES ('query', NULL, ${`${TEST_REPORT_MARKER} null-question`})
      `,
    ).rejects.toThrow(/reasoning_reports_query_question_required|check constraint/i);
  });

  it('CHECK rejects (mode=query, question=empty string)', async () => {
    await expect(
      testDb`
        INSERT INTO public.reasoning_reports (mode, question, report)
        VALUES ('query', '', ${`${TEST_REPORT_MARKER} empty-question`})
      `,
    ).rejects.toThrow(/reasoning_reports_query_question_required|check constraint/i);
  });

  it('CHECK rejects (mode=query, question=whitespace-only)', async () => {
    await expect(
      testDb`
        INSERT INTO public.reasoning_reports (mode, question, report)
        VALUES ('query', '   ', ${`${TEST_REPORT_MARKER} whitespace-question`})
      `,
    ).rejects.toThrow(/reasoning_reports_query_question_required|check constraint/i);
  });

  it('CHECK admits (mode=query, question=non-blank string)', async () => {
    const rows = await testDb<Array<{ id: string; mode: string; question: string }>>`
      INSERT INTO public.reasoning_reports (mode, question, report)
      VALUES (
        'query',
        'why did entity X expire?',
        ${`${TEST_REPORT_MARKER} valid-query`}
      )
      RETURNING id, mode, question
    `;
    const inserted = rows[0]!;
    expect(inserted.mode).toBe('query');
    expect(inserted.question).toBe('why did entity X expire?');
  });

  // Patrol mode is unaffected — the CHECK predicate short-circuits on
  // `mode <> 'query'`. Confirms no behavioural change for the existing
  // patrol writers (src/index.ts:1108, src/services/graph-stats.ts:407).
  it('CHECK admits (mode=patrol, question=NULL) — patrol unchanged', async () => {
    const rows = await testDb<Array<{ id: string; mode: string; question: string | null }>>`
      INSERT INTO public.reasoning_reports (mode, question, report)
      VALUES (
        'patrol',
        NULL,
        ${`${TEST_REPORT_MARKER} patrol-no-question`}
      )
      RETURNING id, mode, question
    `;
    const inserted = rows[0]!;
    expect(inserted.mode).toBe('patrol');
    expect(inserted.question).toBeNull();
  });

  it('CHECK admits (mode=patrol, question=non-blank) — patrol unchanged', async () => {
    const rows = await testDb<Array<{ id: string; mode: string; question: string | null }>>`
      INSERT INTO public.reasoning_reports (mode, question, report)
      VALUES (
        'patrol',
        'patrol may also record a question',
        ${`${TEST_REPORT_MARKER} patrol-with-question`}
      )
      RETURNING id, mode, question
    `;
    const inserted = rows[0]!;
    expect(inserted.mode).toBe('patrol');
    expect(inserted.question).toBe('patrol may also record a question');
  });
});
