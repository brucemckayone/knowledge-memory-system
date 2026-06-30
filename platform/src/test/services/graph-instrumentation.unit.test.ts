/**
 * Unit tests for the pure per-step instrumentation derivation (nmemo-hm4.5).
 *
 * Pure — runs under vitest.unit.config.ts (NO DB, NO globalSetup). Fixtures are
 * hand-built partial {@link RichGraph}s (cast `as RichGraph`); only the fields
 * {@link deriveInstrumentation} reads need to be present. Mirrors the doc 39
 * evidence: contradictions detected-not-reflected, a broken supersession chain,
 * dual-HQ active facts.
 */

import { describe, it, expect } from 'vitest';
import type { RichGraph } from '../../services/graph-canonical-query.js';
import {
  deriveInstrumentation,
  contradictionGap,
  type SnapshotInstrumentation,
} from '../../services/graph-instrumentation.js';

// ---- fixture builders ---------------------------------------------------

type Fact = RichGraph['facts'][number];
type Edge = RichGraph['edges'][number];
type Contradiction = RichGraph['contradictions'][number];

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

function entity(eid: string): RichGraph['entities'][number] {
  return {
    id: eid,
    name: eid,
    type: 'person',
    description: null,
    summary: null,
    mergedFrom: null,
    confidence: 0.9,
    createdAt: new Date(),
  };
}

/** A contradiction row; status driven by resolvedAt / dismissedReason. */
function contradiction(partial: Partial<Contradiction> & Pick<Contradiction, 'contradictionType'>): Contradiction {
  return {
    id: id('contra'),
    factAId: null,
    factBId: null,
    edgeAId: null,
    edgeBId: null,
    entityId: null,
    detectedAt: new Date(),
    detectedBy: 'sql_heuristic',
    detectionReasoning: 'detected',
    detectionContext: null,
    severity: 'medium',
    resolvedAt: null,
    resolvedBy: null,
    resolutionType: null,
    resolutionReasoning: null,
    resolutionReportId: null,
    dismissedReason: null,
    preResolveBlastRadius: null,
    ...partial,
  } as Contradiction;
}

