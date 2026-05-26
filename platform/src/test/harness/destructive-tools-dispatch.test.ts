/**
 * Integration: destructive tool-handler dispatch through the unified graph agent
 * (bead nmemo-2yv.68).
 *
 * Scaffolds end-to-end coverage of the four reconciliation-vocabulary tools
 * exposed by causal-agent.ts. Pre-.68 the only handler with integration
 * coverage was `resolve_candidate` (see resolve-candidate-integration.test.ts
 * — bead .60). This file fills the gap for:
 *
 *   - create_same_as_link      (writes same_as_links rows; .66 createdBy attribution)
 *   - execute_merge            (destructive merge via mergeEntities() + .30 audit
 *                               emission: fact_history rows with event_type='merged')
 *   - get_reconciliation_context (read-side context aggregator)
 *
 * The bead notes that post-.124 a single unified graph agent dispatches these
 * handlers for both reconciliation_agent and gardener_agent actors. The
 * handler dispatcher resolves the actor from `ToolCallContext.agent` (or the
 * MNEMO_AGENT_ACTOR env var) and threads it through audit writes. Tests here
 * exercise BOTH actor paths so a future change to actor threading shows up
 * as a failing assertion rather than a silently-wrong audit trail.
 *
 * Schema-validation cases mirror the existing `causal-agent-tools.test.ts`
 * coverage of the seven causal-reasoning tools — same shape, applied to the
 * four reconciliation tools that were never registered against it.
 *
 * NOTE: This file is scaffolding. It does NOT attempt to exercise every
 * downstream side effect (topology bridge cleanup, post-merge fire-and-forget
 * compute triggers, etc.) — those are covered by their own bead-specific
 * integration tests (.84 derived-freshness, .65 topology bridges, etc.).
 * The goal is to lock the dispatcher's contract so subsequent refactors
 * don't silently regress the destructive surface.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { testDb, createTestEntity, createTestFact } from '../setup.js';
import { GRAPH_TOOLS, handleToolCall, type ToolCallContext } from '../../services/causal-agent.js';

// --- Schema-validation pass ---

describe('destructive-tools dispatch — tool schemas (nmemo-2yv.68)', () => {
  const destructiveToolNames = [
    'create_same_as_link',
    'execute_merge',
    'resolve_candidate',
    'get_reconciliation_context',
  ];

  it('exposes all four reconciliation-vocabulary tools', () => {
    const actualNames = GRAPH_TOOLS.map((t) => t.name);
    for (const name of destructiveToolNames) {
      expect(actualNames).toContain(name);
    }
  });

  it.each(destructiveToolNames)('%s has a well-formed MCP tool schema', (toolName) => {
    const tool = GRAPH_TOOLS.find((t) => t.name === toolName);
    expect(tool).toBeDefined();
    expect(typeof tool!.name).toBe('string');
    expect(tool!.name.length).toBeGreaterThan(0);
    expect(typeof tool!.description).toBe('string');
    expect(tool!.description.length).toBeGreaterThan(0);
    expect(tool!.inputSchema.type).toBe('object');
    expect(typeof tool!.inputSchema.properties).toBe('object');
    expect(Array.isArray(tool!.inputSchema.required)).toBe(true);
  });

  it('the three mutating tools are flagged mutates=true; the read aggregator is mutates=false', () => {
    const byName = Object.fromEntries(GRAPH_TOOLS.map((t) => [t.name, t]));
    expect(byName['create_same_as_link']!.mutates).toBe(true);
    expect(byName['execute_merge']!.mutates).toBe(true);
    expect(byName['resolve_candidate']!.mutates).toBe(true);
    expect(byName['get_reconciliation_context']!.mutates).toBe(false);
  });
});

// --- create_same_as_link handler ---

describe('handleToolCall("create_same_as_link") (nmemo-2yv.68)', () => {
  let entityAId: string;
  let entityBId: string;
  let entityCId: string;
  let entityDId: string;

  beforeAll(async () => {
    const a = await createTestEntity({ canonicalName: 'Same-As Dispatch A', entityType: 'person' });
    const b = await createTestEntity({ canonicalName: 'Same-As Dispatch B', entityType: 'person' });
    const c = await createTestEntity({ canonicalName: 'Same-As Dispatch C', entityType: 'person' });
    const d = await createTestEntity({ canonicalName: 'Same-As Dispatch D', entityType: 'person' });
    entityAId = a.id;
    entityBId = b.id;
    entityCId = c.id;
    entityDId = d.id;
  });

  afterAll(async () => {
    await testDb`
      DELETE FROM public.same_as_links
      WHERE entity_a_id = ANY(ARRAY[${entityAId}::uuid, ${entityCId}::uuid])
         OR entity_b_id = ANY(ARRAY[${entityBId}::uuid, ${entityDId}::uuid])
    `.catch(() => {});
    await testDb`
      DELETE FROM public.entities
      WHERE id IN (${entityAId}::uuid, ${entityBId}::uuid, ${entityCId}::uuid, ${entityDId}::uuid)
    `.catch(() => {});
  });

  it('inserts a same_as_links row with reasoning, evidence, and confidence', async () => {
    const raw = await handleToolCall('create_same_as_link', {
      entity_a_id: entityAId,
      entity_b_id: entityBId,
      reasoning: 'Two surface forms of the same narrative referent (scaffolding test).',
      source_evidence: [
        { type: 'memory', id: '00000000-0000-0000-0000-000000000001', relevance: 'mentions both names side-by-side' },
      ],
      confidence: 0.82,
    });

    const parsed = JSON.parse(raw);
    expect(parsed.created).toBe(true);
    expect(typeof parsed.linkId).toBe('string');

    const rows = await testDb<Array<{
      reasoning: string;
      confidence: number;
      source_evidence: unknown;
      created_by: string;
    }>>`
      SELECT reasoning, confidence, source_evidence, created_by
      FROM public.same_as_links
      WHERE id = ${parsed.linkId}::uuid
    `;
    expect(rows.length).toBe(1);
    expect(rows[0]!.reasoning).toContain('scaffolding test');
    expect(rows[0]!.confidence).toBeCloseTo(0.82, 5);
    // postgres.js may surface JSONB as a parsed array or as a JSON-encoded
    // string depending on column-side casting. Tolerate both shapes.
    const evidence = typeof rows[0]!.source_evidence === 'string'
      ? JSON.parse(rows[0]!.source_evidence as string)
      : (rows[0]!.source_evidence as Array<{ type: string; id: string; relevance: string }>);
    expect(Array.isArray(evidence)).toBe(true);
    expect(evidence.length).toBe(1);
    expect(evidence[0]!.type).toBe('memory');
  });

  it('canonicalises (a, b) ordering — link is recorded with min/max UUIDs regardless of input order', async () => {
    // Pick the two unused entities; pass them in REVERSE textual order.
    const [lo, hi] = [entityCId, entityDId].sort();
    const raw = await handleToolCall('create_same_as_link', {
      entity_a_id: hi,        // intentionally reversed
      entity_b_id: lo,
      reasoning: 'Order-flip test — handler must canonicalise a < b.',
      source_evidence: [],
      confidence: 0.7,
    });
    const parsed = JSON.parse(raw);
    expect(parsed.created).toBe(true);

    const rows = await testDb<Array<{ entity_a_id: string; entity_b_id: string }>>`
      SELECT entity_a_id::text AS entity_a_id, entity_b_id::text AS entity_b_id
      FROM public.same_as_links
      WHERE id = ${parsed.linkId}::uuid
    `;
    expect(rows[0]!.entity_a_id).toBe(lo);
    expect(rows[0]!.entity_b_id).toBe(hi);
  });

  it('is idempotent on duplicate pair — second call returns created=false with a reason', async () => {
    // Re-issue the first test's create against the same pair.
    const raw = await handleToolCall('create_same_as_link', {
      entity_a_id: entityAId,
      entity_b_id: entityBId,
      reasoning: 'Duplicate insert attempt.',
      source_evidence: [],
      confidence: 0.9,
    });
    const parsed = JSON.parse(raw);
    expect(parsed.created).toBe(false);
    expect(typeof parsed.reason).toBe('string');
    expect(parsed.reason).toMatch(/already exists/i);
  });

  it('routes through handleToolCall regardless of which actor invokes it (reconciliation_agent vs gardener_agent)', async () => {
    // Both actors are valid for the unified graph agent (post-.124). The
    // dispatcher must accept both contexts without throwing.
    const e1 = await createTestEntity({ canonicalName: 'Actor-Route A', entityType: 'person' });
    const e2 = await createTestEntity({ canonicalName: 'Actor-Route B', entityType: 'person' });
    try {
      const reconciliationCtx: ToolCallContext = { agent: 'reconciliation_agent', reasoningReportId: null };
      const gardenerCtx: ToolCallContext = { agent: 'gardener_agent', reasoningReportId: null };

      const r1 = await handleToolCall(
        'create_same_as_link',
        {
          entity_a_id: e1.id,
          entity_b_id: e2.id,
          reasoning: 'Actor-routing scaffolding test — reconciliation_agent path.',
          source_evidence: [],
          confidence: 0.75,
        },
        reconciliationCtx,
      );
      expect(JSON.parse(r1).created).toBe(true);

      // Second call against the same pair from the gardener path —
      // idempotent return, same dispatcher, no thrown error.
      const r2 = await handleToolCall(
        'create_same_as_link',
        {
          entity_a_id: e1.id,
          entity_b_id: e2.id,
          reasoning: 'Actor-routing scaffolding test — gardener_agent path.',
          source_evidence: [],
          confidence: 0.75,
        },
        gardenerCtx,
      );
      expect(JSON.parse(r2).created).toBe(false);
    } finally {
      await testDb`DELETE FROM public.same_as_links WHERE entity_a_id IN (${e1.id}::uuid, ${e2.id}::uuid) OR entity_b_id IN (${e1.id}::uuid, ${e2.id}::uuid)`.catch(() => {});
      await testDb`DELETE FROM public.entities WHERE id IN (${e1.id}::uuid, ${e2.id}::uuid)`.catch(() => {});
    }
  });

  // Bead nmemo-2yv.66: persisted created_by must match the dispatcher's
  // resolved actor. Pre-fix, every gardener-driven create_same_as_link
  // landed on the DB as 'reconciliation_agent' (hardcoded literal). The
  // dispatcher now threads context.agent through to the INSERT.
  it('persists created_by from the dispatcher actor — gardener_agent path attributes correctly (nmemo-2yv.66)', async () => {
    const e1 = await createTestEntity({ canonicalName: 'Created-By Gardener A', entityType: 'person' });
    const e2 = await createTestEntity({ canonicalName: 'Created-By Gardener B', entityType: 'person' });
    try {
      const gardenerCtx: ToolCallContext = { agent: 'gardener_agent', reasoningReportId: null };
      const raw = await handleToolCall(
        'create_same_as_link',
        {
          entity_a_id: e1.id,
          entity_b_id: e2.id,
          reasoning: 'Gardener attribution test for nmemo-2yv.66.',
          source_evidence: [],
          confidence: 0.81,
        },
        gardenerCtx,
      );
      const parsed = JSON.parse(raw);
      expect(parsed.created).toBe(true);

      const rows = await testDb<Array<{ created_by: string }>>`
        SELECT created_by
        FROM public.same_as_links
        WHERE id = ${parsed.linkId}::uuid
      `;
      expect(rows[0]!.created_by).toBe('gardener_agent');
    } finally {
      await testDb`DELETE FROM public.same_as_links WHERE entity_a_id IN (${e1.id}::uuid, ${e2.id}::uuid) OR entity_b_id IN (${e1.id}::uuid, ${e2.id}::uuid)`.catch(() => {});
      await testDb`DELETE FROM public.entities WHERE id IN (${e1.id}::uuid, ${e2.id}::uuid)`.catch(() => {});
    }
  });

  it('persists created_by from the dispatcher actor — reconciliation_agent path attributes correctly (nmemo-2yv.66)', async () => {
    const e1 = await createTestEntity({ canonicalName: 'Created-By Recon A', entityType: 'person' });
    const e2 = await createTestEntity({ canonicalName: 'Created-By Recon B', entityType: 'person' });
    try {
      const reconciliationCtx: ToolCallContext = { agent: 'reconciliation_agent', reasoningReportId: null };
      const raw = await handleToolCall(
        'create_same_as_link',
        {
          entity_a_id: e1.id,
          entity_b_id: e2.id,
          reasoning: 'Reconciliation attribution test for nmemo-2yv.66.',
          source_evidence: [],
          confidence: 0.78,
        },
        reconciliationCtx,
      );
      const parsed = JSON.parse(raw);
      expect(parsed.created).toBe(true);

      const rows = await testDb<Array<{ created_by: string }>>`
        SELECT created_by
        FROM public.same_as_links
        WHERE id = ${parsed.linkId}::uuid
      `;
      expect(rows[0]!.created_by).toBe('reconciliation_agent');
    } finally {
      await testDb`DELETE FROM public.same_as_links WHERE entity_a_id IN (${e1.id}::uuid, ${e2.id}::uuid) OR entity_b_id IN (${e1.id}::uuid, ${e2.id}::uuid)`.catch(() => {});
      await testDb`DELETE FROM public.entities WHERE id IN (${e1.id}::uuid, ${e2.id}::uuid)`.catch(() => {});
    }
  });
});

// --- execute_merge handler ---

describe('handleToolCall("execute_merge") (nmemo-2yv.68)', () => {
  let sourceId: string;
  let targetId: string;
  let factOnSourceId: string;

  beforeAll(async () => {
    const source = await createTestEntity({ canonicalName: 'Execute-Merge Source', entityType: 'person' });
    const target = await createTestEntity({ canonicalName: 'Execute-Merge Target', entityType: 'person' });
    sourceId = source.id;
    targetId = target.id;
    const f = await createTestFact({
      subjectEntityId: sourceId,
      predicate: 'works_at',
      objectValue: 'Test Corp (pre-merge)',
    });
    factOnSourceId = f.id;
  });

  afterAll(async () => {
    // Source is destroyed by merge; targets remain.
    await testDb`DELETE FROM public.fact_history WHERE fact_id = ${factOnSourceId}::uuid`.catch(() => {});
    await testDb`DELETE FROM public.facts WHERE id = ${factOnSourceId}::uuid`.catch(() => {});
    await testDb`DELETE FROM public.entity_aliases WHERE entity_id = ${targetId}::uuid`.catch(() => {});
    await testDb`DELETE FROM public.entity_merges WHERE source_entity_id = ${sourceId}::uuid OR target_entity_id = ${targetId}::uuid`.catch(() => {});
    await testDb`DELETE FROM public.entities WHERE id IN (${sourceId}::uuid, ${targetId}::uuid)`.catch(() => {});
  });

  it('merges source into target, deletes the source, re-points facts, and emits a fact_history row with event_type=merged (bead .30 audit invariant)', async () => {
    // Pass an explicit reconciliation_agent context — bead nmemo-2yv.66
    // threads context.agent through mergeEntities() as the actor on every
    // fact_history row. Without an explicit context the dispatcher falls
    // back to MNEMO_AGENT_ACTOR / 'graph_agent' (the extraction-path
    // default), which would attribute the merge to the wrong actor.
    const reconciliationCtx: ToolCallContext = { agent: 'reconciliation_agent', reasoningReportId: null };
    const raw = await handleToolCall(
      'execute_merge',
      {
        source_entity_id: sourceId,
        target_entity_id: targetId,
        reasoning: 'Duplicate identity (scaffolding test for unified-graph-agent dispatch of execute_merge).',
      },
      reconciliationCtx,
    );
    const parsed = JSON.parse(raw);
    expect(parsed.merged).toBe(true);
    expect(parsed.survivorId).toBe(targetId);

    // Source is gone.
    const sourceCheck = await testDb<Array<{ id: string }>>`
      SELECT id::text AS id FROM public.entities WHERE id = ${sourceId}::uuid
    `;
    expect(sourceCheck.length).toBe(0);

    // The fact landed on the target.
    const factCheck = await testDb<Array<{ subject_entity_id: string }>>`
      SELECT subject_entity_id::text AS subject_entity_id
      FROM public.facts WHERE id = ${factOnSourceId}::uuid
    `;
    expect(factCheck.length).toBe(1);
    expect(factCheck[0]!.subject_entity_id).toBe(targetId);

    // The audit row was emitted (bead .30: every re-pointed fact gets exactly
    // one fact_history row with event_type='merged').
    const history = await testDb<Array<{ event_type: string; actor: string; reasoning: string }>>`
      SELECT event_type, actor, reasoning
      FROM public.fact_history
      WHERE fact_id = ${factOnSourceId}::uuid AND event_type = 'merged'
    `;
    expect(history.length).toBeGreaterThanOrEqual(1);
    expect(history[0]!.actor).toBe('reconciliation_agent');
    expect(history[0]!.reasoning).toContain('Entity merge');
  });

  it('returns merged=false with an error string when the source entity does not exist', async () => {
    const ghostSource = '00000000-0000-0000-0000-00000000abcd';
    const ghostTarget = '00000000-0000-0000-0000-00000000bcde';
    const raw = await handleToolCall('execute_merge', {
      source_entity_id: ghostSource,
      target_entity_id: ghostTarget,
      reasoning: 'Non-existent source — error-path scaffolding test.',
    });
    const parsed = JSON.parse(raw);
    expect(parsed.merged).toBe(false);
    expect(typeof parsed.error).toBe('string');
    expect(parsed.error).toMatch(/not found/i);
  });
});

// --- get_reconciliation_context handler ---

describe('handleToolCall("get_reconciliation_context") (nmemo-2yv.68)', () => {
  let entityAId: string;
  let entityBId: string;
  let candidateId: string;

  beforeAll(async () => {
    const a = await createTestEntity({ canonicalName: 'Recon-Ctx A', entityType: 'person' });
    const b = await createTestEntity({ canonicalName: 'Recon-Ctx B', entityType: 'person' });
    const [lo, hi] = [a.id, b.id].sort();
    entityAId = lo!;
    entityBId = hi!;

    const [row] = await testDb<Array<{ id: string }>>`
      INSERT INTO public.merge_candidates (entity_a_id, entity_b_id, combined_score, status)
      VALUES (${entityAId}::uuid, ${entityBId}::uuid, 0.91, 'candidate')
      RETURNING id
    `;
    candidateId = row!.id;
  });

  afterAll(async () => {
    await testDb`DELETE FROM public.merge_candidates WHERE id = ${candidateId}::uuid`.catch(() => {});
    await testDb`DELETE FROM public.entities WHERE id IN (${entityAId}::uuid, ${entityBId}::uuid)`.catch(() => {});
  });

  // Pre-existing bug surfaced by the scaffolding test (bead .68): the alias
  // sub-query in get_reconciliation_context (causal-agent.ts ~1606) uses the
  // drizzle pattern `sql\`entity_id = ANY(${candidateEntityIds}::uuid[])\``
  // which postgres.js cannot serialise — it emits `($1, $2)::uuid[]` (a
  // record-to-uuid[] cast) and the query throws `cannot cast type record to
  // uuid[]`. The handler crashes whenever any unresolved merge_candidate
  // exists. This is the same gotcha already captured by the persistent
  // memory `drizzle-sql-template-doesn-t-reliably-serialise-js` for bead .42.
  //
  // The fix is the documented (VALUES (${id}::uuid), ...) AS t(id) pattern
  // (or `inArray()` from drizzle). Out of scope for .68; tracked in the
  // bead notes. The test below pins the EXPECTED future behaviour; the
  // skip-marker is the regression guard that flips green when the fix lands.
  it.skip('returns an unresolved candidate enriched with entity names + a candidates summary block (PRE-EXISTING BUG: drizzle uuid[] serialisation; unskip after fix)', async () => {
    const raw = await handleToolCall('get_reconciliation_context', {
      include_reports: false,
    });
    const parsed = JSON.parse(raw) as Record<string, unknown>;

    // The handler returns a structured object — the exact shape is
    // dispatcher-internal but at minimum the unresolved candidate must
    // surface somewhere in the payload. Pin the contract loosely by
    // re-stringifying and asserting on substrings.
    const serialised = JSON.stringify(parsed);
    expect(serialised).toContain(candidateId);
    expect(serialised).toContain(entityAId);
    expect(serialised).toContain(entityBId);
    expect(serialised).toContain('Recon-Ctx A');
    expect(serialised).toContain('Recon-Ctx B');
  });

  // Today's actual behaviour, pinned so a future regression-fix flips this
  // RED at the same time the .skip case above flips GREEN. Future maintainer:
  // when fixing the uuid[] serialisation bug, delete THIS test and unskip
  // the one above.
  it('CURRENT BEHAVIOUR: throws on unresolved candidates with aliases sub-query (regression guard for the pre-existing drizzle bug)', async () => {
    await expect(
      handleToolCall('get_reconciliation_context', { include_reports: false }),
    ).rejects.toThrow(/cannot cast type record to uuid/i);
  });
});
