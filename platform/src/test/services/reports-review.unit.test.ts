/**
 * Unit tests for the reports review — agent self-report vs graph (nmemo-hm4.8).
 *
 * Pure — runs under vitest.unit.config.ts (NO DB, NO globalSetup). Fixtures are
 * hand-built partial {@link RichGraph}s (cast `as RichGraph`); only the fields
 * the review reads need to be present. The headline assertions encode the doc 39
 * §2.E checks: a reasoning report citing a fact the graph lacks (dangling
 * reference), a gardening report claiming more merges/same_as than the graph
 * holds (over-claim), and the thin/patrol-only reasoning-report characterization.
 */

import { describe, it, expect } from 'vitest';
import type { RichGraph } from '../../services/graph-canonical-query.js';
import { reviewReports } from '../../services/reports-review.js';

// ---- fixture builders ---------------------------------------------------

type Reasoning = RichGraph['reports']['reasoning'][number];
type Gardening = RichGraph['reports']['gardening'][number];

let seq = 0;
const id = (p: string): string => `${p}-${(seq += 1).toString().padStart(4, '0')}`;

function entity(eid: string, mergedFrom: string[] | null = null): RichGraph['entities'][number] {
  return { id: eid, name: eid, type: 'person', description: null, summary: null, mergedFrom, confidence: 0.9, createdAt: new Date() };
}

function fact(fid: string): RichGraph['facts'][number] {
  return {
    id: fid, subjectEntityId: 'e1', predicate: 'p', objectEntityId: null, objectValue: 'v',
    confidence: 0.9, validAt: null, invalidAt: null, createdAt: new Date(),
    expiredAt: null, expireReason: null, sourceMemoryId: null,
  };
}

function reasoning(partial: Partial<Reasoning> = {}): Reasoning {
  return {
    id: id('reason'),
    mode: 'patrol',
    question: null,
    report: 'looked at the graph and acted',
    actionsTaken: {},
    entityIds: [],
    factIds: [],
    causalEdgeIds: [],
    invocationId: null,
    createdAt: new Date(),
    ...partial,
  } as Reasoning;
}

function gardening(partial: Partial<Gardening> = {}): Gardening {
  return {
    id: id('garden'),
    triggerType: 'manual',
    runsSinceLast: 0,
    actions: [],
    sameAsCreated: 0,
    mergesExecuted: 0,
    factsCreated: 0,
    summariesUpdated: 0,
    totalEntities: null,
    totalComponents: null,
    islandsInvestigated: 0,
    reportText: 'gardening pass',
    durationMs: null,
    createdAt: new Date(),
    ...partial,
  } as Gardening;
}

/** Assemble a RichGraph from parts; unspecified collections default to empty. */
function graph(parts: {
  entities?: RichGraph['entities'];
  facts?: RichGraph['facts'];
  edges?: RichGraph['edges'];
  sameAs?: RichGraph['sameAs'];
  reports?: Partial<RichGraph['reports']>;
}): RichGraph {
  return {
    entities: parts.entities ?? [],
    facts: parts.facts ?? [],
    events: [],
    edges: parts.edges ?? [],
    sameAs: parts.sameAs ?? [],
    contradictions: [],
    reports: {
      extraction: parts.reports?.extraction ?? [],
      gardening: parts.reports?.gardening ?? [],
      reasoning: parts.reports?.reasoning ?? [],
    },
    counts: {} as RichGraph['counts'],
  } as RichGraph;
}

// ---- tests --------------------------------------------------------------

