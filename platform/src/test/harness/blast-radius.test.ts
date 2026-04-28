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

// ============================================
// C3 — Severity scoring (nmemo-437.4)
// ============================================

describe('Phase 4 — Severity scoring (nmemo-437.4)', () => {
  beforeEach(async () => {
    await cleanSlate();
  });

  it('scores transitive depth=1 as high', async () => {
    const alice = await createTestEntity({ canonicalName: 'Alice', entityType: 'person' });
    const fact = await createTestFact({
      subjectEntityId: alice.id,
      predicate: 'knows',
      objectValue: 'Bob',
    });
    const { events } = await setupChain(2, fact.id);

    const report = await analyzeImpact({ nodeType: 'causal_event', nodeId: events[0]! });

    const transitive = report.transitiveChains.find((t) => t.depth === 1);
    expect(transitive?.severity).toBe('high');
  });

  it('scores transitive depth=2 as medium', async () => {
    const alice = await createTestEntity({ canonicalName: 'Alice', entityType: 'person' });
    const fact = await createTestFact({
      subjectEntityId: alice.id,
      predicate: 'knows',
      objectValue: 'Bob',
    });
    const { events } = await setupChain(3, fact.id);

    const report = await analyzeImpact({
      nodeType: 'causal_event',
      nodeId: events[0]!,
      maxDepth: 5,
    });

    const depth2 = report.transitiveChains.find((t) => t.depth === 2);
    expect(depth2?.severity).toBe('medium');
  });

  it('scores transitive depth=3 as low', async () => {
    const alice = await createTestEntity({ canonicalName: 'Alice', entityType: 'person' });
    const fact = await createTestFact({
      subjectEntityId: alice.id,
      predicate: 'knows',
      objectValue: 'Bob',
    });
    const { events } = await setupChain(4, fact.id);

    const report = await analyzeImpact({
      nodeType: 'causal_event',
      nodeId: events[0]!,
      maxDepth: 5,
    });

    const depth3 = report.transitiveChains.find((t) => t.depth === 3);
    expect(depth3?.severity).toBe('low');
  });

  it('scores strong active citation (strength>=0.7) as high', async () => {
    const alice = await createTestEntity({ canonicalName: 'Alice', entityType: 'person' });
    const fact = await createTestFact({
      subjectEntityId: alice.id,
      predicate: 'knows',
      objectValue: 'Bob',
    });
    const e0 = await insertCausalEvent({ factId: fact.id });
    const e1 = await insertCausalEvent({ factId: fact.id });
    const edgeId = await seedEdgeCitingFact({
      factId: fact.id,
      causeEventId: e0,
      effectEventId: e1,
      strength: 0.85,
    });

    const report = await analyzeImpact({ nodeType: 'fact', nodeId: fact.id });

    const citation = report.citationDependents.find((d) => d.nodeId === edgeId);
    expect(citation?.severity).toBe('high');
  });

  it('scores weak citation (strength<0.7) as medium', async () => {
    const alice = await createTestEntity({ canonicalName: 'Alice', entityType: 'person' });
    const fact = await createTestFact({
      subjectEntityId: alice.id,
      predicate: 'knows',
      objectValue: 'Bob',
    });
    const e0 = await insertCausalEvent({ factId: fact.id });
    const e1 = await insertCausalEvent({ factId: fact.id });
    const edgeId = await seedEdgeCitingFact({
      factId: fact.id,
      causeEventId: e0,
      effectEventId: e1,
      strength: 0.5,
    });

    const report = await analyzeImpact({ nodeType: 'fact', nodeId: fact.id });

    const citation = report.citationDependents.find((d) => d.nodeId === edgeId);
    expect(citation?.severity).toBe('medium');
  });

  it('scores direct fact sharing entity as medium', async () => {
    const alice = await createTestEntity({ canonicalName: 'Alice', entityType: 'person' });
    const sibling = await createTestFact({
      subjectEntityId: alice.id,
      predicate: 'lives_in',
      objectValue: 'Boston',
    });

    const report = await analyzeImpact({ nodeType: 'entity', nodeId: alice.id });

    const direct = report.directDependents.find((d) => d.nodeId === sibling.id);
    expect(direct?.severity).toBe('medium');
  });

  it('scores direct edge dependent of causal_event root as high', async () => {
    const alice = await createTestEntity({ canonicalName: 'Alice', entityType: 'person' });
    const fact = await createTestFact({
      subjectEntityId: alice.id,
      predicate: 'knows',
      objectValue: 'Bob',
    });
    const e0 = await insertCausalEvent({ factId: fact.id });
    const e1 = await insertCausalEvent({ factId: fact.id });
    const edge = await insertCausalEdge({ causeEventId: e0, effectEventId: e1 });

    const report = await analyzeImpact({ nodeType: 'causal_event', nodeId: e0 });

    const direct = report.directDependents.find((d) => d.nodeId === edge);
    expect(direct?.severity).toBe('high');
  });

  it('severitySummary tallies match per-node severity', async () => {
    const alice = await createTestEntity({ canonicalName: 'Alice', entityType: 'person' });
    const fact = await createTestFact({
      subjectEntityId: alice.id,
      predicate: 'knows',
      objectValue: 'Bob',
    });
    const { events } = await setupChain(4, fact.id);

    const report = await analyzeImpact({
      nodeType: 'causal_event',
      nodeId: events[0]!,
      maxDepth: 5,
    });

    const allNodes = [
      ...report.directDependents,
      ...report.transitiveChains,
      ...report.citationDependents,
      ...report.patternImpact,
    ];
    const counted = { critical: 0, high: 0, medium: 0, low: 0 };
    for (const n of allNodes) counted[n.severity]++;

    expect(report.severitySummary).toEqual(counted);
    expect(report.totalAffected).toBe(allNodes.length);
  });
});

