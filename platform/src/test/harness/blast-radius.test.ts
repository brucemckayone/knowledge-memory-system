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
