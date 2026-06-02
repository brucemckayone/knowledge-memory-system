/**
 * Unit tests for the deterministic graph-integrity invariants (nmemo-hm4.3).
 *
 * Pure — runs under vitest.unit.config.ts (NO DB, NO globalSetup). Fixtures are
 * hand-built partial {@link RichGraph}s (cast `as RichGraph`); only the fields a
 * given invariant reads need to be present. The headline assertions encode the
 * supersession-gap bug: Elena's 5 coexisting titles and Helix's two HQs.
 */

import { describe, it, expect } from 'vitest';
import type { RichGraph } from '../../services/graph-canonical-query.js';
import {
  runInvariants,
  resolveExclusiveGroup,
  singleActivePerExclusiveGroup,
  causalJustification,
  referentialIntegrity,
  objectValueNotSentence,
  orphanEntities,
} from '../../services/graph-invariants.js';

// ---- fixture builders ---------------------------------------------------

type Fact = RichGraph['facts'][number];
type Edge = RichGraph['edges'][number];
type CEvent = RichGraph['events'][number];

let seq = 0;
const id = (p: string): string => `${p}-${(seq += 1).toString().padStart(4, '0')}`;

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

function event(partial: Partial<CEvent> = {}): CEvent {
  return {
    id: id('event'),
    factId: null,
    transitionType: 'created',
    subjectEntityId: null,
    predicate: null,
    deltaConfidence: null,
    occurredAt: new Date(),
    sourceMemoryId: null,
    createdAt: new Date(),
    ...partial,
  } as CEvent;
}

function edge(partial: Partial<Edge> & Pick<Edge, 'causeEventId' | 'effectEventId'>): Edge {
  return {
    id: id('edge'),
    strength: 0.8,
    extractionMethod: 'llm',
    reasoning: 'because the cause led to the effect',
    sourceReferences: [{ memoryId: 'm1' }],
    corroborationCount: 1,
    createdAt: new Date(),
    expiredAt: null,
    expireReason: null,
    ...partial,
  } as Edge;
}

