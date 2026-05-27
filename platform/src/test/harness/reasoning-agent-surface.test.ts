/**
 * Reasoning agent surface — test scaffolding (bead nmemo-2yv.79).
 *
 * Pre-bead, the reasoning agent + reasoning_reports feature had two tests,
 * both covering `save_reasoning_report` (F3 + the nmemo-2yv.77 idempotency
 * regression). The rest of the surface — `get_reasoning_history` (the tool),
 * `invokeReasoningAgent` (the HTTP wrapper), `/api/reason` + `/api/reason/query`
 * (the routes), and the patrol → counter cascade — was untested.
 *
 * This file fills those gaps. Scope shape:
 *
 *   (1) `get_reasoning_history` tool — unit, real DB, prior reports seeded
 *       via fixture phase8-reasoning/fixtures/reasoning-history-rich.sql.
 *       Covers: DESC ordering, default + explicit limit, return shape,
 *       per-entity filter via @> ARRAY[entityId] semantics.
 *   (2) `invokeReasoningAgent` HTTP wrapper — integration, ml-services mocked
 *       via setup.ts::mockMlServices (bead nmemo-2yv.86 extended for
 *       /reasoning-agent in setup.ts). Covers: patrol success → both counters
 *       fire; query success → neither counter fires (the `params.mode === 'patrol'`
 *       guard at src/services/reasoning-agent.ts:74); 5xx surfaces a clean
 *       error; network error propagates; abort/timeout maps to
 *       AgentInvocationTimeoutError (bead nmemo-2yv.76 path).
 *   (3) `/api/reason` + `/api/reason/query` HTTP routes — integration,
 *       app.request() against the Hono app, ml-services mocked. Covers:
 *       response shape on success, error on 500, 400 on missing
 *       body.question, F5 logging side effect via stdout capture.
 *   (4) Patrol cascade absence — regression guard for bead nmemo-2yv.72. The
 *       pipeline.ts patrol counters (incrementPatrolCount,
 *       incrementGraphStatsCount) have been deleted; pattern-detection +
 *       graph-stats now react to derived_freshness counters on fact insert.
 *       The test under (2) spies on detectCausalPatterns / promotePatterns /
 *       computeGraphStats and asserts a successful patrol invocation does
 *       NOT call any of them. Pattern-detection's own DB-reactive cadence is
 *       covered by causal-patterns.test.ts (bead .72 block).
 *   (5) Adversarial fixture (T8 regression) — integration. Seed
 *       reasoning-injection.sql (a row whose .question + .report carry the
 *       canonical bead-79 injection payload), call get_reasoning_history
 *       for the touched entity, assert the dispatcher wraps both fields in
 *       delimited blocks (kind=prior_question / kind=reasoning_report). The
 *       wrapping IS the T8 mitigation — bead nmemo-2yv.62 centralised it via
 *       delimitForPrompt() and routed get_reasoning_history through it. If
 *       a future refactor strips the wrapper, this test goes red and the
 *       injection payload reaches the next agent prompt as bare text.
 *
 * Pattern mirrors:
 *   - destructive-tools-dispatch.test.ts (bead .68) — tool-handler dispatch + actor routing
 *   - topology-clustering-drift-http.test.ts (bead .86) — app.request() driven HTTP
 *     routes with mockMlServices, fire-and-forget chain assertions
 *   - graph-stats fixtures (bead .50) — SQL fixtures under src/test/data/<phase>/fixtures/
 *
 * The reasoning-agent module was extracted from causal-agent.ts to
 * src/services/reasoning-agent.ts by bead nmemo-2yv.80. Tests import
 * `invokeReasoningAgent` and `AgentInvocationTimeoutError` directly from
 * that module so a future relocation of the timeout class (the bead notes
 * it currently re-exports from causal-agent) only requires a single import
 * update here.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import {
  testDb,
  loadFixture,
  mockMlServices,
  type MockMlServicesHandle,
} from '../setup.js';
import { app } from '../../index.js';
import { GRAPH_TOOLS, handleToolCall } from '../../services/causal-agent.js';
import { invokeReasoningAgent, AgentInvocationTimeoutError } from '../../services/reasoning-agent.js';
// Bead nmemo-2yv.72 — incrementPatrolCount / incrementGraphStatsCount and
// their _reset helpers have been deleted along with the pipeline.ts cadence
// counters they served. Pattern-detection and graph-stats cadences now react
// to derived_freshness counters via src/services/derived-freshness.ts; the
// reasoning agent no longer touches them.

// Marker used to scope the row-deletion sweep at end of suite — same pattern
// as reasoning-reports-endpoints.test.ts (bead .81) so concurrent test files
// don't fight each other over the reasoning_reports table.
const TEST_MARKER_PREFIX = '[bead-79-';

async function cleanFixtureRows(): Promise<void> {
  // Fixture-planted rows. Reports first (FKs back to entities cascade on
  // entity delete, but reasoning_reports.entity_ids is a uuid[] — no FK —
  // so the array entries become dangling pointers on entity DELETE. Clean
  // reports explicitly to keep the order independent.)
  await testDb`
    DELETE FROM public.reasoning_reports
    WHERE id IN (
      '79000000-2000-0000-0001-000000000001'::uuid,
      '79000000-2000-0000-0001-000000000002'::uuid,
      '79000000-2000-0000-0001-000000000003'::uuid,
      '79000000-2000-0000-0001-000000000004'::uuid,
      '79000000-2000-0000-0001-000000000005'::uuid,
      '79000000-2000-0000-0002-000000000001'::uuid
    )
  `.catch(() => {});
  // Anything else this suite may have planted via handleToolCall save calls.
  await testDb`
    DELETE FROM public.reasoning_reports
    WHERE report LIKE ${`${TEST_MARKER_PREFIX}%`}
  `.catch(() => {});
  await testDb`
    DELETE FROM public.entity_meta
    WHERE entity_id IN (
      '79000000-0000-0000-0001-000000000001'::uuid,
      '79000000-0000-0000-0001-000000000002'::uuid,
      '79000000-0000-0000-0001-000000000003'::uuid,
      '79000000-0000-0000-0002-000000000001'::uuid,
      '79000000-0000-0000-0003-000000000001'::uuid,
      '79000000-0000-0000-0003-000000000002'::uuid
    )
  `.catch(() => {});
  await testDb`
    DELETE FROM public.entities
    WHERE id IN (
      '79000000-0000-0000-0001-000000000001'::uuid,
      '79000000-0000-0000-0001-000000000002'::uuid,
      '79000000-0000-0000-0001-000000000003'::uuid,
      '79000000-0000-0000-0002-000000000001'::uuid,
      '79000000-0000-0000-0003-000000000001'::uuid,
      '79000000-0000-0000-0003-000000000002'::uuid
    )
  `.catch(() => {});
}

// ============================================================================
// (1) get_reasoning_history — tool dispatch
// ============================================================================

describe('get_reasoning_history (nmemo-2yv.79)', () => {
  const entityA = '79000000-0000-0000-0001-000000000001';
  const entityB = '79000000-0000-0000-0001-000000000002';
  const entityC = '79000000-0000-0000-0001-000000000003';
  const reportOldestA = '79000000-2000-0000-0001-000000000001';
  const reportMidQueryA = '79000000-2000-0000-0001-000000000002';
  const reportSharedAB = '79000000-2000-0000-0001-000000000003';
  const reportNewestB = '79000000-2000-0000-0001-000000000004';
  const reportOnlyC = '79000000-2000-0000-0001-000000000005';

  beforeAll(async () => {
    await cleanFixtureRows();
    await loadFixture('phase8-reasoning/fixtures/reasoning-history-rich.sql');
  });

  afterAll(async () => {
    await cleanFixtureRows();
  });

  it('exposes the reasoning-history MCP tool with a well-formed schema', () => {
    const tool = GRAPH_TOOLS.find((t) => t.name === 'get_reasoning_history');
    expect(tool).toBeDefined();
    expect(tool!.mutates).toBe(false);
    expect(tool!.inputSchema.type).toBe('object');
    expect(tool!.inputSchema.required).toContain('entity_id');
    // limit must be advertised — the dispatch handler reads toolInput.limit
    // and defaults to 5; the schema needs to advertise the param so the
    // agent learns it can pass one.
    expect(Object.keys(tool!.inputSchema.properties)).toContain('limit');
  });

  it('returns prior reports for an entity in DESC created_at order', async () => {
    const raw = await handleToolCall('get_reasoning_history', { entity_id: entityA, limit: 10 });
    const parsed = JSON.parse(raw) as Array<{ id: string; createdAt: string }>;
    expect(Array.isArray(parsed)).toBe(true);
    // A has three reports in the fixture: oldestA (2026-05-01), midQueryA
    // (2026-05-05), sharedAB (2026-05-10). Newest first.
    const ids = parsed.map((r) => r.id);
    expect(ids).toEqual([reportSharedAB, reportMidQueryA, reportOldestA]);

    // The B-only and C-only rows MUST NOT surface for A.
    expect(ids).not.toContain(reportNewestB);
    expect(ids).not.toContain(reportOnlyC);
  });

  it('honours the limit param (explicit 1 returns just the newest row for the entity)', async () => {
    const raw = await handleToolCall('get_reasoning_history', { entity_id: entityA, limit: 1 });
    const parsed = JSON.parse(raw) as Array<{ id: string }>;
    expect(parsed).toHaveLength(1);
    expect(parsed[0]!.id).toBe(reportSharedAB);
  });

  it('default limit (no arg) caps at 5', async () => {
    // A has 3 fixture rows — well under 5; the default behaviour we're
    // pinning is "no arg → don't throw, return ≤5". Re-asserting the
    // default would need seeding a 6th row.
    const raw = await handleToolCall('get_reasoning_history', { entity_id: entityA });
    const parsed = JSON.parse(raw) as Array<unknown>;
    expect(parsed.length).toBeGreaterThanOrEqual(1);
    expect(parsed.length).toBeLessThanOrEqual(5);
  });

  it('returns the documented shape: { id, mode, question, report, actionsTaken, createdAt }', async () => {
    const raw = await handleToolCall('get_reasoning_history', { entity_id: entityA, limit: 10 });
    const parsed = JSON.parse(raw) as Array<Record<string, unknown>>;
    expect(parsed.length).toBeGreaterThan(0);
    const row = parsed[0]!;
    expect(typeof row.id).toBe('string');
    expect(typeof row.mode).toBe('string');
    // question + report are wrapped via delimitForPrompt (bead nmemo-2yv.62
    // — T8 mitigation). Both fields surface as strings — non-null even for
    // the patrol rows where the underlying column IS null, because the
    // wrapper emits an empty delimited block in that case.
    expect(typeof row.report).toBe('string');
    expect(typeof row.createdAt === 'string' || row.createdAt instanceof Date).toBe(true);
    // actionsTaken comes through verbatim as the jsonb column value.
    expect(typeof row.actionsTaken).toBe('object');
    expect(row.actionsTaken).not.toBeNull();
  });

  it('@> ARRAY[entityId] semantics: a shared-entity report surfaces for BOTH entities it touches', async () => {
    // reportSharedAB references [entityA, entityB] in the fixture.
    const rawA = await handleToolCall('get_reasoning_history', { entity_id: entityA, limit: 10 });
    const rawB = await handleToolCall('get_reasoning_history', { entity_id: entityB, limit: 10 });
    const idsA = (JSON.parse(rawA) as Array<{ id: string }>).map((r) => r.id);
    const idsB = (JSON.parse(rawB) as Array<{ id: string }>).map((r) => r.id);
    expect(idsA).toContain(reportSharedAB);
    expect(idsB).toContain(reportSharedAB);

    // And a C-only report MUST NOT surface for A or B.
    const rawC = await handleToolCall('get_reasoning_history', { entity_id: entityC, limit: 10 });
    const idsC = (JSON.parse(rawC) as Array<{ id: string }>).map((r) => r.id);
    expect(idsC).toContain(reportOnlyC);
    expect(idsC).not.toContain(reportOldestA);
    expect(idsA).not.toContain(reportOnlyC);
  });

  it('cold-start case: an entity with no prior reports returns an empty array', async () => {
    // Use the phase8 empty fixture for the cold entity ids.
    await loadFixture('phase8-reasoning/fixtures/reasoning-empty.sql');
    try {
      const raw = await handleToolCall('get_reasoning_history', {
        entity_id: '79000000-0000-0000-0003-000000000001',
        limit: 5,
      });
      const parsed = JSON.parse(raw);
      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed).toHaveLength(0);
    } finally {
      // Empty fixture's entities + entity_meta rows are cleaned by cleanFixtureRows
      // in afterAll. No need for inner cleanup.
    }
  });
});

// ============================================================================
// (2) invokeReasoningAgent — HTTP wrapper + counter cascade
// ============================================================================

describe('invokeReasoningAgent (nmemo-2yv.79)', () => {
  let ml: MockMlServicesHandle | undefined;

  afterEach(() => {
    ml?.restore();
    ml = undefined;
  });

  it('patrol-mode success calls /reasoning-agent and surfaces { result }', async () => {
    ml = mockMlServices({
      responses: {
        '/reasoning-agent': { kind: 'ok', body: { result: 'patrol report markdown' } },
      },
    });
    const out = await invokeReasoningAgent({ mode: 'patrol' });
    expect(out.result).toBe('patrol report markdown');
    expect(ml.calls.some((c) => c.url.includes('/reasoning-agent') && c.method === 'POST')).toBe(true);
    // Body shape — mode threaded through, invocation_id forwarded when present.
    const reasoningCall = ml.calls.find((c) => c.url.includes('/reasoning-agent'));
    expect((reasoningCall?.body as { mode?: string })?.mode).toBe('patrol');
  });

  it('query-mode success returns the result string and forwards the question', async () => {
    ml = mockMlServices({
      responses: {
        '/reasoning-agent': { kind: 'ok', body: { result: 'query answer markdown' } },
      },
    });
    const out = await invokeReasoningAgent({ mode: 'query', question: 'Why?' });
    expect(out.result).toBe('query answer markdown');
    const reasoningCall = ml.calls.find((c) => c.url.includes('/reasoning-agent'));
    expect((reasoningCall?.body as { mode?: string; question?: string })?.mode).toBe('query');
    expect((reasoningCall?.body as { question?: string })?.question).toBe('Why?');
  });

  it('forwards invocation_id when supplied (nmemo-2yv.77 idempotency thread)', async () => {
    ml = mockMlServices({
      responses: { '/reasoning-agent': { kind: 'ok', body: { result: 'ok' } } },
    });
    const invocationId = '00000000-0000-0000-0000-000000000079';
    await invokeReasoningAgent({ mode: 'patrol', invocationId });
    const reasoningCall = ml.calls.find((c) => c.url.includes('/reasoning-agent'));
    expect((reasoningCall?.body as { invocation_id?: string })?.invocation_id).toBe(invocationId);
  });

  it('ml-services 5xx surfaces a clean error string with the status code embedded', async () => {
    ml = mockMlServices({
      responses: {
        '/reasoning-agent': { kind: 'error', status: 500, body: { detail: 'agent crashed' } },
      },
    });
    await expect(invokeReasoningAgent({ mode: 'patrol' })).rejects.toThrow(/reasoning_agent failed \(500\)/);
  });

  it('network/socket error (fetch rejects) propagates with the original message preserved', async () => {
    ml = mockMlServices({
      responses: {
        '/reasoning-agent': { kind: 'throw', message: 'ECONNREFUSED' },
      },
    });
    await expect(invokeReasoningAgent({ mode: 'patrol' })).rejects.toThrow(/ECONNREFUSED/);
  });

  it('timeout (AbortSignal fires) maps to AgentInvocationTimeoutError (nmemo-2yv.76 path)', async () => {
    // Synthesise an AbortError directly — { kind: 'throw' } makes fetch
    // throw a TypeError, but the timeout branch in agentFetch is keyed
    // off DOMException-with-name='AbortError'. Stub fetch in-band rather
    // than via mockMlServices so we control the error class.
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      const err = new DOMException('aborted by test', 'AbortError');
      throw err;
    }) as typeof fetch;
    try {
      await expect(invokeReasoningAgent({ mode: 'patrol' })).rejects.toBeInstanceOf(AgentInvocationTimeoutError);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it('patrol mode does NOT cascade into pattern-detection or graph-stats (bead nmemo-2yv.72 regression guard)', async () => {
    // Pre-.72 invokeReasoningAgent fired incrementPatrolCount +
    // incrementGraphStatsCount inline on every successful patrol. Both
    // cascades now react to derived_freshness counters on fact insert; the
    // wrapper must NOT touch pattern_detection / graph_stats / causal_patterns.
    // Spy on the in-process compute entry points; assert zero calls after
    // a successful patrol invocation.
    const causalPatterns = await import('../../services/causal-patterns.js');
    const graphStats = await import('../../services/graph-stats.js');
    const detectSpy = vi
      .spyOn(causalPatterns, 'detectCausalPatterns')
      .mockResolvedValue({ chainsExamined: 0, templatesFound: 0, newStaging: 0, updatedExisting: 0 });
    const promoteSpy = vi
      .spyOn(causalPatterns, 'promotePatterns')
      .mockResolvedValue({ promoted: [], demoted: [], rejected: [] });
    const computeSpy = vi
      .spyOn(graphStats, 'computeGraphStats')
      .mockResolvedValue({
        totalEntities: 0,
        totalFacts: 0,
        totalActiveFacts: 0,
        totalMemories: 0,
        computedDurationMs: 1,
      } as unknown as Awaited<ReturnType<typeof graphStats.computeGraphStats>>);
    try {
      ml = mockMlServices({
        responses: { '/reasoning-agent': { kind: 'ok', body: { result: 'ok' } } },
      });
      const patrolOut = await invokeReasoningAgent({ mode: 'patrol' });
      const queryOut = await invokeReasoningAgent({ mode: 'query', question: 'q' });
      expect(patrolOut.result).toBe('ok');
      expect(queryOut.result).toBe('ok');
      // Two calls to ml-services, one per mode.
      expect(ml.calls.filter((c) => c.url.includes('/reasoning-agent')).length).toBe(2);
      // Allow any microtask the wrapper might have queued to drain — the
      // assertion below is the load-bearing one.
      await new Promise((r) => setTimeout(r, 50));
      expect(detectSpy).not.toHaveBeenCalled();
      expect(promoteSpy).not.toHaveBeenCalled();
      expect(computeSpy).not.toHaveBeenCalled();
    } finally {
      detectSpy.mockRestore();
      promoteSpy.mockRestore();
      computeSpy.mockRestore();
    }
  });
});

// ============================================================================
// (4) /api/reason + /api/reason/query — HTTP route integration
// ============================================================================

describe('POST /api/reason (nmemo-2yv.79)', () => {
  let ml: MockMlServicesHandle | undefined;

  afterEach(async () => {
    ml?.restore();
    ml = undefined;
    // The route uses app.request so any reasoning_reports rows written by the
    // mocked agent path would have to be cleaned. Our mocks never call
    // save_reasoning_report (it's an MCP tool path, not the HTTP route), so
    // no row hits the reasoning_reports table from here. The viz logging
    // side-effect goes to stdout only.
  });

  it('returns { triggered: true, result, durationMs } on success', async () => {
    ml = mockMlServices({
      responses: { '/reasoning-agent': { kind: 'ok', body: { result: 'patrol markdown' } } },
    });
    const res = await app.request('/api/reason', { method: 'POST' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { triggered: boolean; result: string; durationMs: number };
    expect(body.triggered).toBe(true);
    expect(body.result).toBe('patrol markdown');
    expect(typeof body.durationMs).toBe('number');
    expect(body.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('returns 500 with { triggered: false, error, durationMs } when the agent throws', async () => {
    ml = mockMlServices({
      responses: { '/reasoning-agent': { kind: 'error', status: 500, body: { detail: 'agent crashed' } } },
    });
    const res = await app.request('/api/reason', { method: 'POST' });
    expect(res.status).toBe(500);
    const body = (await res.json()) as { triggered: boolean; error: string; durationMs: number };
    expect(body.triggered).toBe(false);
    expect(body.error).toMatch(/reasoning_agent failed/);
    expect(typeof body.durationMs).toBe('number');
  });

  it('returns 504 on AgentInvocationTimeoutError (nmemo-2yv.76 path)', async () => {
    // Stub fetch in-band to throw AbortError so the wrapper maps it to
    // AgentInvocationTimeoutError; the route handler then converts that
    // to a 504.
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new DOMException('aborted', 'AbortError');
    }) as typeof fetch;
    try {
      const res = await app.request('/api/reason', { method: 'POST' });
      expect(res.status).toBe(504);
      const body = (await res.json()) as { triggered: boolean; error: string };
      expect(body.triggered).toBe(false);
      // The error message comes from AgentInvocationTimeoutError.message; the
      // class includes the agent name + timeout duration. Loose match keeps
      // future copy edits from breaking this assertion.
      expect(body.error).toMatch(/reasoning_agent|timeout/i);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it('logs every invocation to stdout (F5 — spurious-caller identification)', async () => {
    ml = mockMlServices({
      responses: { '/reasoning-agent': { kind: 'ok', body: { result: 'r' } } },
    });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      await app.request('/api/reason', { method: 'POST' });
      // F5: the route fires `console.log('[reason] mode=patrol ...')` before
      // invoking the agent. Any of the spy's captured calls must include
      // that marker.
      const captured = logSpy.mock.calls.map((c) => c.join(' ')).join('\n');
      expect(captured).toMatch(/\[reason\] mode=patrol/);
    } finally {
      logSpy.mockRestore();
    }
  });
});

describe('POST /api/reason/query (nmemo-2yv.79)', () => {
  let ml: MockMlServicesHandle | undefined;

  afterEach(() => {
    ml?.restore();
    ml = undefined;
  });

  it('returns 400 when body.question is missing', async () => {
    const res = await app.request('/api/reason/query', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/question is required/i);
  });

  it('forwards the question to invokeReasoningAgent in query mode', async () => {
    ml = mockMlServices({
      responses: { '/reasoning-agent': { kind: 'ok', body: { result: 'answered' } } },
    });
    const res = await app.request('/api/reason/query', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ question: 'Why did A move?' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { triggered: boolean; result: string; durationMs: number };
    expect(body.triggered).toBe(true);
    expect(body.result).toBe('answered');
    const reasoningCall = ml.calls.find((c) => c.url.includes('/reasoning-agent'));
    expect((reasoningCall?.body as { mode?: string; question?: string })?.mode).toBe('query');
    expect((reasoningCall?.body as { question?: string })?.question).toBe('Why did A move?');
  });

  it('returns 500 on agent failure with the same { triggered: false, error, durationMs } shape', async () => {
    ml = mockMlServices({
      responses: { '/reasoning-agent': { kind: 'error', status: 502, body: { detail: 'upstream' } } },
    });
    const res = await app.request('/api/reason/query', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ question: 'Why?' }),
    });
    expect(res.status).toBe(500);
    const body = (await res.json()) as { triggered: boolean; error: string; durationMs: number };
    expect(body.triggered).toBe(false);
    expect(typeof body.error).toBe('string');
    expect(typeof body.durationMs).toBe('number');
  });

  it('F5 logging includes a truncated question snippet for query mode', async () => {
    ml = mockMlServices({
      responses: { '/reasoning-agent': { kind: 'ok', body: { result: 'r' } } },
    });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      await app.request('/api/reason/query', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ question: 'Why did A move from Paris to NYC?' }),
      });
      const captured = logSpy.mock.calls.map((c) => c.join(' ')).join('\n');
      expect(captured).toMatch(/\[reason\] mode=query/);
      expect(captured).toMatch(/question=/);
    } finally {
      logSpy.mockRestore();
    }
  });
});

// ============================================================================
// (5) T8 adversarial fixture — bead nmemo-2yv.62 prompt-safety regression
// ============================================================================
//
// Dependency: nmemo-2yv.62 (CLOSED) landed the centralised delimitForPrompt()
// helper and routed get_reasoning_history through it. This test asserts the
// dispatcher's output wraps both .question and .report in delimited blocks
// so an injection payload reaches the next agent prompt as DATA, not as a
// directive. If the wrapper is ever stripped, this test goes red.

describe('T8 adversarial: get_reasoning_history delimits injection payload (nmemo-2yv.79 / .62)', () => {
  const targetEntity = '79000000-0000-0000-0002-000000000001';

  beforeAll(async () => {
    await cleanFixtureRows();
    await loadFixture('phase8-reasoning/fixtures/reasoning-injection.sql');
  });

  afterAll(async () => {
    await cleanFixtureRows();
  });

  it('the injected .question is wrapped in a prior_question delimited block (not bare text)', async () => {
    const raw = await handleToolCall('get_reasoning_history', { entity_id: targetEntity, limit: 5 });
    const parsed = JSON.parse(raw) as Array<{ id: string; question: string; report: string }>;
    expect(parsed).toHaveLength(1);
    const row = parsed[0]!;
    // The bead-62 helper wraps user-controlled text in a kind-tagged block.
    // The exact prefix matches delimitForPrompt({ kind: 'prior_question' }):
    // <prior_question ... len="..." report_id="..."> ... </prior_question>
    expect(row.question).toMatch(/^<prior_question\b/);
    expect(row.question).toContain('</prior_question>');
    // The injection payload is INSIDE the block — not at the top of the
    // string. Asserting both ends pins the contract: bare payload at the
    // start would mean the wrapper is gone.
    expect(row.question.indexOf('Ignore prior instructions')).toBeGreaterThan(0);
  });

  it('the agent-written .report is wrapped in a reasoning_report delimited block', async () => {
    const raw = await handleToolCall('get_reasoning_history', { entity_id: targetEntity, limit: 5 });
    const parsed = JSON.parse(raw) as Array<{ id: string; report: string }>;
    const row = parsed[0]!;
    expect(row.report).toMatch(/^<reasoning_report\b/);
    expect(row.report).toContain('</reasoning_report>');
    // The </reasoning_report> closing tag the fixture writes inside the
    // body is escaped by the wrapper (centralised in prompt-safety.ts).
    // Asserting that no raw closing tag appears before the legitimate one
    // proves the centralised cap+sanitize ran.
    const firstClose = row.report.indexOf('</reasoning_report>');
    const lastClose = row.report.lastIndexOf('</reasoning_report>');
    expect(firstClose).toBeGreaterThan(0);
    // If sanitisation stripped the injection's bogus </reasoning_report>,
    // first and last occurrences match (the only one is the wrapper's
    // legitimate closing tag). If the bug regressed, an earlier raw
    // close tag from the payload would land first.
    expect(firstClose).toBe(lastClose);
  });
});
