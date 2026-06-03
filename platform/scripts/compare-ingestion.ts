#!/usr/bin/env tsx
/**
 * compare-ingestion.ts — drive the parallel-ingestion comparison (doc 38) and
 * persist each run for the validity & quality harness (doc 39 §3.2).
 *
 * Runs one corpus (a JSON array of chunk strings — e.g. one longmemeval
 * question's sessions) through each pipeline arm against a LIVE platform,
 * captures the canonical + rich graph after each arm/order, prints the
 * scorecard (determinism/litmus forward-vs-reverse, structural diff vs the
 * serial baseline, dup counts, wall-clock), and writes a snapshot under
 * benchmark-results/runs/<runId>/ plus one history.jsonl trend line.
 *
 * Usage:
 *   tsx scripts/compare-ingestion.ts --chunks corpus.json \
 *     [--url http://127.0.0.1:3000] [--modes serial,epoch,optimistic] \
 *     [--no-litmus] [--determinism] [--out <dir>] [--run-id <id>]
 *
 * Requires the full stack (Postgres/Qdrant + ML services + Ollama). This is the
 * benchmark driver, not a unit test — the pure logic it uses (buildScorecard;
 * buildManifest / buildHistoryLine / writeRunSnapshot; buildRunReport / buildTrend)
 * is unit-tested under src/test/services/.
 */

import { readFileSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Agent, setGlobalDispatcher } from 'undici';
import { buildScorecard, type ArmRun, type CanonicalGraph } from '../src/services/graph-canonical.js';
import { semanticDiff, type SemanticDiff } from '../src/services/graph-canonical-semantic.js';
import { runInvariants, type InvariantReport } from '../src/services/graph-invariants.js';
import { scoreAgainstGold, type GoldGraph, type CorrectnessReport } from '../src/services/graph-correctness.js';
import { aggregateRepeats, type RepeatSample, type Aggregate } from '../src/services/benchmark-aggregate.js';
import { deriveInstrumentation, contradictionGap } from '../src/services/graph-instrumentation.js';
import { reviewGraph, type GraphReview } from '../src/services/graph-review.js';
import { reviewReports, type ReportsReview } from '../src/services/reports-review.js';
import type { RichGraph } from '../src/services/graph-canonical-query.js';
import {
  writeRunSnapshot,
  appendHistoryLine,
  buildManifest,
  buildHistoryLine,
  type ArmArtifact,
  type RunOrder,
  type RunMetrics,
  type SemanticSummary,
  type HistoryLine,
} from '../src/services/benchmark-snapshot.js';
import { buildRunReport, buildTrend } from '../src/services/benchmark-report.js';

// A synchronous batch ingest holds one HTTP request open until the server has
// processed every chunk — a 10-chunk serial run is ~970s. That exceeds undici's
// default 300s `headersTimeout`, so global fetch aborts with "fetch failed"
// long before the platform responds (the 3-chunk smoke at ~290s squeaked under).
// Node's server has no response-time limit (requestTimeout bounds *receiving*
// the request, not the handler), so this is purely a client-side cap. Disable
// the client response timeouts so the harness waits as long as the run needs.
const dispatcher = new Agent({ headersTimeout: 0, bodyTimeout: 0 });
setGlobalDispatcher(dispatcher);

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}
const has = (name: string): boolean => process.argv.includes(`--${name}`);

const URL = arg('url', process.env.PLATFORM_URL ?? 'http://127.0.0.1:3000')!;
const chunksFile = arg('chunks');
const modes = arg('modes', 'serial,epoch,optimistic')!
  .split(',')
  .map((m) => m.trim())
  .filter(Boolean);