describe('reviewReports — self-report vs graph cross-checks', () => {
  it('surfaces a dangling_reference when a reasoning report cites a fact absent from the graph', () => {
    const missing = id('ghost-fact');
    const g = graph({
      facts: [fact('present-fact')],
      reports: {
        reasoning: [reasoning({ factIds: [missing], report: 'cited a fact' })],
      },
    });

    const { discrepancies } = reviewReports(g);
    const dangling = discrepancies.filter((d) => d.kind === 'dangling_reference');
    expect(dangling).toHaveLength(1);
    expect(dangling[0]!.reportType).toBe('reasoning');
    // The detail names the missing id (and its type).
    expect(dangling[0]!.detail).toContain(missing);
    expect(dangling[0]!.detail).toContain('fact');
  });

  it('does not flag a reasoning reference that IS present in the graph', () => {
    const g = graph({
      entities: [entity('e1')],
      facts: [fact('f1')],
      reports: { reasoning: [reasoning({ entityIds: ['e1'], factIds: ['f1'] })] },
    });
    expect(reviewReports(g).discrepancies).toHaveLength(0);
  });

  it('surfaces a sameas_overclaim and a merge_overclaim from a gardening report', () => {
    const g = graph({
      // No same_as links and no entity carries a merged-from lineage.
      entities: [entity('e1'), entity('e2')],
      sameAs: [],
      reports: { gardening: [gardening({ sameAsCreated: 3, mergesExecuted: 2 })] },
    });

    const { discrepancies } = reviewReports(g);
    const sameAs = discrepancies.filter((d) => d.kind === 'sameas_overclaim');
    const merge = discrepancies.filter((d) => d.kind === 'merge_overclaim');
    expect(sameAs).toHaveLength(1);
    expect(merge).toHaveLength(1);
    expect(sameAs[0]!.reportType).toBe('gardening');
    expect(sameAs[0]!.detail).toContain('3');
    expect(merge[0]!.detail).toContain('2');
  });

  it('does not over-claim when merges are backed by merged-from lineage', () => {
    const g = graph({
      // One entity folded another in (mergedFrom non-empty) → 1 merge is honest.
      entities: [entity('survivor', ['folded']), entity('other')],
      reports: { gardening: [gardening({ mergesExecuted: 1 })] },
    });
    expect(reviewReports(g).discrepancies.filter((d) => d.kind === 'merge_overclaim')).toHaveLength(0);
  });
});

describe('reviewReports — characterization', () => {
  it('counts a patrol-only thin reasoning report and tallies modes', () => {
    const g = graph({
      reports: {
        extraction: [{ id: id('extract'), memoryId: id('mem'), reportText: 'x', createdAt: new Date() }],
        gardening: [gardening({ actions: [{ a: 1 }, { a: 2 }] })],
        reasoning: [
          // Thin: patrol, empty actions + empty id arrays (but non-empty text).
          reasoning({ mode: 'patrol', actionsTaken: {}, entityIds: [], factIds: [], causalEdgeIds: [] }),
          // Substantive: a query pass that touched a fact.
          reasoning({ mode: 'query', factIds: ['f1'], report: 'answered' }),
        ],
      },
    });

    const { characterization: c } = reviewReports(g);
    expect(c.extractionCount).toBe(1);
    expect(c.gardeningCount).toBe(1);
    expect(c.reasoningCount).toBe(2);
    expect(c.reasoningByMode).toEqual({ patrol: 1, query: 1 });
    expect(c.thinReasoningReports).toBe(1);
    expect(c.gardeningActionsTotal).toBe(2);
  });

  it('treats an empty-text reasoning report as thin even when it claims rows', () => {
    const g = graph({
      reports: { reasoning: [reasoning({ mode: 'patrol', report: '   ', entityIds: ['e1'] })] },
    });
    expect(reviewReports(g).characterization.thinReasoningReports).toBe(1);
  });
});

describe('reviewReports — clean graph', () => {
  it('returns zero discrepancies when all references resolve and no over-claims', () => {
    const g = graph({
      entities: [entity('e1'), entity('survivor', ['folded'])],
      facts: [fact('f1')],
      edges: [
        {
          id: 'c1', causeEventId: 'ev1', effectEventId: 'ev2', strength: 0.8, extractionMethod: 'llm',
          reasoning: 'r', sourceReferences: [], corroborationCount: 1, createdAt: new Date(),
          expiredAt: null, expireReason: null,
        },
      ],
      sameAs: [
        { id: 's1', entityAId: 'e1', entityBId: 'survivor', reasoning: 'r', confidence: 0.9, createdBy: 'gardener', createdAt: new Date() },
      ],
      reports: {
        reasoning: [reasoning({ entityIds: ['e1'], factIds: ['f1'], causalEdgeIds: ['c1'], actionsTaken: { merged: 1 } })],
        gardening: [gardening({ sameAsCreated: 1, mergesExecuted: 1 })],
      },
    });
    expect(reviewReports(g).discrepancies).toHaveLength(0);
  });
});
