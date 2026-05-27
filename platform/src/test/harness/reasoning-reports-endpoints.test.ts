/**
 * HTTP endpoint tests — GET /api/reasoning-reports[*] for the viz debug panel
 * (bead nmemo-2yv.81). Exercises the four GET routes added in src/index.ts
 * and the underlying service module src/services/reasoning-reports-query.ts.
 *
 * Acceptance criteria coverage:
 *   - list endpoint returns recent reports DESC with summary counts (no full
 *     body) and respects limit + mode filter
 *   - by-entity endpoint filters via GIN @> over entity_ids
 *   - single endpoint returns the full report (markdown + actions_taken)
 *   - cadence endpoint summarises mode counts, time-since-last patrol, and
 *     average duration when present in actions_taken
 *   - UUID guard rejects malformed ids with 400 (no SQL 22P02 leak)
 *   - mode validation rejects nonsense modes with 400
 *
 * Pattern mirrors contradictions.test.ts:977 / cross-cluster-generator
 * endpoint tests — `app.request(...)` against the exported Hono instance.
 *
 * Cleanup strategy: per-test deletion by the test marker prefix in `report`
 * column. We avoid the global cleanSlate so concurrent test files (which
 * also write reasoning_reports as a side effect of /api/reason invocation)
 * don't fight each other. Marker matches reasoning-reports-query-question-
 * check.test.ts:24.
 */

import { describe, it, expect, afterEach, beforeAll } from 'vitest';
import { app } from '../../index.js';
import { testDb } from '../setup.js';

const TEST_MARKER = '[bead-81-test]';

async function clearTestReports(): Promise<void> {
  await testDb`
    DELETE FROM public.reasoning_reports
    WHERE report LIKE ${`${TEST_MARKER}%`}
  `.catch(() => {});
}

interface SummaryRow {
  id: string;
  mode: 'patrol' | 'query';
  question: string | null;
  entityCount: number;
  factCount: number;
  causalEdgeCount: number;
  durationMs: number | null;
  createdAt: string;
  invocationId: string | null;
}

async function insertReport(opts: {
  mode: 'patrol' | 'query';
  question?: string | null;
  reportSuffix: string;
  entityIds?: string[];
  factIds?: string[];
  causalEdgeIds?: string[];
  actionsTaken?: object;
  createdAt?: Date;
}): Promise<string> {
  const entityArr = opts.entityIds ?? [];
  const factArr = opts.factIds ?? [];
  const edgeArr = opts.causalEdgeIds ?? [];
  const actionsTaken = opts.actionsTaken ?? {};
  // Cast UUID arrays via the postgres array literal form — matches the
  // codebase pattern in causal-agent.ts:2263.
  const entityLit = `{${entityArr.join(',')}}`;
  const factLit = `{${factArr.join(',')}}`;
  const edgeLit = `{${edgeArr.join(',')}}`;
  // JSONB: use postgres-js's .json() helper so the object lands as parsed
  // JSONB (not as a stringified scalar). The Record<string, unknown> cast
  // satisfies the helper's JSONValue typing — JSON-serialisable objects
  // are a strict subset of JSONValue at runtime.
  const rows = await testDb<Array<{ id: string }>>`
    INSERT INTO public.reasoning_reports
      (mode, question, report, entity_ids, fact_ids, causal_edge_ids, actions_taken, created_at)
    VALUES (
      ${opts.mode},
      ${opts.question ?? null},
      ${`${TEST_MARKER} ${opts.reportSuffix}`},
      ${entityLit}::uuid[],
      ${factLit}::uuid[],
      ${edgeLit}::uuid[],
      ${testDb.json(actionsTaken as never)},
      ${opts.createdAt ?? new Date()}
    )
    RETURNING id
  `;
  return rows[0]!.id;
}

async function insertEntity(name: string): Promise<string> {
  const rows = await testDb<Array<{ id: string }>>`
    INSERT INTO public.entities (canonical_name, entity_type)
    VALUES (${name}, 'concept')
    RETURNING id
  `;
  return rows[0]!.id;
}