// ============================================
// C3 — Hypothetical mode (nmemo-437.5)
// ============================================

describe('Phase 4 — Hypothetical mode (nmemo-437.5)', () => {
  beforeEach(async () => {
    await cleanSlate();
  });

  it('hypothetical=expire bumps sole-evidence citation to critical', async () => {
    const alice = await createTestEntity({ canonicalName: 'Alice', entityType: 'person' });
    const fact = await createTestFact({
      subjectEntityId: alice.id,
      predicate: 'knows',
      objectValue: 'Bob',
    });
    const e0 = await insertCausalEvent({ factId: fact.id });
    const e1 = await insertCausalEvent({ factId: fact.id });
    const edgeId = await seedEdgeCitingFact({
      factId: fact.id,
      causeEventId: e0,
      effectEventId: e1,
      strength: 0.5,
      corroborationCount: 1,
    });

    const reportNoHypo = await analyzeImpact({ nodeType: 'fact', nodeId: fact.id });
    const reportHypo = await analyzeImpact({
      nodeType: 'fact',
      nodeId: fact.id,
      hypothetical: 'expire',
    });

    // Without hypothetical: weak strength → medium
    expect(reportNoHypo.citationDependents.find((d) => d.nodeId === edgeId)?.severity).toBe('medium');
    // With hypothetical=expire and sole evidence → critical
    expect(reportHypo.citationDependents.find((d) => d.nodeId === edgeId)?.severity).toBe('critical');
  });

  it('hypothetical=expire does NOT bump multi-source citation severity', async () => {
    const alice = await createTestEntity({ canonicalName: 'Alice', entityType: 'person' });
    const bob = await createTestEntity({ canonicalName: 'Bob', entityType: 'person' });
    const factA = await createTestFact({
      subjectEntityId: alice.id,
      predicate: 'knows',
      objectValue: 'Charlie',
    });
    const factB = await createTestFact({
      subjectEntityId: bob.id,
      predicate: 'knows',
      objectValue: 'Charlie',
    });
    const e0 = await insertCausalEvent({ factId: factA.id });
    const e1 = await insertCausalEvent({ factId: factA.id });
    const edgeId = await insertCausalEdge({
      causeEventId: e0,
      effectEventId: e1,
      strength: 0.8,
    });
    await testDb`
      INSERT INTO edge_source_refs (edge_id, ref_type, ref_id)
      VALUES (${edgeId}::uuid, 'fact', ${factA.id}::uuid)
    `;
    await testDb`
      INSERT INTO edge_source_refs (edge_id, ref_type, ref_id)
      VALUES (${edgeId}::uuid, 'fact', ${factB.id}::uuid)
    `;

    const report = await analyzeImpact({
      nodeType: 'fact',
      nodeId: factA.id,
      hypothetical: 'expire',
    });

    const citation = report.citationDependents.find((d) => d.nodeId === edgeId);
    // Multi-source: even under hypothetical, severity stays high (strength>=0.7)
    expect(citation?.severity).toBe('high');
  });

  it('hypothetical=expire makes ZERO database mutations', async () => {
    const alice = await createTestEntity({ canonicalName: 'Alice', entityType: 'person' });
    const fact = await createTestFact({
      subjectEntityId: alice.id,
      predicate: 'knows',
      objectValue: 'Bob',
    });
    const e0 = await insertCausalEvent({ factId: fact.id });
    const e1 = await insertCausalEvent({ factId: fact.id });
    const edgeId = await seedEdgeCitingFact({
      factId: fact.id,
      causeEventId: e0,
      effectEventId: e1,
      strength: 0.5,
    });

    await analyzeImpact({
      nodeType: 'fact',
      nodeId: fact.id,
      hypothetical: 'expire',
    });

    // Verify NO mutation across the involved rows
    const factRow = await testDb`SELECT expired_at, invalid_at FROM facts WHERE id = ${fact.id}::uuid`;
    expect(factRow[0]!.expired_at).toBeNull();
    expect(factRow[0]!.invalid_at).toBeNull();

    const edgeRow = await testDb`SELECT expired_at FROM causal_edges WHERE id = ${edgeId}::uuid`;
    expect(edgeRow[0]!.expired_at).toBeNull();

    // No fact_history row should have been written for this fact
    const historyRows = await testDb`SELECT count(*)::int AS c FROM fact_history WHERE fact_id = ${fact.id}::uuid`;
    expect((historyRows[0]! as { c: number }).c).toBe(0);
  });

  it('without hypothetical, sole-evidence citations stay at base severity', async () => {
    const alice = await createTestEntity({ canonicalName: 'Alice', entityType: 'person' });
    const fact = await createTestFact({
      subjectEntityId: alice.id,
      predicate: 'knows',
      objectValue: 'Bob',
    });
    const e0 = await insertCausalEvent({ factId: fact.id });
    const e1 = await insertCausalEvent({ factId: fact.id });
    const edgeId = await seedEdgeCitingFact({
      factId: fact.id,
      causeEventId: e0,
      effectEventId: e1,
      strength: 0.4, // weak
    });

    const report = await analyzeImpact({ nodeType: 'fact', nodeId: fact.id });

    const citation = report.citationDependents.find((d) => d.nodeId === edgeId);
    // No hypothetical → no critical bump even with sole evidence
    expect(citation?.severity).toBe('medium');
    expect(report.severitySummary.critical).toBe(0);
  });
});

