/**
 * Cross-corpus audit pass spine (bead nmemo-uhp.12.3, Phase B).
 *
 * Exercises the whole linker spine end-to-end WITHOUT an LLM, via the injectable
 * invoker seam (mirrors causal-pass's fake-invoker DB tests):
 *   - recallCrossCorpusCandidates: deterministic cross-corpus recall over aligned
 *     entity embeddings (the .14 lever, measured by the .12.4 gate) finds the true
 *     pairs and ignores dissimilar ones.
 *   - runAuditPass: seed (recall → pending cells) → sweep (drain) → applyBridgePromotion
 *     → stampCoverage, with the D6 fork (a staged 'violates' bridge → verdict+edge_id;
 *     a swept-nothing cell → not_applicable, NULL edge).
 *   - resume-by-name: a re-run neither re-seeds nor re-sweeps drained cells.
 *
 * Embeddings are crafted one-hot vectors so recall is exact and ML-free. Uses private
 * corpus ids ('audit_code_test'/'audit_std_test') to stay isolated from the
 * cross-corpus and audit-mcp suites. audit_runs/audit_coverage are self-ensured, so
 * this suite drops+recreates them (beforeAll) and drops them (afterAll), same as
 * audit-ledger.test.ts, so other suites can freely DELETE bridge_edges.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { testDb, normalizeVector, TEST_EMBED_DIMENSIONS } from './setup.js';
import { runAuditPass, recallCrossCorpusCandidates, type AuditCellScope } from '../services/audit-pass.js';
import { handleToolCall } from '../services/causal-agent.js';
import { ensureAuditLedger } from '../services/audit-ledger.js';

const SRC = 'audit_code_test';
const TGT = 'audit_std_test';

/** A normalized one-hot vector — cosine 1.0 with itself, 0.0 with a different axis. */
function unit(dim: number): number[] {
  const v = new Array(TEST_EMBED_DIMENSIONS).fill(0);
  v[dim] = 1;
  return normalizeVector(v);
}

async function seedEntity(
  name: string,
  corpusId: string,
  embedding: number[],
  description?: string,
): Promise<string> {
  const embStr = `[${embedding.join(',')}]`;
  const r = await testDb`
    INSERT INTO public.entities (canonical_name, entity_type, corpus_id, description, embedding)
    VALUES (${name}, 'concept', ${corpusId}, ${description ?? null}, ${embStr}::vector)
    RETURNING id::text AS id
  `;
  return (r[0] as { id: string }).id;
}

async function cleanCorpora(): Promise<void> {
  await testDb`DELETE FROM public.audit_coverage`;
  await testDb`DELETE FROM public.audit_runs`;
  await testDb`DELETE FROM public.bridge_source_refs`;
  await testDb`DELETE FROM public.bridge_edges`;
  await testDb`DELETE FROM public.staging_bridge_edges`;
  await testDb`DELETE FROM public.entities WHERE corpus_id IN (${SRC}, ${TGT})`;
}