function entity(eid: string, name = eid): RichGraph['entities'][number] {
  return {
    id: eid,
    name,
    type: 'person',
    description: null,
    summary: null,
    mergedFrom: null,
    confidence: 0.9,
    createdAt: new Date(),
  };
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

// ---- resolveExclusiveGroup ----------------------------------------------

describe('resolveExclusiveGroup', () => {
  it('folds title/role predicates into the role_title augmentation group', () => {
    for (const p of ['job_title', 'title', 'role_at', 'cto_at', 'ceo_of', 'works_as']) {
      expect(resolveExclusiveGroup(p)).toBe('role_title');
    }
  });

  it('folds HQ predicates into the org_hq augmentation group', () => {
    for (const p of ['headquartered_in', 'headquarters', 'hq', 'head_office_in']) {
      expect(resolveExclusiveGroup(p)).toBe('org_hq');
    }
  });

  it('returns the canonical predicate for an ontology-exclusive predicate', () => {
    expect(resolveExclusiveGroup('works_at')).toBe('works_at');
    expect(resolveExclusiveGroup('lives_in')).toBe('lives_in');
    // alias normalises to its canonical exclusive form
    expect(resolveExclusiveGroup('spouse_of')).toBe('married_to');
  });

  it('returns null for non-exclusive predicates', () => {
    expect(resolveExclusiveGroup('knows')).toBeNull();
    expect(resolveExclusiveGroup('friend_of')).toBeNull();
    expect(resolveExclusiveGroup('totally_made_up_predicate')).toBeNull();
  });
});

// ---- singleActivePerExclusiveGroup --------------------------------------

describe('singleActivePerExclusiveGroup', () => {
  it('FAILS on Elena holding 5 active title facts across the role_title group', () => {
    const elena = 'elena';
    const titles: Array<[string, string]> = [
      ['job_title', 'CTO'],
      ['title', 'Chief Technology Officer'],
      ['role_at', 'VP Engineering'],
      ['cto_at', 'Helix'],
      ['ceo_of', 'NovaLabs'],
    ];
    const facts = titles.map(([pred, val]) => fact({ subjectEntityId: elena, predicate: pred, objectValue: val }));
    const g = graph({ entities: [entity(elena, 'Elena Vasquez')], facts });

    const res = singleActivePerExclusiveGroup(g);
    expect(res.pass).toBe(false);
    expect(res.severity).toBe('error');
    expect(res.violations).toHaveLength(1);
    const v = res.violations[0]!;
    expect(v.subjectId).toBe(elena);
    expect(v.detail).toContain('role_title');
    // the violation lists ALL five offending fact ids
    expect(v.factIds).toHaveLength(5);
    expect(new Set(v.factIds)).toEqual(new Set(facts.map((f) => f.id)));
  });

  it('FAILS on Helix headquartered_in both boston and austin', () => {
    const helix = 'helix';
    const boston = fact({ subjectEntityId: helix, predicate: 'headquartered_in', objectValue: 'boston' });
    const austin = fact({ subjectEntityId: helix, predicate: 'headquartered_in', objectValue: 'austin' });
    const g = graph({ entities: [entity(helix, 'Helix')], facts: [boston, austin] });

    const res = singleActivePerExclusiveGroup(g);
    expect(res.pass).toBe(false);
    expect(res.violations).toHaveLength(1);
    const v = res.violations[0]!;
    expect(v.detail).toContain('org_hq');
    expect(new Set(v.factIds)).toEqual(new Set([boston.id, austin.id]));
    expect(v.detail).toMatch(/boston/);
    expect(v.detail).toMatch(/austin/);
  });

  it('passes when a single subject has one active fact per exclusive group', () => {
    const g = graph({
      facts: [
        fact({ subjectEntityId: 'p1', predicate: 'job_title', objectValue: 'CTO' }),
        fact({ subjectEntityId: 'p1', predicate: 'works_at', objectValue: 'Helix' }),
        fact({ subjectEntityId: 'p1', predicate: 'lives_in', objectValue: 'boston' }),
      ],
    });
    expect(singleActivePerExclusiveGroup(g).pass).toBe(true);
  });

  it('does not flag repeated identical objects (same object value) within a group', () => {
    // two active facts, same subject + same object -> one distinct object -> no conflict
    const g = graph({
      facts: [
        fact({ subjectEntityId: 'p1', predicate: 'job_title', objectValue: 'CTO' }),
        fact({ subjectEntityId: 'p1', predicate: 'title', objectValue: 'CTO' }),
      ],
    });
    expect(singleActivePerExclusiveGroup(g).pass).toBe(true);
  });

  it('ignores EXPIRED facts (a proper supersession chain passes)', () => {
    const helix = 'helix';
    const g = graph({
      facts: [
        fact({ subjectEntityId: helix, predicate: 'headquartered_in', objectValue: 'boston', expiredAt: new Date() }),
        fact({ subjectEntityId: helix, predicate: 'headquartered_in', objectValue: 'austin' }),
      ],
    });
    expect(singleActivePerExclusiveGroup(g).pass).toBe(true);
  });

  it('does not flag non-exclusive predicates with multiple objects', () => {
    const g = graph({
      facts: [
        fact({ subjectEntityId: 'p1', predicate: 'knows', objectEntityId: 'p2' }),
        fact({ subjectEntityId: 'p1', predicate: 'knows', objectEntityId: 'p3' }),
      ],
    });
    expect(singleActivePerExclusiveGroup(g).pass).toBe(true);
  });
});

// ---- causalJustification ------------------------------------------------

describe('causalJustification', () => {
  it('passes on a well-formed edge with reasoning + source references', () => {
    const c = event();
    const ef = event();
    const g = graph({ events: [c, ef], edges: [edge({ causeEventId: c.id, effectEventId: ef.id })] });
    expect(causalJustification(g).pass).toBe(true);
  });

  it('FAILS on an empty-reasoning edge', () => {
    const c = event();
    const ef = event();
    const g = graph({ events: [c, ef], edges: [edge({ causeEventId: c.id, effectEventId: ef.id, reasoning: '   ' })] });
    const res = causalJustification(g);
    expect(res.pass).toBe(false);
    expect(res.violations.some((v) => v.kind === 'missing_reasoning')).toBe(true);
  });

  it('FAILS on an edge with empty source references (array and object forms)', () => {
    const c = event();
    const ef = event();
    const gArr = graph({ events: [c, ef], edges: [edge({ causeEventId: c.id, effectEventId: ef.id, sourceReferences: [] })] });
    const gObj = graph({ events: [c, ef], edges: [edge({ causeEventId: c.id, effectEventId: ef.id, sourceReferences: {} })] });
    expect(causalJustification(gArr).violations.some((v) => v.kind === 'missing_source_references')).toBe(true);
    expect(causalJustification(gObj).violations.some((v) => v.kind === 'missing_source_references')).toBe(true);
  });

  it('FAILS on a self-loop edge (same cause and effect event)', () => {
    const e = event();
    const g = graph({ events: [e], edges: [edge({ causeEventId: e.id, effectEventId: e.id })] });
    const res = causalJustification(g);
    expect(res.pass).toBe(false);
    expect(res.violations.some((v) => v.kind === 'self_loop')).toBe(true);
  });

  it('FAILS on two distinct events that resolve to the same fact (fact-space self-loop)', () => {
    const sharedFact = id('fact');
    const c = event({ factId: sharedFact });
    const ef = event({ factId: sharedFact });
    const g = graph({ events: [c, ef], edges: [edge({ causeEventId: c.id, effectEventId: ef.id })] });
    const res = causalJustification(g);
    expect(res.pass).toBe(false);
    expect(res.violations.some((v) => v.kind === 'self_loop_fact')).toBe(true);
  });
});

// ---- referentialIntegrity -----------------------------------------------

describe('referentialIntegrity', () => {
  it('passes when every reference resolves', () => {
    const e1 = entity('e1');
    const e2 = entity('e2');
    const f = fact({ subjectEntityId: 'e1', objectEntityId: 'e2', predicate: 'knows' });
    const ev = event({ factId: f.id, subjectEntityId: 'e1' });
    const ev2 = event({ subjectEntityId: 'e2' });
    const ed = edge({ causeEventId: ev.id, effectEventId: ev2.id });
    const g = graph({ entities: [e1, e2], facts: [f], events: [ev, ev2], edges: [ed] });
    expect(referentialIntegrity(g).pass).toBe(true);
  });

  it('FAILS on a dangling fact.subjectEntityId', () => {
    const g = graph({
      entities: [entity('e1')],
      facts: [fact({ subjectEntityId: 'ghost', predicate: 'knows' })],
    });
    const res = referentialIntegrity(g);
    expect(res.pass).toBe(false);
    expect(res.violations.some((v) => v.kind === 'dangling_fact_subject')).toBe(true);
  });

  it('FAILS on a dangling edge cause/effect event id', () => {
    const g = graph({ edges: [edge({ causeEventId: 'nope-cause', effectEventId: 'nope-effect' })] });
    const res = referentialIntegrity(g);
    expect(res.violations.some((v) => v.kind === 'dangling_edge_cause')).toBe(true);
    expect(res.violations.some((v) => v.kind === 'dangling_edge_effect')).toBe(true);
  });

  it('FAILS on a dangling event.factId and a dangling same_as entity', () => {
    const g = graph({
      entities: [entity('e1')],
      events: [event({ factId: 'ghost-fact' })],
      sameAs: [{ id: id('same'), entityAId: 'e1', entityBId: 'ghost-ent', reasoning: 'r', confidence: 0.9, createdBy: 'gardener', createdAt: new Date() }],
    });
    const res = referentialIntegrity(g);
    expect(res.violations.some((v) => v.kind === 'dangling_event_fact')).toBe(true);
    expect(res.violations.some((v) => v.kind === 'dangling_sameas_b')).toBe(true);
  });
});

// ---- objectValueNotSentence ---------------------------------------------

describe('objectValueNotSentence', () => {
  it('passes on short value-like object_values', () => {
    const g = graph({
      facts: [
        fact({ subjectEntityId: 'p1', predicate: 'job_title', objectValue: 'CTO' }),
        fact({ subjectEntityId: 'p1', predicate: 'lives_in', objectValue: 'Boston, MA' }),
      ],
    });
    expect(objectValueNotSentence(g).pass).toBe(true);
  });

  it('FLAGS a long sentence-like object_value (>64 chars / >12 words)', () => {
    const sentence = 'Elena joined the company as the chief technology officer after leaving her prior role last spring';
    const g = graph({ facts: [fact({ subjectEntityId: 'p1', predicate: 'note', objectValue: sentence })] });
    const res = objectValueNotSentence(g);
    expect(res.pass).toBe(false);
    expect(res.severity).toBe('warning');
    expect(res.violations[0]!.kind).toBe('object_value_sentence');
    expect(res.violations[0]!.factIds).toHaveLength(1);
  });

  it('ignores facts whose object is an entity (objectEntityId set)', () => {
    const long = 'this is a very long object value that exceeds the sixty four character threshold easily';
    const g = graph({ facts: [fact({ subjectEntityId: 'p1', predicate: 'knows', objectEntityId: 'p2', objectValue: long })] });
    expect(objectValueNotSentence(g).pass).toBe(true);
  });
});

// ---- orphanEntities -----------------------------------------------------

describe('orphanEntities', () => {
  it('flags entities referenced by no active fact (info severity)', () => {
    const g = graph({
      entities: [entity('used'), entity('orphan')],
      facts: [fact({ subjectEntityId: 'used', objectEntityId: null, predicate: 'job_title', objectValue: 'CTO' })],
    });
    const res = orphanEntities(g);
    expect(res.severity).toBe('info');
    expect(res.pass).toBe(false);
    expect(res.violations).toHaveLength(1);
    expect(res.violations[0]!.entityIds).toEqual(['orphan']);
  });

  it('treats entities referenced only by EXPIRED facts as orphans', () => {
    const g = graph({
      entities: [entity('e1')],
      facts: [fact({ subjectEntityId: 'e1', predicate: 'job_title', objectValue: 'CTO', expiredAt: new Date() })],
    });
    expect(orphanEntities(g).pass).toBe(false);
  });
});

// ---- runInvariants (aggregate) ------------------------------------------

describe('runInvariants', () => {
  it('a clean graph passes ALL error-severity invariants', () => {
    const e1 = entity('e1');
    const e2 = entity('e2');
    const f = fact({ subjectEntityId: 'e1', objectEntityId: 'e2', predicate: 'works_at' });
    const c = event({ factId: f.id, subjectEntityId: 'e1' });
    const ef = event({ subjectEntityId: 'e2' });
    const ed = edge({ causeEventId: c.id, effectEventId: ef.id });
    const g = graph({ entities: [e1, e2], facts: [f], events: [c, ef], edges: [ed] });

    const report = runInvariants(g);
    const errors = report.results.filter((r) => r.severity === 'error');
    expect(errors.every((r) => r.pass)).toBe(true);
    expect(report.summary.errorViolations).toBe(0);
    expect(report.summary.total).toBe(5);
  });

  it('summary tallies passed/failed and counts only error-severity violations', () => {
    const helix = 'helix';
    // Two HQ conflict (1 error violation) + an orphan entity (info, not counted in errorViolations)
    const g = graph({
      entities: [entity(helix), entity('lonely')],
      facts: [
        fact({ subjectEntityId: helix, predicate: 'headquartered_in', objectValue: 'boston' }),
        fact({ subjectEntityId: helix, predicate: 'headquartered_in', objectValue: 'austin' }),
      ],
    });
    const report = runInvariants(g);
    expect(report.summary.total).toBe(5);
    // singleActivePerExclusiveGroup fails (error) + orphanEntities fails (info)
    expect(report.summary.failed).toBeGreaterThanOrEqual(2);
    // only the one exclusive-group conflict counts toward errorViolations
    expect(report.summary.errorViolations).toBe(1);
    expect(report.summary.passed).toBe(report.summary.total - report.summary.failed);
  });
});
