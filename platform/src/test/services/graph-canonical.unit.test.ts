/**
 * Unit tests for the canonical-graph harness core (doc 38).
 * Pure — no DB / infra. Proves the keying, hashing, and diff logic, including
 * the id/order-independence that underpins the determinism + litmus tests.
 */

import { describe, it, expect } from 'vitest';
import {
  buildCanonicalGraph,
  diffCanonicalGraphs,
  multisetMinus,
  entityKey,
  type RawGraphRows,
} from '../../services/graph-canonical.js';

interface Ids {
  walton: string;
  victor: string;
  factRescue: string;
  factBorn: string;
  evRescue: string;
  evBorn: string;
  edge: string;
}

/**
 * A small but representative graph. ids are parameterised so we can build the
 * *same logical graph* with different UUIDs — the canonical form must be
 * identical regardless of ids (the litmus mechanism).
 */
function sampleGraph(ids: Ids): RawGraphRows {
  return {
    entities: [
      { id: ids.walton, name: 'Robert Walton', type: 'person' },
      { id: ids.victor, name: 'Victor Frankenstein', type: 'person' },
    ],
    facts: [
      { id: ids.factRescue, subj: ids.walton, pred: 'rescued', objId: ids.victor, objVal: null, conf: 0.9 },
      { id: ids.factBorn, subj: ids.victor, pred: 'born_in', objId: null, objVal: 'Geneva', conf: 0.8 },
    ],
    events: [
      { id: ids.evRescue, subj: ids.walton, pred: 'rescued', tt: 'created', factId: ids.factRescue },
      { id: ids.evBorn, subj: ids.victor, pred: 'born_in', tt: 'created', factId: ids.factBorn },
    ],
    edges: [{ id: ids.edge, cause: ids.evRescue, effect: ids.evBorn, strength: 0.5 }],
    sameAs: [],
  };
}

const A_IDS: Ids = { walton: 'a1', victor: 'a2', factRescue: 'a3', factBorn: 'a4', evRescue: 'a5', evBorn: 'a6', edge: 'a7' };
const B_IDS: Ids = { walton: 'b1', victor: 'b2', factRescue: 'b3', factBorn: 'b4', evRescue: 'b5', evBorn: 'b6', edge: 'b7' };

function reversed(g: RawGraphRows): RawGraphRows {
  return {
    entities: [...g.entities].reverse(),
    facts: [...g.facts].reverse(),
    events: [...g.events].reverse(),
    edges: [...g.edges].reverse(),
    sameAs: [...g.sameAs].reverse(),
  };
}

describe('entityKey', () => {
  it('case-folds and trims name + type', () => {
    expect(entityKey('  Victor Frankenstein ', 'Person')).toBe('victor frankenstein|person');
  });
});

describe('buildCanonicalGraph', () => {
  it('produces content-addressed keys and counts', () => {
    const g = buildCanonicalGraph(sampleGraph(A_IDS));
    expect(g.entities).toEqual(['robert walton|person', 'victor frankenstein|person']);
    expect(g.facts.map((f) => f.key)).toContain('robert walton|person :: rescued :: victor frankenstein|person');
    expect(g.facts.map((f) => f.key)).toContain('victor frankenstein|person :: born_in :: value:geneva');
    expect(g.edges).toHaveLength(1);
    expect(g.edges[0]!.key).toBe(
      'robert walton|person :: rescued :: victor frankenstein|person :: created' +
        ' => ' +
        'victor frankenstein|person :: born_in :: value:geneva :: created',
    );
    expect(g.counts).toMatchObject({ entities: 2, distinctEntities: 2, activeFacts: 2, events: 2, activeEdges: 1 });
  });

  it('is identical under different UUIDs (id-independence — litmus core)', () => {
    const a = buildCanonicalGraph(sampleGraph(A_IDS));
    const b = buildCanonicalGraph(sampleGraph(B_IDS));
    expect(b.structuralHash).toBe(a.structuralHash);
  });

  it('is identical under reversed row order (order-independence — litmus core)', () => {
    const a = buildCanonicalGraph(sampleGraph(A_IDS));
    const b = buildCanonicalGraph(reversed(sampleGraph(B_IDS)));
    expect(b.structuralHash).toBe(a.structuralHash);
  });

  it('surfaces duplicate entities as repeated keys (entity explosion signal)', () => {
    const raw = sampleGraph(A_IDS);
    // a second, distinct entity row with the same name|type — the dup we want to detect
    raw.entities.push({ id: 'dup', name: 'victor frankenstein', type: 'PERSON' });
    const g = buildCanonicalGraph(raw);
    expect(g.counts.entities).toBe(3);
    expect(g.counts.distinctEntities).toBe(2);
  });

  it('strength changes do not affect the structural hash', () => {
    const base = sampleGraph(A_IDS);
    const stronger = { ...base, edges: [{ ...base.edges[0]!, strength: 0.95 }] };
    expect(buildCanonicalGraph(stronger).structuralHash).toBe(buildCanonicalGraph(base).structuralHash);
  });
});

describe('multisetMinus', () => {
  it('respects repeat counts', () => {
    expect(multisetMinus(['x', 'x', 'y'], ['x', 'y'])).toEqual(['x']);
    expect(multisetMinus(['x', 'y'], ['x', 'x', 'y'])).toEqual([]);
  });
});

describe('diffCanonicalGraphs', () => {
  it('reports a structural match for identical graphs', () => {
    const a = buildCanonicalGraph(sampleGraph(A_IDS));
    const b = buildCanonicalGraph(sampleGraph(B_IDS));
    const d = diffCanonicalGraphs(a, b);
    expect(d.structuralMatch).toBe(true);
    expect(d.factsOnlyInA).toEqual([]);
    expect(d.factsOnlyInB).toEqual([]);
    expect(d.entitiesOnlyInA).toEqual([]);
  });

  it('reports a fact present only in one side', () => {
    const baseRaw = sampleGraph(A_IDS);
    const extraRaw = sampleGraph(B_IDS);
    extraRaw.facts.push({ id: 'b8', subj: B_IDS.victor, pred: 'created', objVal: 'the creature', objId: null, conf: 1 });
    const a = buildCanonicalGraph(baseRaw);
    const b = buildCanonicalGraph(extraRaw);
    const d = diffCanonicalGraphs(a, b);
    expect(d.structuralMatch).toBe(false);
    expect(d.factsOnlyInB).toContain('victor frankenstein|person :: created :: value:the creature');
    expect(d.factsOnlyInA).toEqual([]);
  });

  it('counts duplicate facts per side', () => {
    const dupRaw = sampleGraph(A_IDS);
    // a second identical-triple fact (the write-race / P1 hazard)
    dupRaw.facts.push({ id: 'a9', subj: A_IDS.walton, pred: 'rescued', objId: A_IDS.victor, objVal: null, conf: 0.9 });
    const a = buildCanonicalGraph(dupRaw);
    const b = buildCanonicalGraph(sampleGraph(B_IDS));
    const d = diffCanonicalGraphs(a, b);
    expect(d.duplicateFactsA).toBe(1);
    expect(d.duplicateFactsB).toBe(0);
  });
});
