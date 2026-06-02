/**
 * Chunking-site convergence (nmemo-yxj.4).
 *
 * After yxj.2 the embed-unit split (small overlapping 128/64 satellites) lives
 * in store() (pipeline.ts splitIntoUnits). The three ingest sites must converge
 * on ONE window policy: capture-turn.mjs and the LongMemEval harness feed
 * agent-processing WINDOWS and DEFER unit-splitting to store(); they must NOT
 * each re-implement embed-driven chunking to fit the nomic ~2048-token limit
 * (that limit now only constrains the small unit inside store()).
 *
 * These are PURE source-shape assertions — no infra, no embedder. They read the
 * three sites' source and assert:
 *   - store() is the single owner of embed-unit splitting (splitIntoUnits).
 *   - capture-turn.mjs windows text at the SHARED window size and no longer
 *     re-implements embed-unit splitting nor justifies its cap by the nomic
 *     embed limit.
 *   - the harness window default (max_ingest_chars) matches the SAME shared
 *     window size, so neither upstream site diverges.
 *
 * The harness's own behavioural contract (window blobs, not 128-char units;
 * stream_id/content_type threading) is covered by the Python test
 * benchmarks/longmemeval/test_ingest_payload.py — this file pins the JS hook
 * site and the cross-site numeric agreement that Python cannot see.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '../../../..');

/** The ONE shared agent-processing window size (chars). yxj.5 tunes the NUMBER;
 * yxj.4 only requires the upstream sites AGREE on it instead of each picking a
 * private embed-fit cap. Kept in sync with benchmarks/longmemeval/config.yaml
 * max_ingest_chars and capture-turn.mjs's window constant. */
const SHARED_WINDOW_CHARS = 6000;

const captureTurnSrc = readFileSync(
  join(REPO_ROOT, 'platform/hooks/capture-turn.mjs'),
  'utf-8',
);
const pipelineSrc = readFileSync(
  join(REPO_ROOT, 'platform/src/pipeline.ts'),
  'utf-8',
);
const harnessConfigSrc = readFileSync(
  join(REPO_ROOT, 'benchmarks/longmemeval/config.yaml'),
  'utf-8',
);
const harnessRunSrc = readFileSync(
  join(REPO_ROOT, 'benchmarks/longmemeval/run.py'),
  'utf-8',
);

describe('chunking convergence: one store() unit policy (nmemo-yxj.4)', () => {
  it('store() is the single owner of embed-unit splitting', () => {
    // The canonical unit splitter lives in store()'s module and store() calls
    // it. This is the one path the two upstream sites defer to.
    expect(pipelineSrc).toMatch(/export function splitIntoUnits\b/);
    expect(pipelineSrc).toMatch(/const units = splitIntoUnits\(text\)/);
  });

  it('capture-turn windows text at the shared window size, not a private embed cap', () => {
    // Find the window-size constant the hook chunks at. It must equal the
    // shared window policy (so it no longer diverges from the harness's 6000).
    const m = captureTurnSrc.match(/const\s+(\w*CHUNK\w*|\w*WINDOW\w*)\s*=\s*(\d+)/);
    expect(m, 'capture-turn must declare a numeric window-size constant').toBeTruthy();
    expect(Number(m![2]), 'capture-turn window size must match the shared policy').toBe(
      SHARED_WINDOW_CHARS,
    );
  });

  it('capture-turn does NOT re-justify its cap by the nomic embed limit', () => {
    // The old rationale ("stay under nomic-embed-text context limit") is the
    // divergent embed-fit cap the bead removes — units handle embedding now.
    expect(captureTurnSrc).not.toMatch(/under\s+nomic/i);
    // It must frame the cap as an agent-processing WINDOW that defers to store().
    expect(captureTurnSrc.toLowerCase()).toMatch(/window/);
  });

  it('capture-turn does NOT re-implement embed-unit splitting (defers to store)', () => {
    // The hook feeds windows to /ingest; the 128/64 satellite split is store()'s
    // job. The guard against a fourth split path is: the hook must not CALL the
    // canonical splitter nor a numeric stride/overlap loop of its own. (The
    // surrounding comment may name store()'s satellites to explain the deferral,
    // so we match a splitIntoUnits CALL, not prose.)
    expect(captureTurnSrc).not.toMatch(/splitIntoUnits\s*\(/);
  });

  it('harness window default matches the shared window size', () => {
    // benchmarks/longmemeval/config.yaml is the harness window policy.
    const m = harnessConfigSrc.match(/max_ingest_chars:\s*(\d+)/);
    expect(m, 'config.yaml must set max_ingest_chars').toBeTruthy();
    expect(Number(m![1]), 'harness window must match the shared policy').toBe(
      SHARED_WINDOW_CHARS,
    );
    // The Python default fallback in run.py must agree (no second number).
    const def = harnessRunSrc.match(/max_ingest_chars["']?,\s*(\d+)\)/);
    expect(def, 'run.py must default max_ingest_chars').toBeTruthy();
    expect(Number(def![1])).toBe(SHARED_WINDOW_CHARS);
  });

  it('harness does NOT re-implement embed-unit splitting (defers to store)', () => {
    // chunk_session windows at turn boundaries; it must not carve 128-char
    // embed units — those are store()'s satellites. Match the knob/splitter
    // identifier (a re-implementation), not prose mentions.
    expect(harnessRunSrc).not.toMatch(/EMBED_UNIT_CHARS|EMBED_UNIT_OVERLAP|splitIntoUnits/);
  });
});
