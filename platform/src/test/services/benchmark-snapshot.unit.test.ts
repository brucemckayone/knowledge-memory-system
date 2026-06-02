/**
 * Unit tests for the benchmark snapshot store (doc 39 §3.2/§3.3, nmemo-hm4.2).
 *
 * Pure shapers + node:fs writers exercised against an os.tmpdir sandbox — no
 * DB, no network. Proves the runs/<runId>/ layout (canonical + rich per
 * arm/order), the history.jsonl append, and that a second run does not clobber
 * the first.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildManifest,
  buildHistoryLine,
  buildReportMd,
  writeRunSnapshot,
  appendHistoryLine,
  RICH_SCHEMA_VERSION,
  type RunMetrics,
  type ArmArtifact,
  type SemanticSummary,
} from '../../services/benchmark-snapshot.js';
import type { Scorecard } from '../../services/graph-canonical.js';

function fakeScorecard(): Scorecard {
  const counts = {
    entities: 5,
    distinctEntities: 5,
    activeFacts: 8,
    distinctFacts: 8,
    events: 3,
    activeEdges: 2,
    sameAs: 0,
  };
  return {
    baselineMode: 'serial',
    arms: [
      { mode: 'serial', wallClockMs: 1000, counts, duplicateEntities: 0, duplicateFacts: 0, litmusPass: true, vsBaseline: null },
      {
        mode: 'epoch',
        wallClockMs: 400,
        counts,
        duplicateEntities: 0,
        duplicateFacts: 0,
        litmusPass: true,
        vsBaseline: { structuralMatch: true, entitiesExtra: 0, entitiesMissing: 0, factsExtra: 1, factsMissing: 2 },
      },
    ],
  };
}

const semantic: Record<string, SemanticSummary> = {
  serial: { determinismF1: { entity: 1, fact: 0.3 }, litmusF1: { entity: 1, fact: 0.31 }, vsBaselineF1: null },
  epoch: { determinismF1: { entity: 1, fact: 0.29 }, litmusF1: { entity: 1, fact: 0.3 }, vsBaselineF1: { entity: 1, fact: 0.95 } },
};

describe('benchmark snapshot store', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'nmemo-snap-'));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function snapshotFor(runId: string): void {
    const scorecard = fakeScorecard();
    const manifest = buildManifest({
      runId,
      timestamp: '2026-06-02T00:00:00.000Z',
      gitCommit: 'abc1234',
      corpus: 'corpus10.json',
      chunkCount: 10,
      modes: ['serial', 'epoch'],
      orders: ['forward', 'reverse'],
    });
    const metrics: RunMetrics = { exact: scorecard, semantic };
    const arms: ArmArtifact[] = [
      { mode: 'serial', order: 'forward', canonical: { structuralHash: 's-fwd' }, rich: { entities: [], facts: [] } },
      { mode: 'serial', order: 'reverse', canonical: { structuralHash: 's-rev' }, rich: { entities: [], facts: [] } },
      { mode: 'epoch', order: 'forward', canonical: { structuralHash: 'e-fwd' }, rich: { entities: [], facts: [] } },
      { mode: 'epoch', order: 'reverse', canonical: { structuralHash: 'e-rev' }, rich: { entities: [], facts: [] } },
    ];
    const reportMd = buildReportMd(manifest, scorecard, semantic);
    writeRunSnapshot(root, { manifest, metrics, reportMd, arms });
    appendHistoryLine(
      root,
      buildHistoryLine({ runId, timestamp: manifest.timestamp, gitCommit: 'abc1234', corpus: 'corpus10.json' }, scorecard, semantic),
    );
  }

  it('writes the runs/<runId>/ layout with canonical + rich per arm/order', () => {
    snapshotFor('run-A');
    const runDir = join(root, 'runs', 'run-A');
    expect(existsSync(join(runDir, 'manifest.json'))).toBe(true);
    expect(existsSync(join(runDir, 'metrics.json'))).toBe(true);
    expect(existsSync(join(runDir, 'report.md'))).toBe(true);
    for (const f of ['serial.forward', 'serial.reverse', 'epoch.forward', 'epoch.reverse']) {
      expect(existsSync(join(runDir, `${f}.canonical.json`))).toBe(true);
      expect(existsSync(join(runDir, `${f}.rich.json`))).toBe(true);
    }

    const manifest = JSON.parse(readFileSync(join(runDir, 'manifest.json'), 'utf-8'));
    expect(manifest.richSchemaVersion).toBe(RICH_SCHEMA_VERSION);
    expect(manifest.corpus).toBe('corpus10.json');
    expect(manifest.model).toBe('unknown'); // defaulted (no model supplied)

    const metrics = JSON.parse(readFileSync(join(runDir, 'metrics.json'), 'utf-8'));
    expect(metrics.exact.baselineMode).toBe('serial');
    expect(metrics.semantic.epoch.vsBaselineF1.fact).toBeCloseTo(0.95);

    const report = readFileSync(join(runDir, 'report.md'), 'utf-8');
    expect(report).toContain('# Comparison run run-A');
    expect(report).toContain('Structural scorecard');
    expect(report).toContain('Semantic scorecard');
  });

  it('appends one history line per run and does not clobber prior runs', () => {
    snapshotFor('run-A');
    snapshotFor('run-B');

    expect(existsSync(join(root, 'runs', 'run-A', 'manifest.json'))).toBe(true);
    expect(existsSync(join(root, 'runs', 'run-B', 'manifest.json'))).toBe(true);

    const lines = readFileSync(join(root, 'history.jsonl'), 'utf-8').trim().split('\n');
    expect(lines.length).toBe(2);
    expect(lines.map((l) => JSON.parse(l).runId)).toEqual(['run-A', 'run-B']);

    const lineA = JSON.parse(lines[0]!);
    expect(lineA.baselineMode).toBe('serial');
    expect(lineA.arms).toHaveLength(2);
    expect(lineA.arms[0].mode).toBe('serial');
    expect(lineA.arms[1].litmusF1.fact).toBeCloseTo(0.3);
    expect(lineA.arms[0].vsBaselineF1).toBeNull();
  });
});