const doLitmus = !has('no-litmus');
const doDeterminism = has('determinism'); // run each mode forward twice → the LLM noise floor
// Repeats (doc 39 §2.F / §5 phase 6, nmemo-hm4.9): run each mode's FORWARD ingest
// N times and report mean/stddev/min/max/n per metric — variance bands, not a
// single point. Default 1 (the existing single-forward path, unchanged). Invalid
// / <1 values clamp to 1.
const repeats = Math.max(1, Math.trunc(Number(arg('repeats', '1'))) || 1);
// Agent review (doc 39 §2.D, nmemo-hm4.7) — OFF by default. When on, a STRONG
// judge model reviews each forward arm AFTER the artifacts are captured. A plain
// run never calls the judge. --judge-model overrides the model (provider/model,
// default anthropic/claude-opus-4-8); --judge-thinking overrides the effort level
// (off|minimal|low|medium|high, default high).
const doReview = has('review');
const judgeModel = arg('judge-model');
const judgeThinking = arg('judge-thinking');
const outRoot = arg('out', join(dirname(fileURLToPath(import.meta.url)), '..', 'benchmark-results'))!;
// Filesystem-safe timestamp runId; --run-id overrides (doc 39 §3.2: driver-stamped).
const runId = arg('run-id', new Date().toISOString().replace(/[:.]/g, '-'))!;

if (!chunksFile) {
  console.error('Missing --chunks <file.json> (a JSON array of chunk strings).');
  process.exit(1);
}
const chunks: unknown = JSON.parse(readFileSync(chunksFile, 'utf-8'));
if (!Array.isArray(chunks) || chunks.some((c) => typeof c !== 'string')) {
  console.error('--chunks must be a JSON array of strings.');
  process.exit(1);
}
const corpus = chunks as string[];

function gitCommit(): string {
  try {
    return execSync('git rev-parse --short HEAD', { encoding: 'utf-8' }).trim();
  } catch {
    return 'unknown';
  }
}

