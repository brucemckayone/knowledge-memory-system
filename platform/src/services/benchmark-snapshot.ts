/**
 * Benchmark snapshot store (doc 39 §3.2/§3.3, nmemo-hm4.2).
 *
 * Persists each parallel-ingestion comparison run so graphs are inspectable +
 * re-analyzable and progress is trackable across commits. The comparison driver
 * (`scripts/compare-ingestion.ts`) stamps a `runId`, calls {@link writeRunSnapshot}
 * with the captured graphs, and {@link appendHistoryLine} for the trend.
 *
 * Layout (doc 39 §3.2):
 * ```
 * <root>/
 *   runs/<runId>/
 *     manifest.json                  provenance: runId, gitCommit, corpus, modes…  [tracked]
 *     <arm>.<order>.canonical.json   diffable (doc 38)            [raw dump — gitignored]
 *     <arm>.<order>.rich.json        full dump (doc 39 §3.1)      [raw dump — gitignored]
 *     metrics.json                   exact + semantic scorecards  [tracked]
 *     report.md                      human-readable report (benchmark-report.ts)  [tracked]
 *   history.jsonl                    one line per run → trend     [tracked]
 * ```
 * Retention (nmemo-hm4.2 decision): the curated artifacts are tracked; the bulky
 * regenerable per-run graph dumps are gitignored.
 *
 * Pure shaping ({@link buildManifest} / {@link buildHistoryLine}) is split from
 * the `node:fs` writers so the shaping is unit-testable without touching disk;
 * the writers are exercised against a temp dir. The human-readable `report.md`
 * itself is shaped by `benchmark-report.ts` ({@link buildRunReport}/`buildTrend`).
 */

import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Scorecard } from './graph-canonical.js';
import type { InvariantReport } from './graph-invariants.js';
import type { CorrectnessReport } from './graph-correctness.js';

/** Chunk-order a graph was built in: forward, a second forward (determinism), reverse (litmus). */
export type RunOrder = 'forward' | 'forward2' | 'reverse';

/** Bump when the rich-export schema (doc 39 §3.1) changes shape. */
export const RICH_SCHEMA_VERSION = 1;

export interface Manifest {
  runId: string;
  timestamp: string;
  gitCommit: string;
  /** Basename of the chunks file (the gold key is keyed off this). */
  corpus: string;
  chunkCount: number;
  modes: string[];
  orders: RunOrder[];
  /** Per-arm worker counts the run used (from EPOCH_/OPTIMISTIC_CONCURRENCY). */
  concurrency: Record<string, string>;
  /** LLM provider/model the pipeline ran under (GLM via the Pi bridge by default). */
  model: string;
  richSchemaVersion: number;
}

export interface ManifestInput {
  runId: string;
  timestamp: string;
  gitCommit: string;
  corpus: string;
  chunkCount: number;
  modes: string[];
  orders: RunOrder[];
  concurrency?: Record<string, string>;
  model?: string;
}

/** Shape the run manifest. Pure. */
export function buildManifest(input: ManifestInput): Manifest {
  return {
    runId: input.runId,
    timestamp: input.timestamp,
    gitCommit: input.gitCommit,
    corpus: input.corpus,
    chunkCount: input.chunkCount,
    modes: input.modes,
    orders: input.orders,
    concurrency: input.concurrency ?? {},
    model: input.model ?? 'unknown',
    richSchemaVersion: RICH_SCHEMA_VERSION,
  };
}

/** F1 pair for one comparison axis (entity + fact), or null when that axis didn't run. */
export interface F1Pair {
  entity: number;
  fact: number;
}

/** Per-mode semantic (fuzzy) F1 summary the driver computes via semanticDiff. */
export interface SemanticSummary {
  /** Forward vs forward#2 — the LLM noise floor. */
  determinismF1: F1Pair | null;
  /** Forward vs reverse — the litmus (Bug A/B) signal. */
  litmusF1: F1Pair | null;
  /** This arm vs the baseline arm. null for the baseline itself. */
  vsBaselineF1: F1Pair | null;
}

/** What metrics.json holds today. Later beads extend it (per-step .5). */
export interface RunMetrics {
  /** Exact structural scorecard (doc 38). */
  exact: Scorecard;
  /** Per-mode semantic F1 summaries. */
  semantic: Record<string, SemanticSummary>;
  /** Deterministic graph-integrity invariants per `<mode>.<order>` (doc 39 section 2.C, nmemo-hm4.3). */
  invariants: Record<string, InvariantReport>;
  /**
   * Ground-truth correctness vs the authored gold reference per `<mode>.<order>`
   * (doc 39 section 2.A, nmemo-hm4.4). Empty `{}` when no gold file exists for
   * the corpus.
   */
  correctness: Record<string, CorrectnessReport>;
  /**
   * Per-step instrumentation per `<mode>.<order>` (doc 39 section 2.B,
   * nmemo-hm4.5). Each value carries `{ runtimeStats, snapshot }`:
   * `runtimeStats` is the batch ingest RESPONSE BODY the driver captured
   * (per-chunk `timing` etc. - shape-agnostic, may be absent on old servers);
   * `snapshot` is the pure {@link SnapshotInstrumentation} derived from the rich
   * dump. Kept `unknown`-valued so the schema doesn't couple to either source.
   */
  perStep: Record<string, unknown>;
}

