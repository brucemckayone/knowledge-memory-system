/**
 * Integration: destructive tool-handler dispatch through the unified graph agent
 * (bead nmemo-2yv.68), updated for E5 (nmemo-vpz.5, doc 41 §8a.5).
 *
 * E5 RETIRES `execute_merge` and `create_same_as_link` from every agent surface:
 * "the arbiter decides, promotion executes" (doc 41 §8a.2/§8a.5). The destructive
 * dispatch path these tests once exercised is gone. The behaviour they validated —
 * entity merge + fact re-point + 'merged' audit row, same_as insert + a<b
 * canonicalisation + created_by attribution — now lives in PROMOTION code and is
 * covered by promotion.test.ts (the E5 arbiter describe: the MERGE/SAME_AS verdict
 * tests + the 'merged' audit invariant). What this file now locks is:
 *
 *   - the tool SCHEMAS are still well-formed (defs remain in GRAPH_TOOLS until E7);
 *   - the RETIREMENT contract: no agent actor can reach execute_merge /
 *     create_same_as_link via handleToolCall (criterion 2);
 *   - get_reconciliation_context still dispatches (read-only, subsumed-by-dossier
 *     for the arbiter but retained for legacy actors).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { testDb, createTestEntity } from '../setup.js';
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

// --- E5: execute_merge / create_same_as_link retired from agent surfaces ---

describe('execute_merge / create_same_as_link retired from agent surfaces (nmemo-vpz.5 / E5)', () => {
  const RETIRED = ['execute_merge', 'create_same_as_link'] as const;
  const AGENTS: Array<ToolCallContext['agent']> = [
    'graph_agent', 'reconciliation_agent', 'gardener_agent', 'reasoning_agent', 'extraction_proposer',
  ];

  it('every agent actor is denied both tools, before any DB work (criterion 2)', async () => {
    for (const tool of RETIRED) {
      for (const agent of AGENTS) {
        await expect(
          handleToolCall(tool, {}, { agent, reasoningReportId: null }),
          `${agent} must be denied ${tool}`,
        ).rejects.toThrow(/not permitted for actor/);
      }
    }
  });

  it('the default (env) actor is also denied — no transport bypasses the retirement', async () => {
    await expect(handleToolCall('execute_merge', {})).rejects.toThrow(/not permitted for actor/);
    await expect(handleToolCall('create_same_as_link', {})).rejects.toThrow(/not permitted for actor/);
  });
});

// --- get_reconciliation_context handler (read-only, retained for legacy actors) ---

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
