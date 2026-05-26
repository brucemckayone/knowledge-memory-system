/**
 * Bead nmemo-2yv.67 — auto-triggered gardener runs are persisted.
 *
 * Tests exercise recordGardeningRun() directly with both trigger surfaces
 * so the audit-log behaviour can be asserted deterministically without
 * spinning up ml-services or the gardener LLM. The behavioural acceptance
 * bullets (sequence of 5+ ingests producing 'auto' rows; manual /api/garden
 * still producing 'manual' rows) are best verified via /verify against a
 * live stack — these tests cover the helper's contract for both paths.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { recordGardeningRun, parseGardenerReportCounts } from '../../services/gardening.js';
import { testDb } from '../setup.js';

const TEST_REPORT_PREFIX = '[bead-67-test]';

async function deleteTestRows(): Promise<void> {
  await testDb`DELETE FROM public.gardening_reports WHERE report_text LIKE ${`${TEST_REPORT_PREFIX}%`}`;
}

describe('bead nmemo-2yv.67 — recordGardeningRun', () => {
  beforeEach(async () => {
    await deleteTestRows();
  });

  it('persists a manual run with trigger_type="manual" (no regression vs prior /api/garden insert)', async () => {
    const report = `${TEST_REPORT_PREFIX} manual\n\n### TOPOLOGY OVERVIEW\n- 0 entities`;
    const id = await recordGardeningRun({
      trigger: 'manual',
      report,
      durationMs: 1234,
    });
    expect(id).toMatch(/^[0-9a-f-]{36}$/);

    const rows = await testDb`
      SELECT trigger_type, report_text, duration_ms, runs_since_last,
             same_as_created, merges_executed, facts_created, summaries_updated, islands_investigated
      FROM public.gardening_reports
      WHERE id = ${id}::uuid
    `;
    expect(rows.length).toBe(1);
    expect(rows[0]!.trigger_type).toBe('manual');
    expect(rows[0]!.report_text).toBe(report);
    expect(rows[0]!.duration_ms).toBe(1234);
    expect(rows[0]!.runs_since_last).toBe(0);
  });

  it('persists an auto run with trigger_type="auto" AND records runs_since_last (closes bead .67 audit gap)', async () => {
    const report = `${TEST_REPORT_PREFIX} auto\n\n### TOPOLOGY OVERVIEW\n- 5 entities`;
    const id = await recordGardeningRun({
      trigger: 'auto',
      runsSinceLast: 5,
      report,
      durationMs: 9876,
    });

    const rows = await testDb`
      SELECT trigger_type, report_text, duration_ms, runs_since_last
      FROM public.gardening_reports
      WHERE id = ${id}::uuid
    `;
    expect(rows.length).toBe(1);
    expect(rows[0]!.trigger_type).toBe('auto');
    expect(rows[0]!.report_text).toBe(report);
    expect(rows[0]!.duration_ms).toBe(9876);
    expect(rows[0]!.runs_since_last).toBe(5);
  });

  it('falls back to "(no report)" when the agent returns empty text', async () => {
    const id = await recordGardeningRun({
      trigger: 'auto',
      runsSinceLast: 5,
      report: '',
      durationMs: 100,
    });
    const rows = await testDb`
      SELECT report_text FROM public.gardening_reports WHERE id = ${id}::uuid
    `;
    expect(rows[0]!.report_text).toBe('(no report)');
  });

  it('parses action counts from a well-formed report (sanity-parse populates the schema columns)', async () => {
    const report = `${TEST_REPORT_PREFIX} counts
### TOPOLOGY OVERVIEW
- 10 entities

### ISLANDS INVESTIGATED
- Island A: foo, bar
- Island B: baz

### CONSOLIDATIONS
- EntityA <-> EntityB -> SAME_AS (conf=0.85) — narrative perspective shift
- EntityC -> merged into EntityD — name typo
- EntityE -> merged into EntityF — duplicate extraction

### FACTS CREATED
- (subject, predicate, object) — bridge fact

### SUMMARIES UPDATED
- EntityX — note same_as link
- EntityY — note merge survivor
`;
    const id = await recordGardeningRun({
      trigger: 'auto',
      runsSinceLast: 5,
      report,
      durationMs: 5000,
    });
    const rows = await testDb`
      SELECT same_as_created, merges_executed, facts_created, summaries_updated, islands_investigated
      FROM public.gardening_reports
      WHERE id = ${id}::uuid
    `;
    expect(rows[0]!.same_as_created).toBe(1);
    expect(rows[0]!.merges_executed).toBe(2);
    expect(rows[0]!.facts_created).toBe(1);
    expect(rows[0]!.summaries_updated).toBe(2);
    expect(rows[0]!.islands_investigated).toBe(2);
  });

  it('parser returns zeros for an unparseable / malformed report (bead spec accepts fragile parsing)', () => {
    const counts = parseGardenerReportCounts('this is not a structured report');
    expect(counts).toEqual({
      sameAsCreated: 0,
      mergesExecuted: 0,
      factsCreated: 0,
      summariesUpdated: 0,
      islandsInvestigated: 0,
    });
  });

  it('parser handles "(no report)" sentinel without errors', () => {
    const counts = parseGardenerReportCounts('(no report)');
    expect(counts.sameAsCreated).toBe(0);
    expect(counts.mergesExecuted).toBe(0);
  });
});
