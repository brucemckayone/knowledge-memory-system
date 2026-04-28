/**
 * Phase 4 — Blast Radius Analysis (doc 15, nmemo-437)
 *
 * Verifies the impact-tree contract:
 *   - direct dependents per node type (fact / entity / causal_event)
 *   - transitive walks through causal_edges (forward, backward, both, with cycle protection)
 *   - citation dependents discovered via Phase 3 source-ref index
 *   - pattern impact via causal_edges.pattern_id (empty until Phase 6 lands)
 *   - severity scoring per the 9-rule table
 *   - hypothetical mode: re-scores severity, makes zero DB writes
 *   - MCP tool + HTTP endpoint round-trips
 *   - performance + adversarial cases (fan-out, deep cycle)
 *
 * Test shape (per plan dialogue): inline Vitest expects on the returned
 * BlastRadiusReport for tree-shape assertions; assertion-runner is reused
 * only for the hypothetical-mode "no DB mutations" side_effect_assertions.
 *
 * Group C1 ships: foundation + direct dependents.
 * Later groups extend: transitive (C2), citation (C2), severity + hypothetical
 * (C3), MCP/HTTP (C4), viz + adversarial + benchmark (C5).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  testDb,
  deleteFromTables,
  createTestEntity,
  createTestFact,
  randomUUID,
} from '../setup.js';
import { analyzeImpact } from '../../services/impact.js';

// ============================================
// Per-test cleanup
// ============================================

async function cleanSlate(): Promise<void> {
  await deleteFromTables({
    tables: [
      'edge_source_refs',
      'causal_edge_history',
      'fact_history',
      'causal_edges',
      'causal_events',
      'contradictions',
      'memory_entities',
      'entity_aliases',
      'facts',
      'entity_merges',
      'entities',
    ],
    acknowledgeGlobal: true,
  });
}

// ============================================
// Local helpers — direct SQL inserts for causal_events / causal_edges
// (mirrors the pattern in causal-agent-tools.test.ts; these tests don't
// need the full createCausalEvent/createCausalEdge API surface)
// ============================================

async function insertCausalEvent(params: {
  factId?: string | null;
  transitionType?: string;
  subjectEntityId?: string | null;
  predicate?: string | null;
  occurredAt?: Date;
}): Promise<string> {
  const result = await testDb`
    INSERT INTO causal_events (fact_id, transition_type, subject_entity_id, predicate, occurred_at, source_text)
    VALUES (
      ${params.factId ?? null}::uuid,
      ${params.transitionType ?? 'created'},
      ${params.subjectEntityId ?? null}::uuid,
      ${params.predicate ?? null},
      ${params.occurredAt ?? new Date()},
      ${'test event'}
    )
    RETURNING id
  `;
  return (result[0] as { id: string }).id;
}

async function insertCausalEdge(params: {
  causeEventId: string;
  effectEventId: string;
  strength?: number;
  reasoning?: string;
  corroborationCount?: number;
  expiredAt?: Date | null;
}): Promise<string> {
  const result = await testDb`
    INSERT INTO causal_edges (
      cause_event_id, effect_event_id, strength, reasoning, source_references,
      extraction_method, corroboration_count, initial_strength, expired_at
    )
    VALUES (
      ${params.causeEventId}::uuid,
      ${params.effectEventId}::uuid,
      ${params.strength ?? 0.7},
      ${params.reasoning ?? 'test edge'},
      ${'[]'}::jsonb,
      ${'manual'},
      ${params.corroborationCount ?? 1},
      ${params.strength ?? 0.7},
      ${params.expiredAt ?? null}
    )
    RETURNING id
  `;
  return (result[0] as { id: string }).id;
}

// ============================================
// C1 — Foundation (nmemo-437.1)
// ============================================

describe('Phase 4 — Foundation (nmemo-437.1)', () => {
  beforeEach(async () => {
    await cleanSlate();
  });

  it('analyzeImpact returns BlastRadiusReport shape for an isolated entity', async () => {
    const entity = await createTestEntity({
      canonicalName: 'IsolatedNode',
      entityType: 'concept',
    });

    const report = await analyzeImpact({ nodeType: 'entity', nodeId: entity.id });

    expect(report.root.nodeType).toBe('entity');
    expect(report.root.nodeId).toBe(entity.id);
    expect(report.root.summary).toContain('IsolatedNode');
    expect(report.directDependents).toEqual([]);
    expect(report.transitiveChains).toEqual([]);
    expect(report.citationDependents).toEqual([]);
    expect(report.patternImpact).toEqual([]);
    expect(report.severitySummary).toEqual({ critical: 0, high: 0, medium: 0, low: 0 });
    expect(report.totalAffected).toBe(0);
    expect(report.generatedAt).toBeInstanceOf(Date);
    expect(report.hypothetical).toBeUndefined();
  });

  it('throws when the root node does not exist', async () => {
    const fakeId = randomUUID();
    await expect(
      analyzeImpact({ nodeType: 'fact', nodeId: fakeId }),
    ).rejects.toThrow(/not found/);
  });

  it('passes through hypothetical flag onto the report', async () => {
    const entity = await createTestEntity({
      canonicalName: 'HypoNode',
      entityType: 'concept',
    });
    const report = await analyzeImpact({
      nodeType: 'entity',
      nodeId: entity.id,
      hypothetical: 'expire',
    });
    expect(report.hypothetical).toBe('expire');
  });
});

// ============================================
// C1 — Direct dependents per node type
// ============================================

describe('Phase 4 — Direct dependents (nmemo-437.1)', () => {
  beforeEach(async () => {
    await cleanSlate();
  });

  describe('entity root', () => {
    it('returns active facts where entity is subject', async () => {
      const alice = await createTestEntity({ canonicalName: 'Alice', entityType: 'person' });
      const bob = await createTestEntity({ canonicalName: 'Bob', entityType: 'person' });
      const fact1 = await createTestFact({
        subjectEntityId: alice.id,
        predicate: 'knows',
        objectEntityId: bob.id,
      });
      const fact2 = await createTestFact({
        subjectEntityId: alice.id,
        predicate: 'works_at',
        objectValue: 'Acme Corp',
      });

      const report = await analyzeImpact({ nodeType: 'entity', nodeId: alice.id });

      const ids = report.directDependents.map((d) => d.nodeId).sort();
      expect(ids).toEqual([fact1.id, fact2.id].sort());
      expect(report.directDependents.every((d) => d.relationship === 'direct')).toBe(true);
      expect(report.directDependents.every((d) => d.depth === 0)).toBe(true);
      expect(report.directDependents.every((d) => d.nodeType === 'fact')).toBe(true);
    });

    it('returns active facts where entity is object', async () => {
      const alice = await createTestEntity({ canonicalName: 'Alice', entityType: 'person' });
      const bob = await createTestEntity({ canonicalName: 'Bob', entityType: 'person' });
      const fact = await createTestFact({
        subjectEntityId: alice.id,
        predicate: 'knows',
        objectEntityId: bob.id,
      });

      const report = await analyzeImpact({ nodeType: 'entity', nodeId: bob.id });

      expect(report.directDependents.map((d) => d.nodeId)).toEqual([fact.id]);
      expect(report.directDependents[0]!.reasoning).toMatch(/object/);
    });

    it('excludes expired facts', async () => {
      const alice = await createTestEntity({ canonicalName: 'Alice', entityType: 'person' });
      await createTestFact({
        subjectEntityId: alice.id,
        predicate: 'knows',
        objectValue: 'Bob',
        expiredAt: new Date(),
      });
      const active = await createTestFact({
        subjectEntityId: alice.id,
        predicate: 'works_at',
        objectValue: 'Acme',
      });

      const report = await analyzeImpact({ nodeType: 'entity', nodeId: alice.id });

      expect(report.directDependents.map((d) => d.nodeId)).toEqual([active.id]);
    });
  });

  describe('fact root', () => {
    it('returns active facts sharing the subject entity (excluding the root)', async () => {
      const alice = await createTestEntity({ canonicalName: 'Alice', entityType: 'person' });
      const root = await createTestFact({
        subjectEntityId: alice.id,
        predicate: 'works_at',
        objectValue: 'Acme',
      });
      const sibling = await createTestFact({
        subjectEntityId: alice.id,
        predicate: 'lives_in',
        objectValue: 'Boston',
      });

      const report = await analyzeImpact({ nodeType: 'fact', nodeId: root.id });

      expect(report.directDependents.map((d) => d.nodeId)).toEqual([sibling.id]);
    });

    it('returns active facts sharing either subject or object entity', async () => {
      const alice = await createTestEntity({ canonicalName: 'Alice', entityType: 'person' });
      const acme = await createTestEntity({ canonicalName: 'Acme', entityType: 'company' });
      const root = await createTestFact({
        subjectEntityId: alice.id,
        predicate: 'works_at',
        objectEntityId: acme.id,
      });
      const aliceSibling = await createTestFact({
        subjectEntityId: alice.id,
        predicate: 'knows',
        objectValue: 'Bob',
      });
      const acmeSibling = await createTestFact({
        subjectEntityId: acme.id,
        predicate: 'employs',
        objectValue: 'Charlie',
      });

      const report = await analyzeImpact({ nodeType: 'fact', nodeId: root.id });

      const ids = report.directDependents.map((d) => d.nodeId).sort();
      expect(ids).toEqual([aliceSibling.id, acmeSibling.id].sort());
    });

    it('omits the root fact itself from direct dependents', async () => {
      const alice = await createTestEntity({ canonicalName: 'Alice', entityType: 'person' });
      const root = await createTestFact({
        subjectEntityId: alice.id,
        predicate: 'knows',
        objectValue: 'Bob',
      });

      const report = await analyzeImpact({ nodeType: 'fact', nodeId: root.id });

      expect(report.directDependents.map((d) => d.nodeId)).not.toContain(root.id);
    });
  });

  describe('causal_event root', () => {
    it('returns active causal_edges where event is cause or effect', async () => {
      const alice = await createTestEntity({ canonicalName: 'Alice', entityType: 'person' });
      const fact = await createTestFact({
        subjectEntityId: alice.id,
        predicate: 'knows',
        objectValue: 'Bob',
      });

      const e0 = await insertCausalEvent({ factId: fact.id, transitionType: 'created' });
      const e1 = await insertCausalEvent({ factId: fact.id, transitionType: 'strengthened' });
      const e2 = await insertCausalEvent({ factId: fact.id, transitionType: 'expired' });

      const edge1 = await insertCausalEdge({ causeEventId: e0, effectEventId: e1 });
      const edge2 = await insertCausalEdge({ causeEventId: e1, effectEventId: e2 });

      const report = await analyzeImpact({ nodeType: 'causal_event', nodeId: e1 });

      const ids = report.directDependents.map((d) => d.nodeId).sort();
      expect(ids).toEqual([edge1, edge2].sort());
      expect(report.directDependents.every((d) => d.nodeType === 'causal_edge')).toBe(true);
    });

    it('excludes expired causal_edges', async () => {
      const alice = await createTestEntity({ canonicalName: 'Alice', entityType: 'person' });
      const fact = await createTestFact({
        subjectEntityId: alice.id,
        predicate: 'knows',
        objectValue: 'Bob',
      });

      const e0 = await insertCausalEvent({ factId: fact.id });
      const e1 = await insertCausalEvent({ factId: fact.id });
      const e2 = await insertCausalEvent({ factId: fact.id });

      const liveEdge = await insertCausalEdge({ causeEventId: e0, effectEventId: e1 });
      await insertCausalEdge({
        causeEventId: e1,
        effectEventId: e2,
        expiredAt: new Date(),
      });

      const report = await analyzeImpact({ nodeType: 'causal_event', nodeId: e1 });

      expect(report.directDependents.map((d) => d.nodeId)).toEqual([liveEdge]);
    });

    it('returns empty when the event has no edges', async () => {
      const alice = await createTestEntity({ canonicalName: 'Alice', entityType: 'person' });
      const fact = await createTestFact({
        subjectEntityId: alice.id,
        predicate: 'knows',
        objectValue: 'Bob',
      });
      const eventId = await insertCausalEvent({ factId: fact.id });

      const report = await analyzeImpact({ nodeType: 'causal_event', nodeId: eventId });

      expect(report.directDependents).toEqual([]);
    });
  });
});

// ============================================
// C2 — Transitive chains (nmemo-437.2)
// ============================================

/** Build a linear chain: events e0..e_n with edges e0→e1, e1→e2, ... */
async function setupChain(
  length: number,
  factId: string,
): Promise<{ events: string[]; edges: string[] }> {
  const events: string[] = [];
  for (let i = 0; i < length; i++) {
    events.push(await insertCausalEvent({ factId, transitionType: 'created' }));
  }
  const edges: string[] = [];
  for (let i = 0; i < length - 1; i++) {
    edges.push(await insertCausalEdge({ causeEventId: events[i]!, effectEventId: events[i + 1]! }));
  }
  return { events, edges };
}