describe('cross-corpus audit pass spine (nmemo-uhp.12.3)', () => {
  beforeAll(async () => {
    await testDb`DROP TABLE IF EXISTS public.audit_coverage CASCADE`;
    await testDb`DROP TABLE IF EXISTS public.audit_runs CASCADE`;
    await ensureAuditLedger();
  });
  afterAll(async () => {
    await cleanCorpora();
    await testDb`DROP TABLE IF EXISTS public.audit_coverage CASCADE`;
    await testDb`DROP TABLE IF EXISTS public.audit_runs CASCADE`;
  });
  beforeEach(cleanCorpora);

  it('recallCrossCorpusCandidates finds aligned cross-corpus pairs, ignores dissimilar', async () => {
    const s1 = await seedEntity('memcpy', SRC, unit(0), 'unbounded copy');
    const s2 = await seedEntity('strncpy', SRC, unit(1), 'bounded copy');
    const r1 = await seedEntity('Rule 21.18', TGT, unit(0), 'no unbounded copy');
    const r2 = await seedEntity('Rule 21.17', TGT, unit(1), 'bounded string ops');
    await seedEntity('Rule 8.1', TGT, unit(5), 'types explicit'); // matches neither source

    const pairs = await recallCrossCorpusCandidates(SRC, TGT, { k: 8, threshold: 0.9 });
    const keys = new Set(pairs.map((p) => `${p.elementRef}|${p.ruleId}`));
    expect(keys).toEqual(new Set([`${s1}|${r1}`, `${s2}|${r2}`]));
    for (const p of pairs) expect(p.similarity).toBeGreaterThan(0.9);
  });

  it('runAuditPass: seed → sweep → promote → stamp, with the D6 fork', async () => {
    const s1 = await seedEntity('memcpy', SRC, unit(0), 'unbounded copy');
    const s2 = await seedEntity('strncpy', SRC, unit(1), 'bounded copy');
    const r1 = await seedEntity('Rule 21.18', TGT, unit(0), 'no unbounded copy');
    const r2 = await seedEntity('Rule 21.17', TGT, unit(1), 'bounded string ops');

    // Fake invoker: assert a real 'violates' bridge for memcpy/21.18; stage nothing
    // for strncpy/21.17 (→ not_applicable, coverage-only). Exercises the real
    // staging → promotion path with no LLM.
    const seen: string[] = [];
    const fake = async (scope: AuditCellScope): Promise<void> => {
      seen.push(`${scope.element.ref}|${scope.rule.ref}`);
      if (scope.element.ref === s1 && scope.rule.ref === r1) {
        await handleToolCall(
          'propose_bridge_edge',
          {
            aKind: 'entity',
            aRef: s1,
            bKind: 'entity',
            bRef: r1,
            sourceCorpusId: SRC,
            targetCorpusId: TGT,
            relation: 'violates',
            reasoning: 'memcpy copies without a bound check; Rule 21.18 forbids unbounded copies',
            sourceReferences: [{ type: 'entity', id: s1, relevance: 'the offending element' }],
          },
          { agent: 'audit_agent', invocationId: scope.invocationId },
        );
      }
    };

    const res = await runAuditPass(
      { name: 'audit-spine-1', sourceCorpusId: SRC, targetCorpusId: TGT, ruleSetHash: 'h', recall: { k: 8, threshold: 0.9 } },
      { invokeAuditAgent: fake },
    );

    expect(res.seeded).toBe(2);
    expect(res.swept).toBe(2);
    expect(res.progress).toMatchObject({ violates: 1, satisfies: 0, notApplicable: 1, pending: 0, total: 2 });
    expect(new Set(seen)).toEqual(new Set([`${s1}|${r1}`, `${s2}|${r2}`]));

    const edges = await testDb`
      SELECT id::text AS id, a_ref::text AS a_ref, b_ref::text AS b_ref, relation
      FROM public.bridge_edges WHERE expired_at IS NULL
    `;
    expect(edges.length).toBe(1);
    const edge = edges[0] as { id: string; a_ref: string; b_ref: string; relation: string };
    expect(edge.relation).toBe('violates');
    expect(edge.a_ref).toBe(s1);
    expect(edge.b_ref).toBe(r1);

    const cells = (await testDb`
      SELECT element_ref, rule_id, verdict, edge_id::text AS edge_id FROM public.audit_coverage
    `) as Array<{ element_ref: string; rule_id: string; verdict: string; edge_id: string | null }>;
    const c1 = cells.find((c) => c.element_ref === s1 && c.rule_id === r1)!;
    const c2 = cells.find((c) => c.element_ref === s2 && c.rule_id === r2)!;
    expect(c1.verdict).toBe('violates');
    expect(c1.edge_id).toBe(edge.id);
    expect(c2.verdict).toBe('not_applicable');
    expect(c2.edge_id).toBeNull();
  });

  it('resume-by-name: a re-run neither re-seeds nor re-sweeps drained cells', async () => {
    await seedEntity('memcpy', SRC, unit(0), 'unbounded copy');
    await seedEntity('Rule 21.18', TGT, unit(0), 'no unbounded copy');

    let calls = 0;
    const fake = async (_scope: AuditCellScope): Promise<void> => {
      calls += 1; // adjudicate as not_applicable (propose nothing)
    };
    const params = {
      name: 'resume-1',
      sourceCorpusId: SRC,
      targetCorpusId: TGT,
      ruleSetHash: 'h',
      recall: { k: 8, threshold: 0.9 },
    };

    const first = await runAuditPass(params, { invokeAuditAgent: fake });
    expect(first.created).toBe(true);
    expect(first.seeded).toBe(1);
    expect(first.swept).toBe(1);
    expect(calls).toBe(1);

    const second = await runAuditPass(params, { invokeAuditAgent: fake });
    expect(second.created).toBe(false);
    expect(second.seeded).toBe(0); // cell already exists (ON CONFLICT DO NOTHING)
    expect(second.swept).toBe(0); // already adjudicated, nothing pending
    expect(calls).toBe(1); // invoker not called again
  });
});