describe('GET /api/reasoning-reports (bead nmemo-2yv.81)', () => {
  beforeAll(async () => {
    await clearTestReports();
  });
  afterEach(async () => {
    await clearTestReports();
  });

  it('returns recent reports DESC with summary counts', async () => {
    const olderId = await insertReport({
      mode: 'patrol',
      reportSuffix: 'older',
      createdAt: new Date(Date.now() - 60_000),
    });
    const newerId = await insertReport({
      mode: 'patrol',
      reportSuffix: 'newer',
    });

    const res = await app.request('/api/reasoning-reports?limit=50');
    expect(res.status).toBe(200);
    const body = await res.json() as { count: number; reports: SummaryRow[] };
    // The endpoint returns ALL recent rows (not just ours), but ours should be
    // present with newer ahead of older.
    const idsInOrder = body.reports.map(r => r.id);
    const newerIdx = idsInOrder.indexOf(newerId);
    const olderIdx = idsInOrder.indexOf(olderId);
    expect(newerIdx).toBeGreaterThanOrEqual(0);
    expect(olderIdx).toBeGreaterThanOrEqual(0);
    expect(newerIdx).toBeLessThan(olderIdx);

    // Body shape: lightweight summary (no full markdown).
    const newer = body.reports.find(r => r.id === newerId)!;
    expect(newer.mode).toBe('patrol');
    expect(newer).not.toHaveProperty('report');
    expect(newer).toHaveProperty('entityCount');
    expect(newer.entityCount).toBe(0);
  });

  it('respects ?limit= and clamps it', async () => {
    for (let i = 0; i < 3; i++) {
      await insertReport({ mode: 'patrol', reportSuffix: `limit-${i}` });
    }
    const res = await app.request('/api/reasoning-reports?limit=2');
    expect(res.status).toBe(200);
    const body = await res.json() as { reports: SummaryRow[] };
    expect(body.reports.length).toBeLessThanOrEqual(2);
  });

  it('filters by ?mode=query', async () => {
    await insertReport({ mode: 'patrol', reportSuffix: 'patrol-only' });
    await insertReport({
      mode: 'query',
      question: 'why?',
      reportSuffix: 'query-one',
    });

    const res = await app.request('/api/reasoning-reports?mode=query&limit=50');
    const body = await res.json() as { reports: SummaryRow[] };
    expect(body.reports.every(r => r.mode === 'query')).toBe(true);
  });

  it('rejects an invalid mode with 400', async () => {
    const res = await app.request('/api/reasoning-reports?mode=lolnope');
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toMatch(/mode/);
  });

  it('reports invocationId when set (idempotency .77) and null otherwise', async () => {
    // Direct insert with NULL invocation_id is the legacy path.
    const legacyId = await insertReport({ mode: 'patrol', reportSuffix: 'no-inv' });
    // Insert with explicit invocation_id via SQL to verify pass-through.
    const invId = '11111111-2222-3333-4444-555555555555';
    await testDb`
      INSERT INTO public.reasoning_reports (mode, report, invocation_id)
      VALUES ('patrol', ${`${TEST_MARKER} with-inv`}, ${invId}::uuid)
    `;
    const res = await app.request('/api/reasoning-reports?limit=200');
    const body = await res.json() as { reports: SummaryRow[] };
    const legacy = body.reports.find(r => r.id === legacyId);
    const withInv = body.reports.find(r => r.invocationId === invId);
    expect(legacy?.invocationId).toBeNull();
    expect(withInv).toBeTruthy();
  });
});

