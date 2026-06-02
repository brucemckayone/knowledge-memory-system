/**
 * Unit tests for ground-truth correctness scoring (nmemo-hm4.4).
 *
 * Pure - runs under vitest.unit.config.ts (NO DB, NO globalSetup). Fixtures are
 * hand-built partial {@link RichGraph}s (cast `as RichGraph`) plus small
 * synthetic {@link GoldGraph}s. The headline assertions encode the doc-39
 * failures: a perfect match scores F1=1 / currentStateCorrectness=1; Elena with
 * 5 active titles vs a gold expecting 1 fails the expectation AND trips
 * predicate sprawl; a missing entity drops recall; an extra fact drops precision.
 */

import { describe, it, expect } from 'vitest';
import type { RichGraph } from '../../services/graph-canonical-query.js';
import { scoreAgainstGold, type GoldGraph } from '../../services/graph-correctness.js';

// ---- fixture builders (mirrors graph-invariants.unit.test.ts) -----------

type Fact = RichGraph['facts'][number];
type Entity = RichGraph['entities'][number];

let seq = 0;
const id = (p: string): string => `${p}-${(seq += 1).toString().padStart(4, '0')}`;

function entity(eid: string, name: string, type = 'person'): Entity {
  return { id: eid, name, type, description: null, summary: null, mergedFrom: null, confidence: 0.9, createdAt: new Date() };
}

function fact(partial: Partial<Fact> & Pick<Fact, 'subjectEntityId' | 'predicate'>): Fact {
  return {
    id: id('fact'),
    objectEntityId: null,
    objectValue: null,
    confidence: 0.9,
    validAt: null,
    invalidAt: null,
    createdAt: new Date(),
    expiredAt: null,
    expireReason: null,
    sourceMemoryId: null,
    ...partial,
  } as Fact;
}

/** Assemble a RichGraph from parts; unspecified collections default to empty. */
function graph(parts: Partial<RichGraph>): RichGraph {
  return {
    entities: [],
    facts: [],
    events: [],
    edges: [],
    sameAs: [],
    contradictions: [],
    reports: { extraction: [], gardening: [], reasoning: [] },
    counts: {} as RichGraph['counts'],
    ...parts,
  } as RichGraph;
}

// ---- perfect match ------------------------------------------------------

describe('scoreAgainstGold — perfect match', () => {
  it('scores F1=1 on entities + current facts and currentStateCorrectness=1', () => {
    const elenaId = 'elena';
    const helixId = 'helix';
    const g = graph({
      entities: [entity(elenaId, 'Elena Vasquez'), entity(helixId, 'Helix Robotics', 'company')],
      facts: [
        fact({ subjectEntityId: elenaId, predicate: 'works_at', objectEntityId: helixId }),
        fact({ subjectEntityId: elenaId, predicate: 'job_title', objectValue: 'chief technology officer' }),
        fact({ subjectEntityId: helixId, predicate: 'headquartered_in', objectValue: 'Austin' }),
      ],
    });
    const gold: GoldGraph = {
      corpus: 'test',
      entities: [
        { name: 'Elena Vasquez', type: 'person' },
        { name: 'Helix Robotics', type: 'company' },
      ],
      currentFacts: [
        { subject: 'Elena Vasquez', predicate: 'works_at', object: 'Helix Robotics' },
        { subject: 'Elena Vasquez', predicate: 'job_title', object: 'chief technology officer' },
        { subject: 'Helix Robotics', predicate: 'headquartered_in', object: 'Austin' },
      ],
      exclusiveExpectations: [
        { subject: 'Elena Vasquez', group: 'role_title', expectedObject: 'chief technology officer' },
        { subject: 'Helix Robotics', group: 'org_hq', expectedObject: 'Austin' },
        { subject: 'Elena Vasquez', group: 'works_at', expectedObject: 'Helix Robotics' },
      ],
    };

    const report = scoreAgainstGold(g, gold);
    expect(report.corpus).toBe('test');
    expect(report.entities.precision).toBe(1);
    expect(report.entities.recall).toBe(1);
    expect(report.entities.f1).toBe(1);
    expect(report.currentFacts.precision).toBe(1);
    expect(report.currentFacts.recall).toBe(1);
    expect(report.currentFacts.f1).toBe(1);
    expect(report.currentStateCorrectness).toBe(1);
    expect(report.expectations.every((e) => e.pass)).toBe(true);
    expect(report.predicateSprawl).toHaveLength(0);
    expect(report.missingEntities).toHaveLength(0);
    expect(report.extraEntities).toHaveLength(0);
    expect(report.missingFacts).toHaveLength(0);
    expect(report.extraFacts).toHaveLength(0);
  });

  it('matches a gold predicate to a graph sibling predicate via the exclusive group', () => {
    // gold says job_title; graph stored it as `title` — same role_title group → match.
    const elenaId = 'elena';
    const g = graph({
      entities: [entity(elenaId, 'Elena Vasquez')],
      facts: [fact({ subjectEntityId: elenaId, predicate: 'title', objectValue: 'chief technology officer' })],
    });
    const gold: GoldGraph = {
      corpus: 'test',
      entities: [{ name: 'Elena Vasquez', type: 'person' }],
      currentFacts: [{ subject: 'Elena Vasquez', predicate: 'job_title', object: 'chief technology officer' }],
      exclusiveExpectations: [
        { subject: 'Elena Vasquez', group: 'role_title', expectedObject: 'chief technology officer' },
      ],
    };
    const report = scoreAgainstGold(g, gold);
    expect(report.currentFacts.f1).toBe(1);
    expect(report.currentStateCorrectness).toBe(1);
  });
});

