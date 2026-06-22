/**
 * Unit tests for the human-readable report + trend (doc 39 §3.3/§3.4, nmemo-hm4.6).
 *
 * Pure — synthetic Manifest + RunMetrics + HistoryLines, no DB / fs / network.
 * Proves buildRunReport renders the scorecards, gold correctness, every invariant
 * verdict WITH its offending rows (Elena's 5 titles), the contradiction
 * detected-vs-reflected gap, and the snapshot links; and that buildTrend gives a
 * first-run message with no prior and a `->` delta (incl. current-state-correctness)
 * against a prior line.
 */

import { describe, it, expect } from 'vitest';
import { buildRunReport, buildTrend } from '../../services/benchmark-report.js';
import type { Manifest, RunMetrics, HistoryLine, ArmHistory } from '../../services/benchmark-snapshot.js';
import type { Scorecard } from '../../services/graph-canonical.js';
import type { InvariantReport } from '../../services/graph-invariants.js';
import type { CorrectnessReport } from '../../services/graph-correctness.js';

const COUNTS = {
  entities: 6,
  distinctEntities: 6,
  activeFacts: 12,
  distinctFacts: 12,
  events: 4,
  activeEdges: 3,
  sameAs: 1,
};

function manifest(): Manifest {
  return {
    runId: 'run-2026',
    timestamp: '2026-06-02T00:00:00.000Z',
    gitCommit: 'abc1234',
    corpus: 'corpus10.json',
    chunkCount: 10,
    modes: ['serial', 'optimistic'],
    orders: ['forward', 'reverse'],
    concurrency: { optimistic: '6' },
    model: 'pi',
    richSchemaVersion: 1,
  };
}

function scorecard(): Scorecard {
  return {
    baselineMode: 'serial',
    arms: [
      { mode: 'serial', wallClockMs: 5000, counts: COUNTS, duplicateEntities: 0, duplicateFacts: 0, litmusPass: true, vsBaseline: null },
      {
        mode: 'optimistic',
        wallClockMs: 1800,
        counts: COUNTS,
        duplicateEntities: 0,
        duplicateFacts: 0,
        litmusPass: false,
        vsBaseline: { structuralMatch: false, entitiesExtra: 1, entitiesMissing: 0, factsExtra: 2, factsMissing: 1 },
      },
    ],
  };
}

/** A FAILED singleActivePerExclusiveGroup whose detail names Elena's 5 titles. */
function invariantReport(): InvariantReport {
  return {
    results: [
      {
        name: 'singleActivePerExclusiveGroup',
        description: 'At most one active fact per (subject, exclusive predicate group); supersession should expire the rest.',
        severity: 'error',
        pass: false,
        violations: [
          {
            kind: 'exclusive_group_conflict',
            subjectId: 'elena-id',
            factIds: ['f1', 'f2', 'f3', 'f4', 'f5'],
            detail: "Elena: 5 active title facts in group role_title, expected 1",
          },
        ],
      },
      {
        name: 'referentialIntegrity',
        description: 'All fact/event/edge/contradiction/same_as foreign keys resolve to existing rows.',
        severity: 'error',
        pass: true,
        violations: [],
      },
    ],
    summary: { total: 2, passed: 1, failed: 1, errorViolations: 1 },
  };
}

function correctnessReport(): CorrectnessReport {
  return {
    corpus: 'corpus10.json',
    entities: { precision: 0.9, recall: 0.85, f1: 0.87 },
    currentFacts: { precision: 0.6, recall: 0.5, f1: 0.55 },
    currentStateCorrectness: 0.25,
    expectations: [
      { subject: 'Elena Vasquez', group: 'role_title', expectedObject: 'chief technology officer', actualObjects: ['junior software engineer', 'senior engineer', 'cto'], pass: false },
      { subject: 'Helix', group: 'org_hq', expectedObject: 'austin', actualObjects: ['austin'], pass: true },
    ],
    predicateSprawl: [{ subject: 'elena vasquez', group: 'role_title', predicateCount: 4, predicates: ['job_title', 'title', 'role_at', 'cto_at'] }],
    missingEntities: [],
    extraEntities: ['Mystery Corp'],
    missingFacts: [],
    extraFacts: [],
  };
}

function metrics(): RunMetrics {
  return {
    exact: scorecard(),
    semantic: {
      serial: { determinismF1: { entity: 1, fact: 0.4 }, litmusF1: { entity: 1, fact: 0.41 }, vsBaselineF1: null },
      optimistic: { determinismF1: { entity: 1, fact: 0.38 }, litmusF1: { entity: 0.9, fact: 0.3 }, vsBaselineF1: { entity: 0.95, fact: 0.7 } },
    },
    invariants: {
      'optimistic.forward': invariantReport(),
    },
    correctness: {
      'optimistic.forward': correctnessReport(),
    },
    perStep: {
      'optimistic.forward': {
        snapshot: {
          contradictions: { total: 0, byType: {}, resolved: 0, dismissed: 0, active: 0 },
          supersession: { expiredFacts: 1, activeFacts: 12, byExpireReason: { superseded: 1 } },
          causalEdges: { total: 3, active: 3, expired: 0 },
          sameAs: 1,
          entities: 6,
          facts: 13,
        },
        contradictions: { detectedDuringIngest: 11, reflectedInFinalTable: 0, gap: 11 },
      },
    },
  };
}