describe('GET /api/reasoning-reports/:id (bead nmemo-2yv.81)', () => {
  afterEach(async () => {
    await clearTestReports();
  });

  it('returns the full report including markdown body and array fields', async () => {
    const entityId = await insertEntity(`bead-81 entity ${Date.now()}`);
    const id = await insertReport({
      mode: 'query',
      question: 'how does this work?',
      reportSuffix: 'detail-body',
      entityIds: [entityId],
      actionsTaken: { durationMs: 1234, custom: 'arbitrary' },
    });
    const res = await app.request(`/api/reasoning-reports/${id}`);
    expect(res.status).toBe(200);
    const body = await res.json() as {
      id: string;
      mode: 'query';
      question: string;
      report: string;
      entityIds: string[];
      entityCount: number;
      actionsTaken: Record<string, unknown>;
      durationMs: number;
    };
    expect(body.id).toBe(id);
    expect(body.mode).toBe('query');
    expect(body.question).toBe('how does this work?');
    expect(body.report).toContain(TEST_MARKER);
    expect(body.entityIds).toEqual([entityId]);
    expect(body.entityCount).toBe(1);
    expect(body.actionsTaken.custom).toBe('arbitrary');
    expect(body.durationMs).toBe(1234);
  });

  it('returns 404 for a missing UUID', async () => {
    const res = await app.request('/api/reasoning-reports/00000000-0000-0000-0000-000000000000');
    expect(res.status).toBe(404);
  });

  it('returns 400 for a malformed UUID (no SQL leak)', async () => {
    const res = await app.request('/api/reasoning-reports/not-a-uuid');
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toMatch(/UUID/);
  });
});

describe('GET /api/reasoning-reports/by-entity/:entity_id (bead nmemo-2yv.81)', () => {
  afterEach(async () => {
    await clearTestReports();
  });

  it('filters to reports touching the given entity', async () => {
    const eA = await insertEntity(`bead-81 ent-A ${Date.now()}`);
    const eB = await insertEntity(`bead-81 ent-B ${Date.now()}`);
    const idA = await insertReport({
      mode: 'patrol',
      reportSuffix: 'touches-A',
      entityIds: [eA],
    });
    const idAB = await insertReport({
      mode: 'patrol',
      reportSuffix: 'touches-A-and-B',
      entityIds: [eA, eB],
    });
    const idB = await insertReport({
      mode: 'patrol',
      reportSuffix: 'touches-B-only',
      entityIds: [eB],
    });

    const resA = await app.request(`/api/reasoning-reports/by-entity/${eA}`);
    expect(resA.status).toBe(200);
    const bodyA = await resA.json() as { reports: SummaryRow[] };
    const idsA = bodyA.reports.map(r => r.id);
    expect(idsA).toContain(idA);
    expect(idsA).toContain(idAB);
    expect(idsA).not.toContain(idB);
  });

  it('returns 400 for a malformed entity_id', async () => {
    const res = await app.request('/api/reasoning-reports/by-entity/not-a-uuid');
    expect(res.status).toBe(400);
  });
});

describe('GET /api/reasoning-reports/cadence (bead nmemo-2yv.81)', () => {
  it('returns cadence summary with mode breakdown and ms-since-last', async () => {
    await clearTestReports();
    const recentPatrol = new Date(Date.now() - 5_000);
    await insertReport({ mode: 'patrol', reportSuffix: 'cad-patrol', createdAt: recentPatrol });
    await insertReport({
      mode: 'query',
      question: 'q?',
      reportSuffix: 'cad-query',
      actionsTaken: { durationMs: 2000 },
    });
    await insertReport({
      mode: 'patrol',
      reportSuffix: 'cad-patrol2',
      actionsTaken: { duration_ms: 4000 },
    });

    const res = await app.request('/api/reasoning-reports/cadence');
    expect(res.status).toBe(200);
    const body = await res.json() as {
      totalReports: number;
      windowSize: number;
      byMode: { patrol: number; query: number };
      lastPatrolAt: string | null;
      msSinceLastPatrol: number | null;
      lastQueryAt: string | null;
      msSinceLastQuery: number | null;
      avgDurationMs: number | null;
      lastReportAt: string | null;
    };
    // Cadence reads the recent window — our inserts must be reflected.
    expect(body.byMode.patrol).toBeGreaterThanOrEqual(2);
    expect(body.byMode.query).toBeGreaterThanOrEqual(1);
    expect(typeof body.msSinceLastPatrol).toBe('number');
    expect(body.msSinceLastPatrol).toBeGreaterThanOrEqual(0);
    // We seeded two duration entries (2000 and 4000); the window may contain
    // more rows from other tests, so we just assert numeric and finite.
    expect(typeof body.avgDurationMs).toBe('number');
    expect(Number.isFinite(body.avgDurationMs!)).toBe(true);
    expect(body.lastReportAt).not.toBeNull();
    await clearTestReports();
  });
});