// ---- the 5-titles supersession failure ----------------------------------

describe('scoreAgainstGold — Elena with 5 active titles', () => {
  it('fails the role_title expectation and reports predicateSprawl>1', () => {
    const elenaId = 'elena';
    const titles: Array<[string, string]> = [
      ['job_title', 'junior software engineer'],
      ['title', 'senior engineer'],
      ['role_at', 'engineering lead'],
      ['cto_at', 'chief technology officer'],
      ['has_role', 'cto'],
    ];
    const g = graph({
      entities: [entity(elenaId, 'Elena Vasquez')],
      facts: titles.map(([pred, val]) => fact({ subjectEntityId: elenaId, predicate: pred, objectValue: val })),
    });
    const gold: GoldGraph = {
      corpus: 'test',
      entities: [{ name: 'Elena Vasquez', type: 'person' }],
      currentFacts: [{ subject: 'Elena Vasquez', predicate: 'job_title', object: 'chief technology officer' }],
      exclusiveExpectations: [
        { subject: 'Elena Vasquez', group: 'role_title', expectedObject: 'chief technology officer' },
      ],
    };

    const report = scoreAgainstGold(g, gold);
    // The single expectation FAILS: 5 distinct active objects, not exactly one.
    expect(report.currentStateCorrectness).toBe(0);
    const exp = report.expectations[0]!;
    expect(exp.pass).toBe(false);
    expect(exp.actualObjects.length).toBe(5);
    // predicate sprawl: many distinct predicates folded into one group.
    expect(report.predicateSprawl).toHaveLength(1);
    const sprawl = report.predicateSprawl[0]!;
    expect(sprawl.group).toBe('role_title');
    expect(sprawl.predicateCount).toBe(5);
  });
});

// ---- missing entity → recall < 1 ----------------------------------------

describe('scoreAgainstGold — missing entity', () => {
  it('drops entity recall below 1', () => {
    const elenaId = 'elena';
    const g = graph({ entities: [entity(elenaId, 'Elena Vasquez')] });
    const gold: GoldGraph = {
      corpus: 'test',
      entities: [
        { name: 'Elena Vasquez', type: 'person' },
        { name: 'Marcus Chen', type: 'person' }, // absent from the graph
      ],
      currentFacts: [],
      exclusiveExpectations: [],
    };
    const report = scoreAgainstGold(g, gold);
    expect(report.entities.recall).toBeLessThan(1);
    expect(report.entities.recall).toBeCloseTo(0.5, 5);
    expect(report.missingEntities).toContain('Marcus Chen');
    // empty expectations → currentStateCorrectness is vacuously 1.
    expect(report.currentStateCorrectness).toBe(1);
  });
});

// ---- extra fact → precision < 1 -----------------------------------------

describe('scoreAgainstGold — extra fact', () => {
  it('drops current-fact precision below 1', () => {
    const elenaId = 'elena';
    const helixId = 'helix';
    const g = graph({
      entities: [entity(elenaId, 'Elena Vasquez'), entity(helixId, 'Helix Robotics', 'company')],
      facts: [
        fact({ subjectEntityId: elenaId, predicate: 'works_at', objectEntityId: helixId }),
        // hallucinated extra fact with no gold counterpart
        fact({ subjectEntityId: elenaId, predicate: 'founded', objectEntityId: helixId }),
      ],
    });
    const gold: GoldGraph = {
      corpus: 'test',
      entities: [
        { name: 'Elena Vasquez', type: 'person' },
        { name: 'Helix Robotics', type: 'company' },
      ],
      currentFacts: [{ subject: 'Elena Vasquez', predicate: 'works_at', object: 'Helix Robotics' }],
      exclusiveExpectations: [],
    };
    const report = scoreAgainstGold(g, gold);
    expect(report.currentFacts.precision).toBeLessThan(1);
    expect(report.currentFacts.recall).toBe(1); // the one gold fact is present
    expect(report.extraFacts.some((f) => f.predicate === 'founded')).toBe(true);
  });
});

// ---- expired facts are not scored as current ----------------------------

describe('scoreAgainstGold — expired facts ignored', () => {
  it('a proper supersession chain (one active title) passes the expectation', () => {
    const elenaId = 'elena';
    const g = graph({
      entities: [entity(elenaId, 'Elena Vasquez')],
      facts: [
        fact({ subjectEntityId: elenaId, predicate: 'job_title', objectValue: 'senior engineer', expiredAt: new Date() }),
        fact({ subjectEntityId: elenaId, predicate: 'job_title', objectValue: 'chief technology officer' }),
      ],
    });
    const gold: GoldGraph = {
      corpus: 'test',
      entities: [{ name: 'Elena Vasquez', type: 'person' }],
      currentFacts: [{ subject: 'Elena Vasquez', predicate: 'job_title', object: 'chief technology officer' }],
      exclusiveExpectations: [
        { subject: 'Elena Vasquez', group: 'role_title', expectedObject: 'chief technology officer' },
      ],
    };
    const report = scoreAgainstGold(g, gold);
    expect(report.currentStateCorrectness).toBe(1);
    expect(report.predicateSprawl).toHaveLength(0); // only one active predicate
    expect(report.currentFacts.precision).toBe(1); // expired fact not counted as extra
  });
});
