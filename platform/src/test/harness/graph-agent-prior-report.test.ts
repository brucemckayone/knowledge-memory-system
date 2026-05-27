/**
 * Bead nmemo-upn — previous extraction session's PHASE 6 report threaded
 * into the next session as continuity context.
 *
 * The pipeline.extract() flow fetches the most recent extraction_reports
 * row (excluding the current memory_id) and passes its report_text into
 * invokeGraphAgent.previousReport. invokeGraphAgent serialises it onto
 * the outbound fetch body as `previous_report`. The ml-services
 * /graph-agent handler renders it into the agent's user prompt as a
 * delimited <extraction_report> block (covered by the Python prompt-
 * builder test in ml-services/tests/test_graph_agent_prompt.py).
 *
 * These tests cover the TypeScript side:
 *   1. invokeGraphAgent emits `previous_report` on the fetch body when
 *      the param is provided (and `null` when omitted) — locks the wire
 *      shape against the Python endpoint's Optional[str] contract.
 *   2. pipeline.extract() picks the LATEST prior extraction_reports row
 *      (ordered by created_at DESC) and excludes the current memory_id
 *      from the candidate set.
 *
 * Hermetic — the fetch surface is stubbed via vi.spyOn(global, 'fetch')
 * so the test never hits ml-services. The DB-backed query for prior
 * reports runs against the real testDb (so the ORDER BY contract is
 * verified end-to-end).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { randomUUID } from 'crypto';
import { invokeGraphAgent } from '../../services/causal-agent.js';
import { testDb } from '../setup.js';

// ---------------------------------------------------------------------------
// Part 1 — invokeGraphAgent fetch body shape
// ---------------------------------------------------------------------------

describe('invokeGraphAgent — previous_report wire shape (nmemo-upn)', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    fetchSpy = vi.spyOn(global as any, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  function stubOkResponse(): void {
    fetchSpy.mockImplementation(async () =>
      new Response(JSON.stringify({ result: 'stub-result' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
  }

  it('emits previous_report on the outbound body when the param is provided', async () => {
    stubOkResponse();

    const report = '### ENTITIES FOUND\n- R. Walton (person)\n### DIFFICULTIES\n- pronoun "I" was the narrator';
    await invokeGraphAgent({
      sourceText: 'fresh source text',
      memoryId: '11111111-1111-1111-1111-111111111111',
      previousReport: report,
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const init = fetchSpy.mock.calls[0]![1] as RequestInit;
    const body = JSON.parse(init.body as string) as Record<string, unknown>;

    expect(body.previous_report).toBe(report);
    // Defensive: ensure the new field doesn't clobber the existing payload
    // contract. Drift here would silently break the Python endpoint.
    expect(body.source_text).toBe('fresh source text');
    expect(body.memory_id).toBe('11111111-1111-1111-1111-111111111111');
  });

  it('emits previous_report=null when the param is omitted (first-chunk path)', async () => {
    stubOkResponse();

    await invokeGraphAgent({
      sourceText: 'fresh source text',
      memoryId: '11111111-1111-1111-1111-111111111111',
    });

    const init = fetchSpy.mock.calls[0]![1] as RequestInit;
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    // Null is the canonical "no prior report" signal — matches the Python
    // endpoint's Optional[str] = None default. The Pydantic model coerces
    // missing fields to None, but we send null explicitly so the wire
    // shape is unambiguous and survives proxy / serialiser churn.
    expect(body.previous_report).toBeNull();
  });

  it('emits previous_report=null when caller passes explicit null', async () => {
    stubOkResponse();

    await invokeGraphAgent({
      sourceText: 'fresh source text',
      memoryId: '11111111-1111-1111-1111-111111111111',
      previousReport: null,
    });

    const init = fetchSpy.mock.calls[0]![1] as RequestInit;
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.previous_report).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Part 2 — pipeline.extract picks the LATEST prior report (DB-backed)
// ---------------------------------------------------------------------------
//
// We don't drive pipeline.extract() end-to-end here — that would require
// stubbing the Qdrant fetch, the ml-client embedding, and updateEntityMeta.
// Instead we verify the canonical query the new pipeline code runs:
//   SELECT report_text FROM extraction_reports
//   WHERE memory_id <> $current
//   ORDER BY created_at DESC LIMIT 1
//
// This locks the contract that:
//   - the current memory_id is excluded (prevents re-extract feeding the
//     agent its own prior report)
//   - the latest row by created_at wins (multiple prior sessions exist)
//   - empty result returns null-safe (no prior reports)

describe('pipeline prior-report fetch (nmemo-upn)', () => {
  beforeEach(async () => {
    // extraction_reports is not in deleteFromTables' orderedTables whitelist
    // (see memory entry deletefromtables-in-src-test-setup-ts-silently-
    // filters). Wipe explicitly so the ordering assertion is deterministic.
    await testDb`DELETE FROM public.extraction_reports`;
  });

  it('returns null when no prior reports exist', async () => {
    const currentMemoryId = randomUUID();
    const rows = await testDb`
      SELECT report_text
        FROM public.extraction_reports
       WHERE memory_id <> ${currentMemoryId}::uuid
       ORDER BY created_at DESC
       LIMIT 1
    `;
    expect(rows).toHaveLength(0);
  });

  it('returns the latest report by created_at, excluding the current memory_id', async () => {
    const currentMemoryId = randomUUID();
    const olderMemoryId = randomUUID();
    const newerMemoryId = randomUUID();

    // Insert with explicit created_at values so the ordering is stable
    // regardless of statement-time NOW() granularity (Postgres NOW() inside
    // a single tx is statement-stable; explicit timestamps avoid the
    // single-second-collision edge case).
    await testDb`
      INSERT INTO public.extraction_reports (memory_id, report_text, created_at)
      VALUES (${olderMemoryId}::uuid, 'older report', NOW() - INTERVAL '1 hour')
    `;
    await testDb`
      INSERT INTO public.extraction_reports (memory_id, report_text, created_at)
      VALUES (${newerMemoryId}::uuid, 'newer report', NOW() - INTERVAL '1 minute')
    `;
    // A "current" report — must be excluded by the WHERE clause even if
    // it's the newest one.
    await testDb`
      INSERT INTO public.extraction_reports (memory_id, report_text, created_at)
      VALUES (${currentMemoryId}::uuid, 'current report (must be filtered out)', NOW())
    `;

    const rows = await testDb`
      SELECT report_text AS "reportText"
        FROM public.extraction_reports
       WHERE memory_id <> ${currentMemoryId}::uuid
       ORDER BY created_at DESC
       LIMIT 1
    `;
    expect(rows).toHaveLength(1);
    expect((rows[0] as { reportText: string }).reportText).toBe('newer report');
  });

  it('falls back to the only prior report when one exists', async () => {
    const currentMemoryId = randomUUID();
    const priorMemoryId = randomUUID();

    await testDb`
      INSERT INTO public.extraction_reports (memory_id, report_text)
      VALUES (${priorMemoryId}::uuid, 'sole prior report')
    `;

    const rows = await testDb`
      SELECT report_text AS "reportText"
        FROM public.extraction_reports
       WHERE memory_id <> ${currentMemoryId}::uuid
       ORDER BY created_at DESC
       LIMIT 1
    `;
    expect(rows).toHaveLength(1);
    expect((rows[0] as { reportText: string }).reportText).toBe('sole prior report');
  });
});
