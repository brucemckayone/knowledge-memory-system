/**
 * Unit tests for the run-comparison scorecard (doc 38 §7). Pure — no infra.
 */

import { describe, it, expect } from 'vitest';
import { buildCanonicalGraph, buildScorecard, type RawGraphRows, type ArmRun } from '../../services/graph-canonical.js';

// Minimal graphs: one entity + (optionally) one duplicate / extra fact.
function graph(opts: { dupEntity?: boolean; extraFact?: boolean } = {}) {
  const raw: RawGraphRows = {
    entities: [{ id: 'e1', name: 'Victor', type: 'person' }],
    facts: [{ id: 'f1', subj: 'e1', pred: 'born_in', objId: null, objVal: 'Geneva', conf: 1 }],
    events: [],
    edges: [],
    sameAs: [],
  };
  if (opts.dupEntity) raw.entities.push({ id: 'e2', name: 'victor', type: 'PERSON' });
  if (opts.extraFact) raw.facts.push({ id: 'f2', subj: 'e1', pred: 'created', objId: null, objVal: 'the creature', conf: 1 });
  return buildCanonicalGraph(raw);
}

describe('buildScorecard', () => {
  it('marks the baseline with null vsBaseline and reports throughput', () => {
    const runs: ArmRun[] = [{ mode: 'serial', graph: graph(), wallClockMs: 9000 }];
    const sc = buildScorecard(runs);
    expect(sc.baselineMode).toBe('serial');
    expect(sc.arms[0]!.vsBaseline).toBeNull();
    expect(sc.arms[0]!.wallClockMs).toBe(9000);
  });

  it('passes litmus when forward and reverse graphs match structurally', () => {
    const sc = buildScorecard([{ mode: 'epoch', graph: graph(), reverseGraph: graph(), wallClockMs: 100 }], 'serial');
    expect(sc.arms[0]!.litmusPass).toBe(true);
  });

  it('fails litmus when forward and reverse diverge', () => {
    const sc = buildScorecard([{ mode: 'epoch', graph: graph(), reverseGraph: graph({ extraFact: true }), wallClockMs: 100 }], 'serial');
    expect(sc.arms[0]!.litmusPass).toBe(false);
  });

  it('diffs an arm against the baseline (extra fact + structural mismatch)', () => {
    const runs: ArmRun[] = [
      { mode: 'serial', graph: graph(), wallClockMs: 9000 },
      { mode: 'epoch', graph: graph({ extraFact: true }), wallClockMs: 1200 },
    ];
    const sc = buildScorecard(runs);
    const epoch = sc.arms.find((a) => a.mode === 'epoch')!;
    expect(epoch.vsBaseline!.structuralMatch).toBe(false);
    expect(epoch.vsBaseline!.factsExtra).toBe(1);
    expect(epoch.vsBaseline!.factsMissing).toBe(0);
  });

  it('counts duplicate entities (explosion signal)', () => {
    const sc = buildScorecard([{ mode: 'optimistic', graph: graph({ dupEntity: true }), wallClockMs: 800 }], 'serial');
    expect(sc.arms[0]!.duplicateEntities).toBe(1);
  });
});