function sameAs(): RichGraph['sameAs'][number] {
  return { id: id('same'), entityAId: id('e'), entityBId: id('e'), reasoning: 'r', confidence: 0.9, createdBy: 'gardener', createdAt: new Date() };
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

// ---- contradictions: byType + status split ------------------------------

describe('deriveInstrumentation — contradictions', () => {
  it('splits by detection type and partitions into resolved / dismissed / active', () => {
    const g = graph({
      contradictions: [
        contradiction({ contradictionType: 'opposing_object' }), // active
        contradiction({ contradictionType: 'opposing_object', resolvedAt: new Date() }), // resolved
        contradiction({ contradictionType: 'temporal_impossible', dismissedReason: 'false positive' }), // dismissed
        contradiction({ contradictionType: 'temporal_impossible' }), // active
      ],
    });

    const r = deriveInstrumentation(g).contradictions;
    expect(r.total).toBe(4);
    expect(r.byType).toEqual({ opposing_object: 2, temporal_impossible: 2 });
    expect(r.resolved).toBe(1);
    expect(r.dismissed).toBe(1);
    expect(r.active).toBe(2);
    // the three status buckets partition the total exactly
    expect(r.resolved + r.dismissed + r.active).toBe(r.total);
  });

  it('counts a resolved+dismissed row as resolved (resolved wins over dismissed)', () => {
    const g = graph({
      contradictions: [contradiction({ contradictionType: 'opposing_object', resolvedAt: new Date(), dismissedReason: 'also dismissed' })],
    });
    const r = deriveInstrumentation(g).contradictions;
    expect(r.resolved).toBe(1);
    expect(r.dismissed).toBe(0);
    expect(r.active).toBe(0);
  });

  it('zeroes cleanly on an empty contradictions table', () => {
    const r = deriveInstrumentation(graph({})).contradictions;
    expect(r).toEqual({ total: 0, byType: {}, resolved: 0, dismissed: 0, active: 0 });
  });
});

// ---- supersession: expired vs active + byExpireReason -------------------

describe('deriveInstrumentation — supersession', () => {
  it('counts expired vs active facts and buckets expired by reason', () => {
    const g = graph({
      facts: [
        fact({ subjectEntityId: 'helix', predicate: 'headquartered_in', objectValue: 'boston', expiredAt: new Date(), expireReason: 'superseded' }),
        fact({ subjectEntityId: 'elena', predicate: 'job_title', objectValue: 'junior engineer', expiredAt: new Date(), expireReason: 'superseded' }),
        fact({ subjectEntityId: 'elena', predicate: 'job_title', objectValue: 'cto', expiredAt: new Date(), expireReason: 'contradiction' }),
        fact({ subjectEntityId: 'helix', predicate: 'headquartered_in', objectValue: 'austin' }), // active
        fact({ subjectEntityId: 'elena', predicate: 'title', objectValue: 'cto' }), // active
      ],
    });

    const r = deriveInstrumentation(g).supersession;
    expect(r.expiredFacts).toBe(3);
    expect(r.activeFacts).toBe(2);
    expect(r.byExpireReason).toEqual({ superseded: 2, contradiction: 1 });
  });

  it('folds a null expire_reason under "unknown"', () => {
    const g = graph({
      facts: [
        fact({ subjectEntityId: 'p1', predicate: 'job_title', expiredAt: new Date(), expireReason: null }),
        fact({ subjectEntityId: 'p1', predicate: 'job_title' }),
      ],
    });
    const r = deriveInstrumentation(g).supersession;
    expect(r.expiredFacts).toBe(1);
    expect(r.activeFacts).toBe(1);
    expect(r.byExpireReason).toEqual({ unknown: 1 });
  });
});

// ---- causal edges: active vs expired ------------------------------------

describe('deriveInstrumentation — causalEdges', () => {
  it('splits edges into active vs expired', () => {
    const g = graph({
      edges: [
        edge({ causeEventId: 'c1', effectEventId: 'e1' }),
        edge({ causeEventId: 'c2', effectEventId: 'e2' }),
        edge({ causeEventId: 'c3', effectEventId: 'e3', expiredAt: new Date(), expireReason: 'retracted' }),
      ],
    });
    const r = deriveInstrumentation(g).causalEdges;
    expect(r.total).toBe(3);
    expect(r.active).toBe(2);
    expect(r.expired).toBe(1);
  });

  it('zeroes on no edges', () => {
    expect(deriveInstrumentation(graph({})).causalEdges).toEqual({ total: 0, active: 0, expired: 0 });
  });
});

// ---- sameAs / entities / facts totals -----------------------------------

describe('deriveInstrumentation — top-level totals', () => {
  it('reports sameAs, entities, and facts totals', () => {
    const g = graph({
      entities: [entity('e1'), entity('e2'), entity('e3')],
      facts: [
        fact({ subjectEntityId: 'e1', predicate: 'knows', objectEntityId: 'e2' }),
        fact({ subjectEntityId: 'e2', predicate: 'works_at', objectValue: 'helix', expiredAt: new Date() }),
      ],
      sameAs: [sameAs(), sameAs()],
    });
    const r = deriveInstrumentation(g);
    expect(r.sameAs).toBe(2);
    expect(r.entities).toBe(3);
    expect(r.facts).toBe(2); // facts is the FULL count (active + expired)
    // and facts total reconciles with the supersession split
    expect(r.supersession.activeFacts + r.supersession.expiredFacts).toBe(r.facts);
  });
});

// ---- contradictionGap: detected-during-ingest vs reflected-in-table ------

describe('contradictionGap', () => {
  /** Snapshot with exactly `total` contradictions (the only field the gap reads). */
  const snapWithTotal = (total: number): SnapshotInstrumentation =>
    deriveInstrumentation(
      graph({
        contradictions: Array.from({ length: total }, () =>
          contradiction({ contradictionType: 'opposing_object' }),
        ),
      }),
    );

  it('exposes the detected-not-reflected gap (12 detected, empty final table → gap 12)', () => {
    const r = contradictionGap(12, snapWithTotal(0));
    expect(r).toEqual({ detectedDuringIngest: 12, reflectedInFinalTable: 0, gap: 12 });
  });

  it('reports zero gap when every detected contradiction is reflected (3 / 3 → gap 0)', () => {
    const r = contradictionGap(3, snapWithTotal(3));
    expect(r).toEqual({ detectedDuringIngest: 3, reflectedInFinalTable: 3, gap: 0 });
  });

  it('reads reflected from snapshot.contradictions.total, not active/resolved', () => {
    // A table of resolved/dismissed rows still counts toward `total`, so the gap
    // is detected − total (not detected − active).
    const snap = deriveInstrumentation(
      graph({
        contradictions: [
          contradiction({ contradictionType: 'opposing_object', resolvedAt: new Date() }),
          contradiction({ contradictionType: 'temporal_impossible', dismissedReason: 'fp' }),
        ],
      }),
    );
    expect(snap.contradictions.active).toBe(0); // all resolved/dismissed
    expect(contradictionGap(5, snap)).toEqual({
      detectedDuringIngest: 5,
      reflectedInFinalTable: 2,
      gap: 3,
    });
  });

  it('goes negative when the table holds more than were detected this run', () => {
    // detected=0 (sweep did not fire this chunk) but the table already has rows
    // from earlier chunks → gap is -total, surfacing the asymmetry.
    expect(contradictionGap(0, snapWithTotal(4))).toEqual({
      detectedDuringIngest: 0,
      reflectedInFinalTable: 4,
      gap: -4,
    });
  });
});
