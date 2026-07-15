/**
 * Audit ledger DB suite (bead nmemo-uhp.12.1, Phase B).
 *
 * Verifies the self-ensured audit_runs + audit_coverage tables and their
 * accessors: resume-by-name, rule-set-hash-mismatch-throws, the 4-bin coverage
 * matrix, the nextPendingAuditUnit sweep, idempotent stamping (D4 replay), the
 * D6 verdict fork (bridge-linked vs coverage-only), and per-bin telemetry.
 *
 * No ML required. Uses the shared harness (testDb) + a real bridge_edges row for
 * the edge_id FK case. audit_runs/audit_coverage are self-ensured (not migration
 * tables), so this suite creates them via ensureAuditLedger and cleans them by
 * hand (coverage cascades from audit_runs).
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { testDb, randomUUID } from './setup.js';
import {
  ensureAuditLedger,
  createOrLoadAuditRun,
  seedCoverageUnits,
  nextPendingAuditUnit,
  stampCoverage,
  coverageProgress,
  setAuditRunStatus,
} from '../services/audit-ledger.js';

/**
 * Insert a minimal live bridge edge, returning its id (for edge_id FK cases).
 * Uses the Phase-A-valid endpoint kinds ('code_element'/'rule_element'); the
 * ledger only stores edge_id, so the endpoint kind is irrelevant here. Widening
 * valid_bridge_kinds to include 'entity' for the full-graph substrate is a
 * bridge-tool task (nmemo-uhp.12.2), not the ledger's concern.
 */
async function seedBridgeEdge(relation: 'violates' | 'satisfies'): Promise<string> {
  const aRef = randomUUID();
  const bRef = randomUUID();
  const r = await testDb`
    INSERT INTO public.bridge_edges (a_kind, a_ref, b_kind, b_ref, source_corpus_id, target_corpus_id, relation, reasoning, source_references)
    VALUES ('code_element', ${aRef}::uuid, 'rule_element', ${bRef}::uuid, 'code', 'std', ${relation}, 'seeded for coverage link', ${testDb.json([{ type: 'memory', id: aRef }])}::jsonb)
    RETURNING id::text AS id
  `;
  return (r[0] as { id: string }).id;
}

async function clean(): Promise<void> {
  await testDb`DELETE FROM public.audit_coverage`;
  await testDb`DELETE FROM public.audit_runs`;
  await testDb`DELETE FROM public.bridge_source_refs`;
  await testDb`DELETE FROM public.bridge_edges`;
}