// ============================================
// C3 — Pattern impact (nmemo-437.4 cont.)
// ============================================

describe('Phase 4 — Pattern impact (Phase 6 forward-compat)', () => {
  beforeEach(async () => {
    await cleanSlate();
  });

  it('returns empty when no patterns exist (Phase 6 not shipped)', async () => {
    const alice = await createTestEntity({ canonicalName: 'Alice', entityType: 'person' });
    const fact = await createTestFact({
      subjectEntityId: alice.id,
      predicate: 'knows',
      objectValue: 'Bob',
    });
    const eventId = await insertCausalEvent({ factId: fact.id });
    await analyzeImpact({ nodeType: 'causal_event', nodeId: eventId });
    // No throw → query is safe even with no patterns. Empty patternImpact is the explicit assertion in C1's foundation test.
    const report = await analyzeImpact({ nodeType: 'causal_event', nodeId: eventId });
    expect(report.patternImpact).toEqual([]);
  });

  it('finds provisional/canonical patterns referenced by the root events', async () => {
    const alice = await createTestEntity({ canonicalName: 'Alice', entityType: 'person' });
    const fact = await createTestFact({
      subjectEntityId: alice.id,
      predicate: 'knows',
      objectValue: 'Bob',
    });
    const e0 = await insertCausalEvent({ factId: fact.id });
    const e1 = await insertCausalEvent({ factId: fact.id });

    // Seed a pattern (forward-compat for Phase 6 — verifies the JOIN works)
    const patternRows = await testDb`
      INSERT INTO causal_patterns (
        name, description, template_structure, template_length, status
      ) VALUES (
        'Test Pattern', 'A test', '{}'::jsonb, 2, 'canonical'
      )
      RETURNING id
    `;
    const patternId = (patternRows[0] as { id: string }).id;

    await testDb`
      INSERT INTO causal_edges (
        cause_event_id, effect_event_id, strength, reasoning, source_references,
        extraction_method, corroboration_count, initial_strength, pattern_id, pattern_position
      ) VALUES (
        ${e0}::uuid, ${e1}::uuid, 0.7, 'patterned edge', '[]'::jsonb,
        'manual', 1, 0.7, ${patternId}::uuid, 0
      )
    `;

    const report = await analyzeImpact({ nodeType: 'causal_event', nodeId: e0 });

    expect(report.patternImpact.map((p) => p.nodeId)).toEqual([patternId]);
    expect(report.patternImpact[0]!.severity).toBe('low');
    expect(report.patternImpact[0]!.relationship).toBe('pattern_member');
  });

  it('omits staging-status patterns', async () => {
    const alice = await createTestEntity({ canonicalName: 'Alice', entityType: 'person' });
    const fact = await createTestFact({
      subjectEntityId: alice.id,
      predicate: 'knows',
      objectValue: 'Bob',
    });
    const e0 = await insertCausalEvent({ factId: fact.id });
    const e1 = await insertCausalEvent({ factId: fact.id });

    const patternRows = await testDb`
      INSERT INTO causal_patterns (
        name, description, template_structure, template_length, status
      ) VALUES (
        'Staging Pattern', 'A test', '{}'::jsonb, 2, 'staging'
      )
      RETURNING id
    `;
    const patternId = (patternRows[0] as { id: string }).id;

    await testDb`
      INSERT INTO causal_edges (
        cause_event_id, effect_event_id, strength, reasoning, source_references,
        extraction_method, corroboration_count, initial_strength, pattern_id, pattern_position
      ) VALUES (
        ${e0}::uuid, ${e1}::uuid, 0.7, 'patterned edge', '[]'::jsonb,
        'manual', 1, 0.7, ${patternId}::uuid, 0
      )
    `;

    const report = await analyzeImpact({ nodeType: 'causal_event', nodeId: e0 });

    expect(report.patternImpact.map((p) => p.nodeId)).not.toContain(patternId);
  });

  it('respects includePatterns=false', async () => {
    const alice = await createTestEntity({ canonicalName: 'Alice', entityType: 'person' });
    const fact = await createTestFact({
      subjectEntityId: alice.id,
      predicate: 'knows',
      objectValue: 'Bob',
    });
    const eventId = await insertCausalEvent({ factId: fact.id });

    const report = await analyzeImpact({
      nodeType: 'causal_event',
      nodeId: eventId,
      includePatterns: false,
    });

    expect(report.patternImpact).toEqual([]);
  });
});