describe('Phase 4 — Transitive chains (nmemo-437.2)', () => {
  beforeEach(async () => {
    await cleanSlate();
  });

  it('walks forward from a causal event', async () => {
    const alice = await createTestEntity({ canonicalName: 'Alice', entityType: 'person' });
    const fact = await createTestFact({
      subjectEntityId: alice.id,
      predicate: 'knows',
      objectValue: 'Bob',
    });
    const { events, edges } = await setupChain(4, fact.id); // e0→e1→e2→e3

    const report = await analyzeImpact({ nodeType: 'causal_event', nodeId: events[0]! });

    const ids = new Set(report.transitiveChains.map((t) => t.nodeId));
    // depth-1 edge (direct) is in directDependents, not transitiveChains? Actually
    // findTransitiveChains starts at depth 1 from any edge touching the root, so the
    // first edge IS depth-1 transitive. directDependents (events → edges) overlaps;
    // the merged report contains both perspectives, which is intended.
    for (const e of edges) expect(ids.has(e)).toBe(true);
    const depths = report.transitiveChains.map((t) => t.depth);
    expect(Math.max(...depths)).toBeLessThanOrEqual(3);
  });

  it('walks backward from a causal event (reverse chain)', async () => {
    const alice = await createTestEntity({ canonicalName: 'Alice', entityType: 'person' });
    const fact = await createTestFact({
      subjectEntityId: alice.id,
      predicate: 'knows',
      objectValue: 'Bob',
    });
    const { events, edges } = await setupChain(4, fact.id); // e0→e1→e2→e3

    const report = await analyzeImpact({ nodeType: 'causal_event', nodeId: events[3]! });

    const ids = new Set(report.transitiveChains.map((t) => t.nodeId));
    for (const e of edges) expect(ids.has(e)).toBe(true);
  });

  it('walks both directions from a middle node', async () => {
    const alice = await createTestEntity({ canonicalName: 'Alice', entityType: 'person' });
    const fact = await createTestFact({
      subjectEntityId: alice.id,
      predicate: 'knows',
      objectValue: 'Bob',
    });
    const { events, edges } = await setupChain(5, fact.id); // e0→e1→e2→e3→e4

    const report = await analyzeImpact({
      nodeType: 'causal_event',
      nodeId: events[2]!, // middle
      maxDepth: 5,
    });

    const ids = new Set(report.transitiveChains.map((t) => t.nodeId));
    for (const e of edges) expect(ids.has(e)).toBe(true);
  });

  it('respects maxDepth cap', async () => {
    const alice = await createTestEntity({ canonicalName: 'Alice', entityType: 'person' });
    const fact = await createTestFact({
      subjectEntityId: alice.id,
      predicate: 'knows',
      objectValue: 'Bob',
    });
    const { events } = await setupChain(8, fact.id);

    const report = await analyzeImpact({
      nodeType: 'causal_event',
      nodeId: events[0]!,
      maxDepth: 2,
    });

    const depths = report.transitiveChains.map((t) => t.depth);
    expect(Math.max(...depths)).toBeLessThanOrEqual(2);
  });

  it('terminates cleanly on a 3-node cycle (A→B→C→A)', async () => {
    const alice = await createTestEntity({ canonicalName: 'Alice', entityType: 'person' });
    const fact = await createTestFact({
      subjectEntityId: alice.id,
      predicate: 'knows',
      objectValue: 'Bob',
    });
    const eA = await insertCausalEvent({ factId: fact.id });
    const eB = await insertCausalEvent({ factId: fact.id });
    const eC = await insertCausalEvent({ factId: fact.id });
    const eAB = await insertCausalEdge({ causeEventId: eA, effectEventId: eB });
    const eBC = await insertCausalEdge({ causeEventId: eB, effectEventId: eC });
    const eCA = await insertCausalEdge({ causeEventId: eC, effectEventId: eA });

    const report = await analyzeImpact({
      nodeType: 'causal_event',
      nodeId: eA,
      maxDepth: 10,
    });

    const ids = report.transitiveChains.map((t) => t.nodeId).sort();
    // Each cycle edge appears at most once thanks to DISTINCT ON (id)
    expect(ids).toEqual([eAB, eBC, eCA].sort());
    // No node_id appears twice
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('returns shortest depth for diamond topology (multi-path edge)', async () => {
    // E0 → E1 → E3 (depth 2 path)
    // E0 → E2 → E3 (depth 2 path; same edge E2→E3 NOT shared, but E1→E3 and
    // E2→E3 both point to E3; an alternate-effect hop reaches via shorter path)
    const alice = await createTestEntity({ canonicalName: 'Alice', entityType: 'person' });
    const fact = await createTestFact({
      subjectEntityId: alice.id,
      predicate: 'knows',
      objectValue: 'Bob',
    });
    const e0 = await insertCausalEvent({ factId: fact.id });
    const e1 = await insertCausalEvent({ factId: fact.id });
    const e2 = await insertCausalEvent({ factId: fact.id });
    const e3 = await insertCausalEvent({ factId: fact.id });
    await insertCausalEdge({ causeEventId: e0, effectEventId: e1 });
    await insertCausalEdge({ causeEventId: e0, effectEventId: e2 });
    const target = await insertCausalEdge({ causeEventId: e1, effectEventId: e3 });
    await insertCausalEdge({ causeEventId: e2, effectEventId: e3 });

    const report = await analyzeImpact({
      nodeType: 'causal_event',
      nodeId: e0,
      maxDepth: 5,
    });

    // Each edge appears exactly once
    const ids = report.transitiveChains.map((t) => t.nodeId);
    expect(new Set(ids).size).toBe(ids.length);
    // The target edge (E1→E3) is reachable; depth is the shortest reach
    const targetNode = report.transitiveChains.find((t) => t.nodeId === target);
    expect(targetNode).toBeDefined();
    expect(targetNode!.depth).toBeLessThanOrEqual(2);
  });

  it('excludes expired causal_edges from the walk', async () => {
    const alice = await createTestEntity({ canonicalName: 'Alice', entityType: 'person' });
    const fact = await createTestFact({
      subjectEntityId: alice.id,
      predicate: 'knows',
      objectValue: 'Bob',
    });
    const e0 = await insertCausalEvent({ factId: fact.id });
    const e1 = await insertCausalEvent({ factId: fact.id });
    const e2 = await insertCausalEvent({ factId: fact.id });
    const live = await insertCausalEdge({ causeEventId: e0, effectEventId: e1 });
    await insertCausalEdge({
      causeEventId: e1,
      effectEventId: e2,
      expiredAt: new Date(),
    });

    const report = await analyzeImpact({
      nodeType: 'causal_event',
      nodeId: e0,
      maxDepth: 5,
    });

    const ids = report.transitiveChains.map((t) => t.nodeId);
    expect(ids).toEqual([live]);
  });

  it('returns empty when no events anchor the walk (entity with no events)', async () => {
    const alice = await createTestEntity({ canonicalName: 'Alice', entityType: 'person' });
    const report = await analyzeImpact({ nodeType: 'entity', nodeId: alice.id });
    expect(report.transitiveChains).toEqual([]);
  });
});

// ============================================
// C2 — Citation dependents (nmemo-437.3)
// ============================================

async function seedEdgeCitingFact(params: {
  factId: string;
  causeEventId: string;
  effectEventId: string;
  strength?: number;
  corroborationCount?: number;
}): Promise<string> {
  const edgeId = await insertCausalEdge({
    causeEventId: params.causeEventId,
    effectEventId: params.effectEventId,
    strength: params.strength,
    corroborationCount: params.corroborationCount,
  });
  // Phase 3 source-refs index: directly seed the row (mirrors the pattern from
  // source-refs-index.test.ts adversarial fixtures).
  await testDb`
    INSERT INTO edge_source_refs (edge_id, ref_type, ref_id)
    VALUES (${edgeId}::uuid, 'fact', ${params.factId}::uuid)
  `;
  return edgeId;
}

describe('Phase 4 — Citation dependents (nmemo-437.3)', () => {
  beforeEach(async () => {
    await cleanSlate();
  });

  it('finds active edges citing the fact as evidence', async () => {
    const alice = await createTestEntity({ canonicalName: 'Alice', entityType: 'person' });
    const fact = await createTestFact({
      subjectEntityId: alice.id,
      predicate: 'knows',
      objectValue: 'Bob',
    });
    const e0 = await insertCausalEvent({ factId: fact.id });
    const e1 = await insertCausalEvent({ factId: fact.id });
    const e2 = await insertCausalEvent({ factId: fact.id });

    const edge1 = await seedEdgeCitingFact({
      factId: fact.id,
      causeEventId: e0,
      effectEventId: e1,
    });
    const edge2 = await seedEdgeCitingFact({
      factId: fact.id,
      causeEventId: e1,
      effectEventId: e2,
    });

    const report = await analyzeImpact({ nodeType: 'fact', nodeId: fact.id });

    const ids = report.citationDependents.map((d) => d.nodeId).sort();
    expect(ids).toEqual([edge1, edge2].sort());
    expect(report.citationDependents.every((d) => d.relationship === 'citation')).toBe(true);
    expect(report.citationDependents.every((d) => d.depth === 0)).toBe(true);
    expect(report.citationDependents.every((d) => d.nodeType === 'causal_edge')).toBe(true);
  });

  it('excludes expired citing edges', async () => {
    const alice = await createTestEntity({ canonicalName: 'Alice', entityType: 'person' });
    const fact = await createTestFact({
      subjectEntityId: alice.id,
      predicate: 'knows',
      objectValue: 'Bob',
    });
    const e0 = await insertCausalEvent({ factId: fact.id });
    const e1 = await insertCausalEvent({ factId: fact.id });

    const liveEdge = await seedEdgeCitingFact({
      factId: fact.id,
      causeEventId: e0,
      effectEventId: e1,
    });
    const expiredEdge = await insertCausalEdge({
      causeEventId: e0,
      effectEventId: e1,
      expiredAt: new Date(),
    });
    await testDb`
      INSERT INTO edge_source_refs (edge_id, ref_type, ref_id)
      VALUES (${expiredEdge}::uuid, 'fact', ${fact.id}::uuid)
    `;

    const report = await analyzeImpact({ nodeType: 'fact', nodeId: fact.id });

    expect(report.citationDependents.map((d) => d.nodeId)).toEqual([liveEdge]);
  });

  it('returns empty for causal_event roots (no citation analogue)', async () => {
    const alice = await createTestEntity({ canonicalName: 'Alice', entityType: 'person' });
    const fact = await createTestFact({
      subjectEntityId: alice.id,
      predicate: 'knows',
      objectValue: 'Bob',
    });
    const eventId = await insertCausalEvent({ factId: fact.id });

    const report = await analyzeImpact({ nodeType: 'causal_event', nodeId: eventId });

    expect(report.citationDependents).toEqual([]);
  });

  it('finds edges citing an entity', async () => {
    const alice = await createTestEntity({ canonicalName: 'Alice', entityType: 'person' });
    const fact = await createTestFact({
      subjectEntityId: alice.id,
      predicate: 'knows',
      objectValue: 'Bob',
    });
    const e0 = await insertCausalEvent({ factId: fact.id });
    const e1 = await insertCausalEvent({ factId: fact.id });
    const edgeId = await insertCausalEdge({ causeEventId: e0, effectEventId: e1 });
    await testDb`
      INSERT INTO edge_source_refs (edge_id, ref_type, ref_id)
      VALUES (${edgeId}::uuid, 'entity', ${alice.id}::uuid)
    `;

    const report = await analyzeImpact({ nodeType: 'entity', nodeId: alice.id });

    expect(report.citationDependents.map((d) => d.nodeId)).toEqual([edgeId]);
  });
});