/** Per-arm trend summary persisted to one history.jsonl line. */
export interface ArmHistory {
  mode: string;
  wallClockMs: number;
  entities: number;
  activeFacts: number;
  duplicateEntities: number;
  duplicateFacts: number;
  /** Exact structural-hash forward==reverse (null when litmus skipped). */
  litmusExact: boolean | null;
  determinismF1: F1Pair | null;
  litmusF1: F1Pair | null;
  vsBaselineF1: F1Pair | null;
  // Quality fields for the trend (doc 39 §3.3), from this arm's `${mode}.forward`
  // entry of the correctness / invariants maps. null when that data is absent
  // (no gold authored, or no forward invariant report).
  /** Fraction (0..1) of gold exclusive expectations that pass; null without gold. */
  currentStateCorrectness: number | null;
  /** Current-fact F1 vs gold.currentFacts; null without gold. */
  factF1VsGold: number | null;
  /** Passed error-invariants / total error-invariants for the forward order; null without a report. */
  invariantPassRate: number | null;
  /** Max distinct-predicate count across sprawled exclusive groups (0 = no sprawl); null without gold. */
  predicateSprawlMax: number | null;
}

export interface HistoryLine {
  runId: string;
  timestamp: string;
  gitCommit: string;
  corpus: string;
  baselineMode: string;
  arms: ArmHistory[];
}

/** Passed error-invariants / total error-invariants (the forward-order quality rate). */
function errorInvariantPassRate(report: InvariantReport | undefined): number | null {
  if (report == null) return null;
  const errors = report.results.filter((r) => r.severity === 'error');
  if (errors.length === 0) return 1;
  return errors.filter((r) => r.pass).length / errors.length;
}

/** Max distinct-predicate count across sprawled exclusive groups (0 when none). */
function predicateSprawlMax(report: CorrectnessReport | undefined): number | null {
  if (report == null) return null;
  return report.predicateSprawl.reduce((max, s) => Math.max(max, s.predicateCount), 0);
}

/**
 * Assemble one history.jsonl line by merging the exact scorecard, the per-mode
 * semantic summaries, and the per-arm quality fields (doc 39 §3.3). Pure. The
 * quality fields (current-state-correctness, fact F1 vs gold, invariant
 * pass-rate, predicate-sprawl) come from each arm's `${mode}.forward` entry of
 * `metrics.correctness` / `metrics.invariants` — forward is the canonical trend
 * axis. They stay null when that data is absent (no gold authored / no report).
 */
export function buildHistoryLine(
  meta: { runId: string; timestamp: string; gitCommit: string; corpus: string },
  scorecard: Scorecard,
  semanticByMode: Record<string, SemanticSummary>,
  metrics: Pick<RunMetrics, 'invariants' | 'correctness'>,
): HistoryLine {
  return {
    runId: meta.runId,
    timestamp: meta.timestamp,
    gitCommit: meta.gitCommit,
    corpus: meta.corpus,
    baselineMode: scorecard.baselineMode,
    arms: scorecard.arms.map((a) => {
      const correctness = metrics.correctness[`${a.mode}.forward`];
      return {
        mode: a.mode,
        wallClockMs: a.wallClockMs,
        entities: a.counts.entities,
        activeFacts: a.counts.activeFacts,
        duplicateEntities: a.duplicateEntities,
        duplicateFacts: a.duplicateFacts,
        litmusExact: a.litmusPass,
        determinismF1: semanticByMode[a.mode]?.determinismF1 ?? null,
        litmusF1: semanticByMode[a.mode]?.litmusF1 ?? null,
        vsBaselineF1: semanticByMode[a.mode]?.vsBaselineF1 ?? null,
        currentStateCorrectness: correctness?.currentStateCorrectness ?? null,
        factF1VsGold: correctness?.currentFacts.f1 ?? null,
        invariantPassRate: errorInvariantPassRate(metrics.invariants[`${a.mode}.forward`]),
        predicateSprawlMax: predicateSprawlMax(correctness),
      };
    }),
  };
}

/** One captured graph for an (arm, order) pair. `canonical`/`rich` are persisted verbatim. */
export interface ArmArtifact {
  mode: string;
  order: RunOrder;
  canonical: unknown;
  rich: unknown;
}

export interface RunSnapshot {
  manifest: Manifest;
  metrics: RunMetrics;
  reportMd: string;
  arms: ArmArtifact[];
}

function writeJson(path: string, data: unknown): void {
  writeFileSync(path, JSON.stringify(data, null, 2), 'utf-8');
}

/**
 * Write the `runs/<runId>/` directory. Creates it if missing. Distinct runIds
 * land in distinct directories, so a new run never clobbers a prior one;
 * re-writing the same runId overwrites that run's own files (idempotent).
 * Returns the run directory path.
 */
export function writeRunSnapshot(root: string, snap: RunSnapshot): string {
  const runDir = join(root, 'runs', snap.manifest.runId);
  mkdirSync(runDir, { recursive: true });
  writeJson(join(runDir, 'manifest.json'), snap.manifest);
  writeJson(join(runDir, 'metrics.json'), snap.metrics);
  writeFileSync(join(runDir, 'report.md'), snap.reportMd, 'utf-8');
  for (const a of snap.arms) {
    writeJson(join(runDir, `${a.mode}.${a.order}.canonical.json`), a.canonical);
    writeJson(join(runDir, `${a.mode}.${a.order}.rich.json`), a.rich);
  }
  return runDir;
}

/** Append one trend line to `<root>/history.jsonl` (creates the root + file). */
export function appendHistoryLine(root: string, line: HistoryLine): void {
  mkdirSync(root, { recursive: true });
  appendFileSync(join(root, 'history.jsonl'), `${JSON.stringify(line)}\n`, 'utf-8');
}
