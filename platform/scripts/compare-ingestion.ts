#!/usr/bin/env tsx
/**
 * compare-ingestion.ts — drive the parallel-ingestion comparison (doc 38).
 *
 * Runs one corpus (a JSON array of chunk strings — e.g. one longmemeval
 * question's sessions) through each pipeline arm against a LIVE platform,
 * captures the canonical graph after each, and prints the scorecard:
 * determinism/litmus (forward vs reverse), structural diff vs the serial
 * baseline, duplicate-entity/fact counts, and wall-clock throughput.
 *
 * Usage:
 *   tsx scripts/compare-ingestion.ts --chunks corpus.json \
 *     [--url http://127.0.0.1:3000] [--modes serial,epoch,optimistic] [--no-litmus]
 *
 * Requires the full stack (Postgres/Qdrant + ML services + Ollama). This is the
 * benchmark driver, not a unit test — the pure scorecard logic it uses
 * (buildScorecard) is unit-tested in src/test/services/harness.unit.test.ts.
 */

import { readFileSync } from 'node:fs';
import { buildScorecard, type ArmRun, type CanonicalGraph } from '../src/services/graph-canonical.js';

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

async function ingestAndCapture(
  mode: string,
  orderedChunks: string[],
): Promise<{ graph: CanonicalGraph; wallClockMs: number }> {
  const resetRes = await post('/api/reset');
  if (!resetRes.ok) throw new Error(`reset failed (${resetRes.status})`);
  const t0 = Date.now();
  const res = await post(`/ingest/batch/${mode}`, { chunks: orderedChunks, source: `compare-${mode}` });
  if (!res.ok) {
    const detail = await res.text().catch(() => res.statusText);
    throw new Error(`ingest ${mode} failed (${res.status}): ${detail}`);
  }
  return { graph: await captureCanonical(), wallClockMs: Date.now() - t0 };
}

async function main(): Promise<void> {
  console.log(`[compare] url=${URL} chunks=${corpus.length} modes=${modes.join(',')} litmus=${doLitmus}`);
  const runs: ArmRun[] = [];
  for (const mode of modes) {
    console.log(`\n[compare] === ${mode} (forward) ===`);
    const fwd = await ingestAndCapture(mode, corpus);
    const run: ArmRun = { mode, graph: fwd.graph, wallClockMs: fwd.wallClockMs };
    if (doLitmus) {
      console.log(`[compare] === ${mode} (reverse — litmus) ===`);
      const rev = await ingestAndCapture(mode, [...corpus].reverse());
      run.reverseGraph = rev.graph;
    }
    runs.push(run);
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
}

main().catch((err) => {
  console.error('[compare] failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