describe('audit ledger (nmemo-uhp.12.1)', () => {
  // Drop + recreate so the schema is current (self-ensured tables aren't recreated
  // by global-setup migrations; a stale definition from an earlier run would persist).
  beforeAll(async () => {
    await testDb`DROP TABLE IF EXISTS public.audit_coverage CASCADE`;
    await testDb`DROP TABLE IF EXISTS public.audit_runs CASCADE`;
    await ensureAuditLedger();
  });
  // Leave the DB clean so other suites (e.g. cross-corpus) can freely DELETE
  // bridge_edges without tripping the audit_coverage FK.
  afterAll(async () => {
    await testDb`DROP TABLE IF EXISTS public.audit_coverage CASCADE`;
    await testDb`DROP TABLE IF EXISTS public.audit_runs CASCADE`;
  });
  beforeEach(clean);

  it('ensureAuditLedger is idempotent (safe to call repeatedly)', async () => {
    await ensureAuditLedger();
    await ensureAuditLedger();
    const t = await testDb`SELECT to_regclass('public.audit_runs') AS a, to_regclass('public.audit_coverage') AS c`;
    expect((t[0] as { a: unknown }).a).not.toBeNull();
    expect((t[0] as { c: unknown }).c).not.toBeNull();
  });

  it('createOrLoadAuditRun: creates, then resumes by name; hash/corpus mismatch throws', async () => {
    const base = {
      name: 'misra-audit-1',
      sourceCorpusId: 'code',
      targetCorpusId: 'std',
      ruleSetHash: 'hash-A',
      modelVersion: 'claude-haiku-4-5',
    };
    const first = await createOrLoadAuditRun(base);
    expect(first.created).toBe(true);

    // Same name + same inputs ⇒ RESUME (same id, created=false).
    const second = await createOrLoadAuditRun(base);
    expect(second.created).toBe(false);
    expect(second.run.id).toBe(first.run.id);

    // Same name, DIFFERENT rule set ⇒ throw (do not mix verdicts across standards).
    await expect(createOrLoadAuditRun({ ...base, ruleSetHash: 'hash-B' })).rejects.toThrow(/rule set|hash mismatch/i);

    // Same name, DIFFERENT corpora ⇒ throw.
    await expect(createOrLoadAuditRun({ ...base, targetCorpusId: 'other' })).rejects.toThrow(/already exists over/i);
  });

  it('seedCoverageUnits + nextPendingAuditUnit: seeds pending cells, re-seed is idempotent, sweep drains', async () => {
    const { run } = await createOrLoadAuditRun({
      name: 'sweep-1', sourceCorpusId: 'code', targetCorpusId: 'std', ruleSetHash: 'h',
    });
    const units = [
      { elementRef: 'e1', ruleId: 'R.1' },
      { elementRef: 'e1', ruleId: 'R.2' },
      { elementRef: 'e2', ruleId: 'R.1' },
    ];
    expect(await seedCoverageUnits(run.id, units)).toBe(3);
    // Re-seeding the same units adds nothing (ON CONFLICT DO NOTHING).
    expect(await seedCoverageUnits(run.id, units)).toBe(0);

    // Sweep returns the lowest (element_ref, rule_id) pending unit.
    const first = await nextPendingAuditUnit(run.id);
    expect(first).toEqual({ elementRef: 'e1', ruleId: 'R.1' });

    // Stamp it ⇒ next sweep skips it and returns the following pending unit.
    await stampCoverage({ runId: run.id, elementRef: 'e1', ruleId: 'R.1', verdict: 'not_applicable' });
    expect(await nextPendingAuditUnit(run.id)).toEqual({ elementRef: 'e1', ruleId: 'R.2' });

    // Drain the rest ⇒ sweep returns null.
    await stampCoverage({ runId: run.id, elementRef: 'e1', ruleId: 'R.2', verdict: 'not_applicable' });
    await stampCoverage({ runId: run.id, elementRef: 'e2', ruleId: 'R.1', verdict: 'not_applicable' });
    expect(await nextPendingAuditUnit(run.id)).toBeNull();
  });

  it('D6 fork: adjudicated verdict links a bridge (edge_id set); coverage-only leaves it NULL', async () => {
    const { run } = await createOrLoadAuditRun({
      name: 'fork-1', sourceCorpusId: 'code', targetCorpusId: 'std', ruleSetHash: 'h',
    });
    await seedCoverageUnits(run.id, [
      { elementRef: 'fn_memcpy', ruleId: 'R.21.18' },
      { elementRef: 'fn_reset', ruleId: 'R.2.1' },
    ]);

    // LLM-reasoned violates ⇒ bridge row exists, coverage cell links it.
    const edgeId = await seedBridgeEdge('violates');
    await stampCoverage({
      runId: run.id, elementRef: 'fn_memcpy', ruleId: 'R.21.18',
      verdict: 'violates', edgeId, invocationId: randomUUID(),
    });

    // Sweep-level "nothing worth keeping" ⇒ coverage-only, NULL edge.
    await stampCoverage({ runId: run.id, elementRef: 'fn_reset', ruleId: 'R.2.1', verdict: 'not_applicable' });

    const cells = await testDb`
      SELECT element_ref, verdict, edge_id::text AS edge_id
      FROM public.audit_coverage WHERE run_id = ${run.id} ORDER BY element_ref
    `;
    const memcpy = cells.find((c) => (c as { element_ref: string }).element_ref === 'fn_memcpy') as { verdict: string; edge_id: string | null };
    const reset = cells.find((c) => (c as { element_ref: string }).element_ref === 'fn_reset') as { verdict: string; edge_id: string | null };
    expect(memcpy.verdict).toBe('violates');
    expect(memcpy.edge_id).toBe(edgeId);
    expect(reset.verdict).toBe('not_applicable');
    expect(reset.edge_id).toBeNull();
  });

  it('D4 replay: re-stamping the same cell settles to one row (idempotent, no drift)', async () => {
    const { run } = await createOrLoadAuditRun({
      name: 'replay-1', sourceCorpusId: 'code', targetCorpusId: 'std', ruleSetHash: 'h',
    });
    await seedCoverageUnits(run.id, [{ elementRef: 'e', ruleId: 'R' }]);
    const edgeId = await seedBridgeEdge('satisfies');
    const inv = randomUUID();

    await stampCoverage({ runId: run.id, elementRef: 'e', ruleId: 'R', verdict: 'satisfies', edgeId, invocationId: inv });
    await stampCoverage({ runId: run.id, elementRef: 'e', ruleId: 'R', verdict: 'satisfies', edgeId, invocationId: inv });

    const rows = await testDb`SELECT count(*)::int AS n FROM public.audit_coverage WHERE run_id = ${run.id} AND element_ref = 'e' AND rule_id = 'R'`;
    expect((rows[0] as { n: number }).n).toBe(1);
  });

  it('coverageProgress reports per-bin counts; setAuditRunStatus updates status', async () => {
    const { run } = await createOrLoadAuditRun({
      name: 'progress-1', sourceCorpusId: 'code', targetCorpusId: 'std', ruleSetHash: 'h',
    });
    await seedCoverageUnits(run.id, [
      { elementRef: 'a', ruleId: 'R1' },
      { elementRef: 'b', ruleId: 'R1' },
      { elementRef: 'c', ruleId: 'R1' },
    ]);
    const vEdge = await seedBridgeEdge('violates');
    const sEdge = await seedBridgeEdge('satisfies');
    await stampCoverage({ runId: run.id, elementRef: 'a', ruleId: 'R1', verdict: 'violates', edgeId: vEdge });
    await stampCoverage({ runId: run.id, elementRef: 'b', ruleId: 'R1', verdict: 'satisfies', edgeId: sEdge });
    // 'c' stays pending.

    const p = await coverageProgress(run.id);
    expect(p).toMatchObject({ pending: 1, violates: 1, satisfies: 1, notApplicable: 0, total: 3 });

    await setAuditRunStatus(run.id, 'completed');
    const s = await testDb`SELECT status FROM public.audit_runs WHERE id = ${run.id}`;
    expect((s[0] as { status: string }).status).toBe('completed');
  });
});
