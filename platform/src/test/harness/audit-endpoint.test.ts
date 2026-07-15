/**
 * POST /api/audit route — actor-pin + wiring (bead nmemo-uhp.12.4, criterion 3a).
 *
 * The audit actor is derived from the ROUTE, never the request body. This is the
 * route-level half of the actor-pin; the MCP-surface half (audit_agent cannot call
 * a non-AUDIT_SURFACE tool — deny-by-default allow-list) is covered by
 * audit-mcp.test.ts. Together they are the defense-in-depth the /api/audit comment
 * describes.
 *
 * Asserts:
 *   - a body-supplied `actor` is REJECTED (400) and no run is created (the guard
 *     returns before runAuditPass);
 *   - a well-formed body (no actor) reaches runAuditPass and returns its result
 *     shape — over EMPTY corpora so recall yields 0 cells and the agent never
 *     spawns, keeping the happy path ML-free;
 *   - a body missing required fields is rejected (400).
 *
 * Route tests drive app.request() directly; the network listener is skipped under
 * VITEST (see index.ts). Mirrors decay-endpoint.test.ts.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { testDb } from '../setup.js';
import { app } from '../../index.js';
import { ensureAuditLedger } from '../../services/audit-ledger.js';

const RUN_NAMES = ['audit-ep-reject', 'audit-ep-ok', 'audit-ep-missing'];
// Empty corpora: no entities ⇒ recall returns 0 candidates ⇒ the agent never spawns.
const SRC = 'audit_ep_src_empty';
const TGT = 'audit_ep_tgt_empty';

async function post(body: unknown): Promise<Response> {
  // app.request() is typed Response | Promise<Response>; await narrows to Response.
  return await app.request('/api/audit', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function auditRunExists(name: string): Promise<boolean> {
  await ensureAuditLedger();
  const r = await testDb`SELECT 1 FROM public.audit_runs WHERE name = ${name}`;
  return r.length > 0;
}

describe('POST /api/audit — actor-pin + wiring (nmemo-uhp.12.4)', () => {
  afterEach(async () => {
    await ensureAuditLedger();
    await testDb`DELETE FROM public.audit_coverage WHERE run_id IN (SELECT id FROM public.audit_runs WHERE name = ANY(${RUN_NAMES}::text[]))`;
    await testDb`DELETE FROM public.audit_runs WHERE name = ANY(${RUN_NAMES}::text[])`;
    await testDb`DELETE FROM public.entities WHERE corpus_id IN (${SRC}, ${TGT})`;
  });

  it('rejects a body-supplied actor (400) — actor is route-derived; no run created', async () => {
    const res = await post({
      actor: 'graph_agent', // spoof attempt
      name: 'audit-ep-reject',
      sourceCorpusId: SRC,
      targetCorpusId: TGT,
      ruleSetHash: 'h',
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { triggered: boolean; error: string };
    expect(body.triggered).toBe(false);
    expect(body.error).toMatch(/route-derived|audit_agent/i);
    // The guard returns before runAuditPass, so the run is never created.
    expect(await auditRunExists('audit-ep-reject')).toBe(false);
  });

  it('accepts a well-formed body (no actor) and reaches runAuditPass (empty corpora ⇒ ML-free)', async () => {
    const res = await post({
      name: 'audit-ep-ok',
      sourceCorpusId: SRC,
      targetCorpusId: TGT,
      ruleSetHash: 'h',
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { triggered: boolean; seeded: number; swept: number; runId: string };
    expect(body.triggered).toBe(true);
    expect(body.seeded).toBe(0); // no entities in these corpora
    expect(body.swept).toBe(0);
    expect(typeof body.runId).toBe('string');
    expect(await auditRunExists('audit-ep-ok')).toBe(true);
  });

  it('rejects a body missing required fields (400)', async () => {
    const res = await post({ name: 'audit-ep-missing' }); // no corpora / hash
    expect(res.status).toBe(400);
    const body = (await res.json()) as { triggered: boolean; error: string };
    expect(body.triggered).toBe(false);
    expect(body.error).toMatch(/requires/i);
  });
});
