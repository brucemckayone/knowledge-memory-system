/**
 * Deterministic primitives for the synthetic generator (doc 28 §3.3).
 *
 * Identical seed must produce identical output across runs and platforms, so
 * everything random in the generator routes through these helpers. Math.random
 * is forbidden in the generator path.
 */

import { createHash } from 'crypto';

/**
 * Mulberry32 PRNG. 32-bit state, fast, sufficient for synthetic test data.
 * Calling sites use `next()` for [0, 1), `nextInt(min, max)` for inclusive
 * integer ranges, and `nextGaussian()` for standard normal samples.
 */
export class SeededRandom {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
    if (this.state === 0) this.state = 1;
  }

  next(): number {
    this.state = (this.state + 0x6D2B79F5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  nextInt(minInclusive: number, maxInclusive: number): number {
    return Math.floor(this.next() * (maxInclusive - minInclusive + 1)) + minInclusive;
  }

  /** Box-Muller transform; returns one standard-normal sample per call. */
  nextGaussian(): number {
    let u1 = this.next();
    let u2 = this.next();
    if (u1 < 1e-12) u1 = 1e-12;
    return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  }

  pick<T>(arr: readonly T[]): T {
    return arr[this.nextInt(0, arr.length - 1)]!;
  }
}

/**
 * Deterministic UUIDv5 (name-based, SHA-1). Identical (namespace, name) pairs
 * always produce the same UUID. Used to derive entity, memory, and fact IDs
 * from a stable seed-prefixed name.
 */
export function uuidv5(name: string, namespace: string): string {
  const nsBytes = uuidStringToBytes(namespace);
  const nameBytes = Buffer.from(name, 'utf-8');
  const buf = Buffer.concat([nsBytes, nameBytes]);
  const hash = createHash('sha1').update(buf).digest();
  const bytes = Buffer.from(hash.subarray(0, 16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  return bytesToUuid(bytes);
}

function uuidStringToBytes(uuid: string): Buffer {
  const hex = uuid.replace(/-/g, '');
  const out = Buffer.alloc(16);
  for (let i = 0; i < 16; i++) {
    out[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function bytesToUuid(b: Buffer): string {
  const hex = b.toString('hex');
  return [
    hex.substring(0, 8),
    hex.substring(8, 12),
    hex.substring(12, 16),
    hex.substring(16, 20),
    hex.substring(20, 32),
  ].join('-');
}

/** A stable namespace for synthetic snapshot UUIDs (RFC 4122 random UUID). */
export const SYNTHETIC_NS = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';

/** Generate a unit-norm Gaussian vector of the given dimension. */
export function gaussianUnitVector(rng: SeededRandom, dim: number): number[] {
  const v = new Array<number>(dim);
  let sumSq = 0;
  for (let i = 0; i < dim; i++) {
    const g = rng.nextGaussian();
    v[i] = g;
    sumSq += g * g;
  }
  const norm = Math.sqrt(sumSq) || 1;
  for (let i = 0; i < dim; i++) v[i]! /= norm;
  return v;
}

/**
 * Sample a vector around a mode: mode + sigma * gaussian, then renormalise.
 * Used for per-memory vectors clustered near their entity's assigned mode.
 */
export function sampleAroundMode(
  rng: SeededRandom,
  mode: number[],
  sigma: number,
): number[] {
  const dim = mode.length;
  const v = new Array<number>(dim);
  let sumSq = 0;
  for (let i = 0; i < dim; i++) {
    const x = mode[i]! + sigma * rng.nextGaussian();
    v[i] = x;
    sumSq += x * x;
  }
  const norm = Math.sqrt(sumSq) || 1;
  for (let i = 0; i < dim; i++) v[i]! /= norm;
  return v;
}

export function cosine(a: number[], b: number[]): number {
  const n = a.length;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < n; i++) {
    const ai = a[i]!, bi = b[i]!;
    dot += ai * bi;
    na += ai * ai;
    nb += bi * bi;
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

/**
 * Stable canonicalised JSON stringify (sorted keys, no whitespace variance).
 * The synthetic generator must produce byte-identical ground_truth.json
 * across runs with the same seed.
 */
export function stableJsonStringify(value: unknown, indent = 2): string {
  function canonicalise(v: unknown): unknown {
    if (Array.isArray(v)) return v.map(canonicalise);
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      const keys = Object.keys(v as Record<string, unknown>).sort();
      for (const k of keys) out[k] = canonicalise((v as Record<string, unknown>)[k]);
      return out;
    }
    return v;
  }
  return JSON.stringify(canonicalise(value), null, indent);
}
