/**
 * Unit tests for the semantic (tolerance) graph diff (doc 38 correctness
 * upgrade). Pure — no DB / infra. Proves fuzzy entity matching, predicate
 * normalisation, the synonym lower-bound, and the P/R/F1 arithmetic that the
 * determinism + litmus signals are built on.
 */

import { describe, it, expect } from 'vitest';
import type { CanonicalGraph } from '../../services/graph-canonical.js';
import {
  semanticDiff,
  parseEntityKey,
  parseFactKey,
  normalizePredicate,
  normalizeType,
} from '../../services/graph-canonical-semantic.js';

/** Build a minimal CanonicalGraph from entity keys + fact keys. semanticDiff
 *  only reads `entities` and `facts`; the rest are stubs to satisfy the type. */
function g(entities: string[], factKeys: string[] = []): CanonicalGraph {
  return {
    entities,
    facts: factKeys.map((key) => ({ key, confidence: 1 })),
    events: [],
    edges: [],
    sameAs: [],
    counts: {
      entities: entities.length,
      distinctEntities: new Set(entities).size,
      activeFacts: factKeys.length,
      distinctFacts: new Set(factKeys).size,
      events: 0,
      activeEdges: 0,
      sameAs: 0,
    },
    structuralHash: 'test',
  };
}

describe('parsing helpers', () => {
  it('parses entity keys, splitting on the last pipe', () => {
    expect(parseEntityKey('elena vasquez|person')).toEqual({ name: 'elena vasquez', type: 'person' });
    expect(parseEntityKey('a|b|person')).toEqual({ name: 'a|b', type: 'person' });
    expect(parseEntityKey('noPipe')).toEqual({ name: 'noPipe', type: '' });
  });

  it('parses fact keys into subj / pred / obj', () => {
    const f = parseFactKey('elena|person :: role_at :: helix|company');
    expect(f.subj).toEqual({ name: 'elena', type: 'person' });
    expect(f.pred).toBe('role_at');
    expect(f.obj).toEqual({ kind: 'entity', ent: { name: 'helix', type: 'company' } });
  });

  it('parses value objects', () => {
    const f = parseFactKey('victor|person :: born_in :: value:geneva');
    expect(f.obj).toEqual({ kind: 'value', text: 'geneva' });
  });

  it('normalises predicates and type synonyms', () => {
    expect(normalizePredicate('Role At')).toBe('role_at');
    expect(normalizePredicate('role_at')).toBe('role_at');
    expect(normalizePredicate('  works-AT! ')).toBe('works_at');
    expect(normalizeType('organization')).toBe('company');
    expect(normalizeType('people')).toBe('person');
    expect(normalizeType('food')).toBe('food');
  });
});

describe('semanticDiff — entities', () => {
  it('scores identical entity sets as 1.0', () => {
    const a = g(['elena vasquez|person', 'helix robotics|company']);
    const d = semanticDiff(a, a);
    expect(d.entity.f1).toBe(1);
  });

  it('matches fuzzy name variants (substring, either direction)', () => {
    const a = g(['elena|person']);
    const b = g(['elena vasquez|person']);
    expect(semanticDiff(a, b).entity.f1).toBe(1);
  });

  it('folds type synonyms but not unrelated types', () => {
    expect(semanticDiff(g(['acme|company']), g(['acme|organization'])).entity.f1).toBe(1);
    expect(semanticDiff(g(['apple|company']), g(['apple|food'])).entity.f1).toBe(0);
  });

  it('computes partial overlap precision/recall', () => {
    // A has 2 entities, B has 1 matching one → precision 1/2, recall 1/1.
    const d = semanticDiff(g(['elena|person', 'marcus|person']), g(['elena vasquez|person']));
    expect(d.entity.precision).toBeCloseTo(0.5, 5);
    expect(d.entity.recall).toBeCloseTo(1, 5);
    expect(d.entity.f1).toBeCloseTo(2 / 3, 5);
  });

  it('scores disjoint entities as 0', () => {
    expect(semanticDiff(g(['x|person']), g(['y|company'])).entity.f1).toBe(0);
  });
});

describe('semanticDiff — facts', () => {
  const subj = 'elena|person';
  const obj = 'helix|company';

  it('matches facts under predicate normalisation', () => {
    const a = g([subj, obj], [`${subj} :: role_at :: ${obj}`]);
    const b = g([subj, obj], [`${subj} :: Role At :: ${obj}`]);
    expect(semanticDiff(a, b).fact.f1).toBe(1);
  });

  it('does NOT collapse predicate synonyms (documents the lower bound)', () => {
    const a = g([subj, obj], [`${subj} :: role_at :: ${obj}`]);
    const b = g([subj, obj], [`${subj} :: title :: ${obj}`]);
    expect(semanticDiff(a, b).fact.f1).toBe(0);
  });

  it('matches value objects case-insensitively', () => {
    const a = g(['victor|person'], ['victor|person :: born_in :: value:Geneva']);
    const b = g(['victor|person'], ['victor|person :: born_in :: value:geneva']);
    expect(semanticDiff(a, b).fact.f1).toBe(1);
  });

  it('matches facts even when the subject is a fuzzy name variant', () => {
    const a = g(['elena|person', obj], [`elena|person :: role_at :: ${obj}`]);
    const b = g(['elena vasquez|person', obj], [`elena vasquez|person :: role_at :: ${obj}`]);
    expect(semanticDiff(a, b).fact.f1).toBe(1);
  });
});

describe('semanticDiff — edge cases', () => {
  it('scores two empty graphs as 1.0', () => {
    const d = semanticDiff(g([]), g([]));
    expect(d.entity.f1).toBe(1);
    expect(d.fact.f1).toBe(1);
  });

  it('scores empty-vs-nonempty as 0', () => {
    const d = semanticDiff(g([]), g(['x|person']));
    expect(d.entity.f1).toBe(0);
  });
});