async function post(path: string, body?: unknown): Promise<Response> {
  return fetch(`${URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function captureCanonical(): Promise<CanonicalGraph> {
  const res = await fetch(`${URL}/api/graph/canonical`);
  if (!res.ok) throw new Error(`canonical capture failed (${res.status})`);
  return (await res.json()) as CanonicalGraph;
}

// Rich dump (doc 39 §3.1) — persisted verbatim; the driver doesn't interpret it
// (kept as unknown to avoid pulling the DB-backed graph-canonical-query module
// into the script).
async function captureRich(): Promise<unknown> {
  const res = await fetch(`${URL}/api/graph/full`);
  if (!res.ok) throw new Error(`rich capture failed (${res.status})`);
  return await res.json();
}

async function ingestAndCapture(
  mode: string,
  orderedChunks: string[],
): Promise<{ graph: CanonicalGraph; rich: unknown; runtimeStats: unknown; wallClockMs: number }> {
  const resetRes = await post('/api/reset');
  if (!resetRes.ok) throw new Error(`reset failed (${resetRes.status})`);
  const t0 = Date.now();
  const res = await post(`/ingest/batch/${mode}`, { chunks: orderedChunks, source: `compare-${mode}` });
  if (!res.ok) {
    // Read + surface the error body (capped) so the actual platform failure is
    // visible in the driver log. Previously the process crashed on exit (see the
    // graceful-exit block at the bottom) before this detail ever flushed.
    const detail = (await res.text().catch(() => res.statusText)).slice(0, 2000);
    throw new Error(`ingest ${mode} failed (${res.status}): ${detail}`);
  }
  // Capture the batch ingest RESPONSE BODY for per-step instrumentation
  // (doc 39 section 2.B, nmemo-hm4.5): the BatchIngestResult carries each
  // chunk's per-phase `timing` + entity/fact results. Parsed defensively —
  // an older running platform may return a different/empty shape, so a failed
  // parse degrades to undefined rather than aborting the run.
  const runtimeStats: unknown = await res.json().catch(() => undefined);
  const graph = await captureCanonical();
  const rich = await captureRich();
  return { graph, rich, runtimeStats, wallClockMs: Date.now() - t0 };
}

async function main(): Promise<void> {
  console.log(`[compare] url=${URL} chunks=${corpus.length} modes=${modes.join(',')} litmus=${doLitmus} determinism=${doDeterminism} repeats=${repeats} runId=${runId}`);

  // Gold reference (doc 39 §2.A) — loaded up front so each forward repeat can be
  // scored for its correctness/sprawl sample (nmemo-hm4.9), not just the
  // representative run. Keyed off the corpus basename; absent gold leaves
  // correctness null per repeat + empty `correctness` (no throw).
  const goldPath = join(outRoot, 'gold', `${basename(chunksFile, '.json')}.gold.json`);
  let gold: GoldGraph | null = null;
  try {
    gold = JSON.parse(readFileSync(goldPath, 'utf-8')) as GoldGraph;
    console.log(`[compare] gold reference loaded → ${goldPath}`);
  } catch {
    console.log(`[compare] no gold reference at ${goldPath}; skipping correctness.`);
  }

  /** Derive one repeat's variance sample (doc 39 §2.F) from its rich graph. */
  function sampleFromRich(rich: RichGraph, wallClockMs: number): RepeatSample {
    const c = gold ? scoreAgainstGold(rich, gold) : null;
    return {
      wallClockMs,
      entities: rich.counts.entities,
      activeFacts: rich.counts.activeFacts,
      currentStateCorrectness: c ? c.currentStateCorrectness : null,
      invariantErrorViolations: runInvariants(rich).summary.errorViolations,
      factF1VsGold: c ? c.currentFacts.f1 : null,
      predicateSprawlMax: c
        ? c.predicateSprawl.reduce((max, s) => Math.max(max, s.predicateCount), 0)
        : null,
    };
  }

  const runs: ArmRun[] = [];
  const determinismGraph: Record<string, CanonicalGraph> = {};
  const artifacts: ArmArtifact[] = [];
  // Per-mode variance bands across the N forward repeats (nmemo-hm4.9). Populated
  // only when repeats > 1; folded into metrics.distributions below.
  const distributions: Record<string, Record<string, Aggregate>> = {};
  // Batch ingest response bodies (per-phase timing etc.) keyed by `<mode>.<order>`,
  // kept parallel to `artifacts` so the on-disk ArmArtifact shape (persisted
  // verbatim) is unchanged. Folded into metrics.perStep below (nmemo-hm4.5).
  const runtimeStatsByArm: Record<string, unknown> = {};
  for (const mode of modes) {
    // Forward ingest, run `repeats` times (default 1). Repeat #1 is the
    // REPRESENTATIVE graph for the scorecard/artifacts/invariants/etc.
    // (preserving the single-forward path exactly when repeats === 1); every
    // repeat contributes one variance sample (nmemo-hm4.9).
    const samples: RepeatSample[] = [];
    console.log(`\n[compare] === ${mode} (forward${repeats > 1 ? ` ×${repeats}` : ''}) ===`);
    const fwd = await ingestAndCapture(mode, corpus);
    samples.push(sampleFromRich(fwd.rich as RichGraph, fwd.wallClockMs));
    artifacts.push({ mode, order: 'forward', canonical: fwd.graph, rich: fwd.rich });
    runtimeStatsByArm[`${mode}.forward`] = fwd.runtimeStats;
    const run: ArmRun = { mode, graph: fwd.graph, wallClockMs: fwd.wallClockMs };
    // Extra forward repeats (#2..N) — sampled only; not persisted as artifacts
    // and not fed into the representative scorecard.
    for (let i = 2; i <= repeats; i++) {
      console.log(`[compare] === ${mode} (forward #${i}/${repeats} — repeat) ===`);
      const rep = await ingestAndCapture(mode, corpus);
      samples.push(sampleFromRich(rep.rich as RichGraph, rep.wallClockMs));
    }
    if (repeats > 1) distributions[mode] = aggregateRepeats(samples);
    if (doDeterminism) {
      console.log(`[compare] === ${mode} (forward #2 — determinism) ===`);
      const fwd2 = await ingestAndCapture(mode, corpus);
      determinismGraph[mode] = fwd2.graph;
      artifacts.push({ mode, order: 'forward2', canonical: fwd2.graph, rich: fwd2.rich });
      runtimeStatsByArm[`${mode}.forward2`] = fwd2.runtimeStats;
    }
    if (doLitmus) {
      console.log(`[compare] === ${mode} (reverse — litmus) ===`);
      const rev = await ingestAndCapture(mode, [...corpus].reverse());
      run.reverseGraph = rev.graph;
      artifacts.push({ mode, order: 'reverse', canonical: rev.graph, rich: rev.rich });
      runtimeStatsByArm[`${mode}.reverse`] = rev.runtimeStats;
    }
    runs.push(run);
  }

  // Deterministic graph-integrity invariants over each captured rich graph
  // (doc 39 section 2.C, nmemo-hm4.3). Pure + LLM-free; keyed by `<mode>.<order>`.
  const invariants: Record<string, InvariantReport> = {};
  for (const a of artifacts) invariants[`${a.mode}.${a.order}`] = runInvariants(a.rich as RichGraph);

  // Reports review (doc 39 §2.E, nmemo-hm4.8): cross-check each captured rich
  // graph's agent self-reports (extraction/gardening/reasoning) against the
  // graph + characterize them. Pure + DB-free, so always-on; keyed `<mode>.<order>`.
  const reportsReview: Record<string, ReportsReview> = {};
  for (const a of artifacts) reportsReview[`${a.mode}.${a.order}`] = reviewReports(a.rich as RichGraph);

  // Ground-truth correctness vs the authored gold reference, keyed by
  // `<mode>.<order>` (doc 39 section 2.A, nmemo-hm4.4). `gold` was loaded up
  // front (so each forward repeat could be scored); absent gold leaves
  // correctness empty (no throw) so the harness still runs for un-authored
  // corpora.
  const correctness: Record<string, CorrectnessReport> = {};
  if (gold) {
    for (const a of artifacts) correctness[`${a.mode}.${a.order}`] = scoreAgainstGold(a.rich as RichGraph, gold);
  }

  // Per-step instrumentation (doc 39 section 2.B, nmemo-hm4.5), keyed by
  // `<mode>.<order>`. `runtimeStats` is the batch ingest response body the driver
  // captured (per-phase timing + tool-call-adjacent counts); `snapshot` is the
  // pure, snapshot-derived contradiction/supersession/edge/merge tally.
  const perStep: Record<string, unknown> = {};
  for (const a of artifacts) {
    const key = `${a.mode}.${a.order}`;
    const snapshot = deriveInstrumentation(a.rich as RichGraph);
    // Sum contradictionsDetected across the batch's per-chunk results, then pair
    // it with the snapshot's reflected total → the doc 39 §2.B detected-vs-
    // reflected gap (nmemo-hm4.5). runtimeStats is `unknown` (an older platform
    // may omit `results` or `contradictionsDetected`), so destructure
    // defensively: a missing/old shape yields detected=0, gap = -reflected.
    const stats = runtimeStatsByArm[key] as { results?: unknown } | undefined;
    const detectedDuringIngest = Array.isArray(stats?.results)
      ? stats.results.reduce(
          (sum: number, r: unknown) =>
            sum + (typeof (r as { contradictionsDetected?: unknown })?.contradictionsDetected === 'number'
              ? (r as { contradictionsDetected: number }).contradictionsDetected
              : 0),
          0,
        )
      : 0;
    perStep[key] = {
      runtimeStats: runtimeStatsByArm[key],
      snapshot,
      contradictions: contradictionGap(detectedDuringIngest, snapshot),
    };
  }

  // Agent review (doc 39 §2.D, nmemo-hm4.7) — opt-in via --review. Runs a STRONG
  // judge over each FORWARD arm (the canonical axis, matching the trend), feeding
  // it the corpus + rich graph + this arm's invariant findings. OFF by default,
  // so a plain run makes no LLM call and leaves agentReview undefined. Reviews
  // run serially; a single arm's judge failure is logged and skipped rather than
  // aborting the whole run.
  let agentReview: Record<string, GraphReview> | undefined;
  if (doReview) {
    agentReview = {};
    for (const a of artifacts) {
      if (a.order !== 'forward') continue;
      const key = `${a.mode}.forward`;
      console.log(`[compare] agent review → ${key}${judgeModel ? ` (model ${judgeModel})` : ''}`);
      try {
        agentReview[key] = await reviewGraph(
          { corpus, graph: a.rich as RichGraph, invariants: invariants[key]! },
          {
            ...(judgeModel ? { model: judgeModel } : {}),
            ...(judgeThinking ? { thinking: judgeThinking } : {}),
          },
        );
        console.log(`[compare]   verdict=${agentReview[key]!.verdict} issues=${agentReview[key]!.issues.length}`);
      } catch (err) {
        console.error(`[compare]   review ${key} failed: ${err instanceof Error ? err.message : err}`);
      }
    }
  }

  const baselineMode = modes.includes('serial') ? 'serial' : modes[0]!;
  const scorecard = buildScorecard(runs, baselineMode);

  console.log('\n===== SCORECARD =====');
  console.log(JSON.stringify(scorecard, null, 2));
  console.log('\nmode        | wallMs | ents | facts | dupEnt | dupFact | litmus | vsBaseline(match/extraF/missF)');
  for (const a of scorecard.arms) {
    const vb = a.vsBaseline
      ? `${a.vsBaseline.structuralMatch}/${a.vsBaseline.factsExtra}/${a.vsBaseline.factsMissing}`
      : 'baseline';
    console.log(
      `${a.mode.padEnd(11)} | ${String(a.wallClockMs).padStart(6)} | ${String(a.counts.entities).padStart(4)} | ${String(a.counts.activeFacts).padStart(5)} | ${String(a.duplicateEntities).padStart(6)} | ${String(a.duplicateFacts).padStart(7)} | ${String(a.litmusPass).padStart(6)} | ${vb}`,
    );
  }

  // Semantic (tolerance) scorecard — fuzzy entity + normalised-predicate fact
  // overlap (F1), robust to the LLM phrasing non-determinism that makes the
  // exact structural hash above fail even on two same-order runs. Read it as:
  //   litmus F1 ≈ determinism F1  → order-independent up to extraction noise
  //   litmus F1 ≪ determinism F1  → a real order / parallelism effect
  const baseRun = runs.find((r) => r.mode === baselineMode);
  const f2 = (x: number): string => x.toFixed(2);
  const fmt = (d: SemanticDiff | null): string => (d ? `${f2(d.entity.f1)}/${f2(d.fact.f1)}` : '    -    ');
  console.log('\n===== SEMANTIC SCORECARD (entityF1/factF1) =====');
  console.log('mode        | determinism | litmus(fwd|rev) | vsBaseline');
  const semanticByMode: Record<string, SemanticSummary> = {};
  for (const run of runs) {
    const detG = determinismGraph[run.mode];
    const det = detG ? semanticDiff(run.graph, detG) : null;
    const lit = run.reverseGraph ? semanticDiff(run.graph, run.reverseGraph) : null;
    const vsb = baseRun && run.mode !== baselineMode ? semanticDiff(run.graph, baseRun.graph) : null;
    const toF1 = (d: SemanticDiff | null) => (d ? { entity: d.entity.f1, fact: d.fact.f1 } : null);
    semanticByMode[run.mode] = { determinismF1: toF1(det), litmusF1: toF1(lit), vsBaselineF1: toF1(vsb) };
    const vsbStr = run.mode === baselineMode ? 'baseline' : fmt(vsb);
    console.log(`${run.mode.padEnd(11)} | ${fmt(det).padStart(11)} | ${fmt(lit).padStart(15)} | ${vsbStr}`);
  }

  // Distributions (variance across N forward repeats) — only when repeats > 1
  // (doc 39 §2.F, nmemo-hm4.9). mean ± stddev [min, max] (n) per metric.
  if (repeats > 1) {
    console.log(`\n===== DISTRIBUTIONS (${repeats} forward repeats: mean ± stddev [min, max] n) =====`);
    for (const mode of Object.keys(distributions).sort()) {
      console.log(`--- ${mode} ---`);
      for (const [metric, a] of Object.entries(distributions[mode]!)) {
        console.log(
          `  ${metric.padEnd(24)} ${a.mean.toFixed(2)} ± ${a.stddev.toFixed(2)} [${a.min.toFixed(2)}, ${a.max.toFixed(2)}] n=${a.n}`,
        );
      }
    }
  }

  // --- persist the run (doc 39 §3.2) ---
  const orders: RunOrder[] = ['forward'];
  if (doDeterminism) orders.push('forward2');
  if (doLitmus) orders.push('reverse');
  const timestamp = new Date().toISOString();
  const commit = gitCommit();
  const manifest = buildManifest({
    runId,
    timestamp,
    gitCommit: commit,
    corpus: basename(chunksFile),
    chunkCount: corpus.length,
    modes,
    orders,
    concurrency: {
      epoch: process.env.EPOCH_CONCURRENCY ?? '6',
      optimistic: process.env.OPTIMISTIC_CONCURRENCY ?? '6',
    },
    model: process.env.LLM_PROVIDER ?? 'pi',
    repeats,
  });
  const metrics: RunMetrics = { exact: scorecard, semantic: semanticByMode, invariants, correctness, perStep, reportsReview };
  // Only attach agentReview when --review ran (keep it OFF the metrics on a plain run).
  if (agentReview) metrics.agentReview = agentReview;
  // Variance bands only when the run repeated (>1) — keep them OFF the metrics on
  // the default single-forward run (nmemo-hm4.9).
  if (repeats > 1) metrics.distributions = distributions;

  // The current run's enriched history line (now needs the metrics maps for the
  // per-arm quality fields — current-state-correctness, fact F1, invariant
  // pass-rate, predicate-sprawl — that give the trend signal).
  const currentLine = buildHistoryLine({ runId, timestamp, gitCommit: commit, corpus: manifest.corpus, repeats }, scorecard, semanticByMode, metrics);

  // Read the prior run's history line (the last line of history.jsonl, one JSON
  // object per line) so the trend can diff run N vs N-1. Missing file / empty /
  // unparsable last line → null (first-run message). Done BEFORE appending so we
  // compare against the previous run, not this one.
  const historyPath = join(outRoot, 'history.jsonl');
  let previousLine: HistoryLine | null = null;
  if (existsSync(historyPath)) {
    const prevLines = readFileSync(historyPath, 'utf-8').trim().split('\n').filter(Boolean);
    const last = prevLines.at(-1);
    if (last) {
      try {
        previousLine = JSON.parse(last) as HistoryLine;
      } catch {
        previousLine = null;
      }
    }
  }
  const trend = buildTrend(currentLine, previousLine);
  const reportMd = buildRunReport(manifest, metrics, { trend });

  const runDir = writeRunSnapshot(outRoot, { manifest, metrics, reportMd, arms: artifacts });
  appendHistoryLine(outRoot, currentLine);
  console.log(`\n[compare] snapshot written → ${runDir}`);
  console.log(`[compare] history appended → ${historyPath}`);
}

// Exit cleanly. Forcing process.exit() while undici's keep-alive sockets are
// mid-teardown trips Node's `UV_HANDLE_CLOSING` assertion (exit 9) — which on a
// failed arm crashed the driver *before* the error detail flushed (nmemo-1tc).
// Set exitCode + close the dispatcher so the event loop drains and Node exits on
// its own, with the error fully printed.
main()
  .catch((err) => {
    console.error('[compare] failed:', err instanceof Error ? (err.stack ?? err.message) : err);
    process.exitCode = 1;
  })
  .finally(async () => {
    try {
      await dispatcher.close();
    } catch {
      await dispatcher.destroy();
    }
  });
