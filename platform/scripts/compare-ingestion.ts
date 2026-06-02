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
 * buildManifest / buildHistoryLine / buildReportMd / writeRunSnapshot) is
 * unit-tested under src/test/services/.
 */

import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Agent, setGlobalDispatcher } from 'undici';
import { buildScorecard, type ArmRun, type CanonicalGraph } from '../src/services/graph-canonical.js';
import { semanticDiff, type SemanticDiff } from '../src/services/graph-canonical-semantic.js';
import { runInvariants, type InvariantReport } from '../src/services/graph-invariants.js';
import { scoreAgainstGold, type GoldGraph, type CorrectnessReport } from '../src/services/graph-correctness.js';
import { deriveInstrumentation, contradictionGap } from '../src/services/graph-instrumentation.js';
import type { RichGraph } from '../src/services/graph-canonical-query.js';
import {
  writeRunSnapshot,
  appendHistoryLine,
  buildManifest,
  buildHistoryLine,
  buildReportMd,
  type ArmArtifact,
  type RunOrder,
  type RunMetrics,
  type SemanticSummary,
} from '../src/services/benchmark-snapshot.js';

// A synchronous batch ingest holds one HTTP request open until the server has
// processed every chunk — a 10-chunk serial run is ~970s. That exceeds undici's
// default 300s `headersTimeout`, so global fetch aborts with "fetch failed"
// long before the platform responds (the 3-chunk smoke at ~290s squeaked under).
// Node's server has no response-time limit (requestTimeout bounds *receiving*
// the request, not the handler), so this is purely a client-side cap. Disable
// the client response timeouts so the harness waits as long as the run needs.
setGlobalDispatcher(new Agent({ headersTimeout: 0, bodyTimeout: 0 }));

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
    const detail = await res.text().catch(() => res.statusText);
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
  console.log(`[compare] url=${URL} chunks=${corpus.length} modes=${modes.join(',')} litmus=${doLitmus} determinism=${doDeterminism} runId=${runId}`);
  const runs: ArmRun[] = [];
  const determinismGraph: Record<string, CanonicalGraph> = {};
  const artifacts: ArmArtifact[] = [];
  // Batch ingest response bodies (per-phase timing etc.) keyed by `<mode>.<order>`,
  // kept parallel to `artifacts` so the on-disk ArmArtifact shape (persisted
  // verbatim) is unchanged. Folded into metrics.perStep below (nmemo-hm4.5).
  const runtimeStatsByArm: Record<string, unknown> = {};
  for (const mode of modes) {
    console.log(`\n[compare] === ${mode} (forward) ===`);
    const fwd = await ingestAndCapture(mode, corpus);
    artifacts.push({ mode, order: 'forward', canonical: fwd.graph, rich: fwd.rich });
    runtimeStatsByArm[`${mode}.forward`] = fwd.runtimeStats;
    const run: ArmRun = { mode, graph: fwd.graph, wallClockMs: fwd.wallClockMs };
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

  // Ground-truth correctness vs the authored gold reference, keyed by
  // `<mode>.<order>` (doc 39 section 2.A, nmemo-hm4.4). The gold file is keyed
  // off the corpus basename; absent gold leaves correctness empty (no throw) so
  // the harness still runs for un-authored corpora.
  const correctness: Record<string, CorrectnessReport> = {};
  const goldPath = join(outRoot, 'gold', `${basename(chunksFile, '.json')}.gold.json`);
  let gold: GoldGraph | null = null;
  try {
    gold = JSON.parse(readFileSync(goldPath, 'utf-8')) as GoldGraph;
    console.log(`[compare] gold reference loaded → ${goldPath}`);
  } catch {
    console.log(`[compare] no gold reference at ${goldPath}; skipping correctness.`);
  }
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
  });
  const metrics: RunMetrics = { exact: scorecard, semantic: semanticByMode, invariants, correctness, perStep };
  const reportMd = buildReportMd(manifest, scorecard, semanticByMode);
  const runDir = writeRunSnapshot(outRoot, { manifest, metrics, reportMd, arms: artifacts });
  appendHistoryLine(outRoot, buildHistoryLine({ runId, timestamp, gitCommit: commit, corpus: manifest.corpus }, scorecard, semanticByMode));
  console.log(`\n[compare] snapshot written → ${runDir}`);
  console.log(`[compare] history appended → ${join(outRoot, 'history.jsonl')}`);
}

main().catch((err) => {
  console.error('[compare] failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