describe('buildRunReport', () => {
  const report = buildRunReport(manifest(), metrics(), { trend: 'TREND-PLACEHOLDER' });

  it('renders the header and both scorecards', () => {
    expect(report).toContain('# Comparison run run-2026');
    expect(report).toContain('corpus: corpus10.json (10 chunks)');
    expect(report).toContain('## Structural scorecard (exact)');
    expect(report).toContain('## Semantic scorecard (entityF1/factF1)');
    // optimistic arm's wall-clock + a semantic F1 land in the tables.
    expect(report).toContain('| optimistic | 1800 |');
    expect(report).toContain('0.95/0.70'); // optimistic vsBaseline entity/fact F1
  });

  it('renders the failing invariant WITH its offending row', () => {
    expect(report).toContain('## Invariants');
    expect(report).toContain('FAIL [error] singleActivePerExclusiveGroup');
    expect(report).toContain('Elena: 5 active title facts in group role_title, expected 1');
    // a passing invariant is still listed as PASS.
    expect(report).toContain('PASS [error] referentialIntegrity');
  });

  it('renders the gold correctness numbers + failing expectations + sprawl', () => {
    expect(report).toContain('current-state correctness: 0.25 (1/2 exclusive expectations)');
    expect(report).toContain('current-fact F1: 0.55');
    expect(report).toContain('failing exclusive expectations:');
    expect(report).toContain('Elena Vasquez [role_title]: expected `chief technology officer`, got 3 active');
    expect(report).toContain('role_title: 4 predicates');
  });

  it('renders the contradiction detected-vs-reflected gap', () => {
    expect(report).toContain('## Per-step instrumentation');
    expect(report).toContain('detected 11 during ingest, reflected 0 in final table, gap 11');
  });

  it('renders relative snapshot links for every arm/order', () => {
    expect(report).toContain('## Snapshots');
    expect(report).toContain('`serial.forward.canonical.json` / `serial.forward.rich.json`');
    expect(report).toContain('`optimistic.reverse.canonical.json` / `optimistic.reverse.rich.json`');
  });

  it('inserts the provided trend section', () => {
    expect(report).toContain('## Trend');
    expect(report).toContain('TREND-PLACEHOLDER');
  });

  it('falls back to a no-gold message when correctness is empty', () => {
    const r = buildRunReport(manifest(), { ...metrics(), correctness: {} });
    expect(r).toContain('No gold reference for this corpus — correctness skipped.');
  });

  it('omits the distributions section on a single-forward run (no distributions)', () => {
    expect(report).not.toContain('## Distributions');
  });

  it('renders a per-mode distributions table when metrics.distributions is present', () => {
    const m: RunMetrics = {
      ...metrics(),
      distributions: {
        optimistic: {
          wallClockMs: { mean: 1850, stddev: 70.71, min: 1800, max: 1900, n: 2 },
          currentStateCorrectness: { mean: 0.5, stddev: 0.25, min: 0.25, max: 0.75, n: 2 },
        },
      },
    };
    const r = buildRunReport({ ...manifest(), repeats: 2 }, m, { trend: 'T' });
    expect(r).toContain('## Distributions (variance across 2 repeats)');
    expect(r).toContain('### optimistic');
    expect(r).toContain('| metric | mean | stddev | min | max | n |');
    expect(r).toContain('| wallClockMs | 1850.00 | 70.71 | 1800.00 | 1900.00 | 2 |');
    expect(r).toContain('| currentStateCorrectness | 0.50 | 0.25 | 0.25 | 0.75 | 2 |');
  });
});

function armHistory(overrides: Partial<ArmHistory> = {}): ArmHistory {
  return {
    mode: 'optimistic',
    wallClockMs: 1800,
    entities: 6,
    activeFacts: 12,
    duplicateEntities: 0,
    duplicateFacts: 0,
    litmusExact: false,
    determinismF1: { entity: 1, fact: 0.38 },
    litmusF1: { entity: 0.9, fact: 0.3 },
    vsBaselineF1: { entity: 0.95, fact: 0.7 },
    currentStateCorrectness: 0.5,
    factF1VsGold: 0.6,
    invariantPassRate: 0.5,
    predicateSprawlMax: 4,
    ...overrides,
  };
}

function historyLine(runId: string, arms: ArmHistory[]): HistoryLine {
  return { runId, timestamp: '2026-06-02T00:00:00.000Z', gitCommit: 'abc1234', corpus: 'corpus10.json', baselineMode: 'serial', arms };
}

describe('buildTrend', () => {
  it('reports a first-run message when there is no prior', () => {
    expect(buildTrend(historyLine('run-1', [armHistory()]), null)).toBe('first run — no prior to compare.');
  });

  it('diffs the tracked metrics as prev -> curr (Δ) per arm', () => {
    const previous = historyLine('run-1', [armHistory({ currentStateCorrectness: 0.25, wallClockMs: 5000, factF1VsGold: 0.5 })]);
    const current = historyLine('run-2', [armHistory({ currentStateCorrectness: 0.75, wallClockMs: 1800, factF1VsGold: 0.6 })]);
    const trend = buildTrend(current, previous);

    expect(trend).toContain('->');
    // the headline "fix climbing" view: current-state-correctness up 0.25 -> 0.75.
    expect(trend).toContain('current-state-correctness: 0.25 -> 0.75 (Δ +0.50)');
    expect(trend).toContain('fact F1 vs gold: 0.50 -> 0.60 (Δ +0.10)');
    // throughput improved (lower) — negative delta.
    expect(trend).toContain('throughput ms: 5000.00 -> 1800.00 (Δ -3200.00)');
  });

  it('marks an arm with no prior counterpart and tolerates null metrics', () => {
    const previous = historyLine('run-1', [armHistory({ mode: 'serial' })]);
    const current = historyLine('run-2', [armHistory({ mode: 'optimistic', currentStateCorrectness: null, factF1VsGold: null, invariantPassRate: null, predicateSprawlMax: null })]);
    const trend = buildTrend(current, previous);
    expect(trend).toContain('optimistic (new arm — no prior)');
    expect(trend).toContain('current-state-correctness: - -> -');
  });
});
