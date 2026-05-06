/**
 * Snapshot manifest loader / validator.
 *
 * The manifest at `platform/src/test/snapshots/manifest.json` is the single
 * source of truth for all snapshots. See `docs/architecture/truth-graph/28-test-data-snapshots.md`
 * §2.3 for the schema definition. This module exposes a typed loader plus a
 * validator that enforces the §4.2 invariants ("Manifest valid").
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Absolute path to the platform repo root (where package.json lives). */
export const PLATFORM_ROOT = resolve(__dirname, '..', '..');

/** Absolute path to the committed manifest. */
export const MANIFEST_PATH = join(PLATFORM_ROOT, 'src', 'test', 'snapshots', 'manifest.json');

/** Absolute path to the per-machine snapshot cache (gitignored). */
export const SNAPSHOT_CACHE_DIR = join(PLATFORM_ROOT, 'test-snapshots');

export type SnapshotKind = 'llm' | 'synthetic';

export interface SnapshotFiles {
  postgres: string;
  qdrant_memories?: string;
  ground_truth?: string;
}

export interface IngestParams {
  chunk_size?: number;
  model?: string;
  extraction_prompt_version?: string;
  claude_model_version_pin?: string;
  claude_temperature?: number;
  embedding_model_pin?: string;
  embedding_dim?: number;
  chunk_timeout_ms?: number;
  run_gardening?: boolean;
}

export interface GeneratorParams {
  entity_count: number;
  cluster_count: number;
  facts_per_entity_mean: number;
  centroid_dim: number;
  bridge_pairs: number;
  seed: number;
}

export interface SnapshotStats {
  total_entities?: number;
  total_facts?: number;
  total_memories?: number;
  bridge_pairs_count?: number;
  ingest_time_ms?: number;
  [key: string]: unknown;
}

export interface SnapshotEntry {
  name: string;
  kind: SnapshotKind;
  description: string;

  /** LLM-only. Path relative to PLATFORM_ROOT. Optional for `empty`. */
  source_corpus?: string | null;
  ingest_params?: IngestParams;

  /** Synthetic-only. */
  generator_params?: GeneratorParams;

  pg_dump_flags?: string[];
  files: SnapshotFiles;
  expected_hashes: Record<string, string>;
  schema_version: number;
  age_version?: string;
  postgres_version?: string;
  stats: SnapshotStats;
  regenerated_at?: string | null;
  regeneration_command?: string;
  deterministic: boolean;
  notes?: string;
  deprecated?: boolean;
}

export interface Manifest {
  version: number;
  entries: SnapshotEntry[];
}

const REQUIRED_TOP_LEVEL = ['version', 'entries'] as const;
const REQUIRED_ENTRY_FIELDS = [
  'name',
  'kind',
  'description',
  'files',
  'expected_hashes',
  'schema_version',
  'stats',
  'deterministic',
] as const;

export class ManifestError extends Error {
  constructor(message: string) {
    super(`Manifest invalid: ${message}`);
    this.name = 'ManifestError';
  }
}

export function loadManifest(path: string = MANIFEST_PATH): Manifest {
  if (!existsSync(path)) {
    throw new ManifestError(`file not found: ${path}`);
  }
  const raw = readFileSync(path, 'utf-8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    throw new ManifestError(`JSON parse failed: ${detail}`);
  }
  validateManifest(parsed);
  return parsed as Manifest;
}

export function saveManifest(manifest: Manifest, path: string = MANIFEST_PATH): void {
  validateManifest(manifest);
  writeFileSync(path, JSON.stringify(manifest, null, 2) + '\n', 'utf-8');
}

export function validateManifest(value: unknown): asserts value is Manifest {
  if (!value || typeof value !== 'object') {
    throw new ManifestError('manifest is not an object');
  }
  const obj = value as Record<string, unknown>;
  for (const field of REQUIRED_TOP_LEVEL) {
    if (!(field in obj)) {
      throw new ManifestError(`missing top-level field: ${field}`);
    }
  }
  if (typeof obj.version !== 'number') {
    throw new ManifestError('version must be a number');
  }
  if (!Array.isArray(obj.entries)) {
    throw new ManifestError('entries must be an array');
  }
  const seenNames = new Set<string>();
  for (let i = 0; i < obj.entries.length; i++) {
    const entry = obj.entries[i];
    validateEntry(entry, i);
    const name = (entry as SnapshotEntry).name;
    if (seenNames.has(name)) {
      throw new ManifestError(`duplicate entry name: ${name}`);
    }
    seenNames.add(name);
  }
}

function validateEntry(value: unknown, index: number): void {
  if (!value || typeof value !== 'object') {
    throw new ManifestError(`entry[${index}] is not an object`);
  }
  const entry = value as Record<string, unknown>;
  for (const field of REQUIRED_ENTRY_FIELDS) {
    if (!(field in entry)) {
      throw new ManifestError(`entry[${index}] missing required field: ${field}`);
    }
  }
  if (typeof entry.name !== 'string' || entry.name.length === 0) {
    throw new ManifestError(`entry[${index}] name must be a non-empty string`);
  }
  if (entry.kind !== 'llm' && entry.kind !== 'synthetic') {
    throw new ManifestError(`entry[${index}] (${entry.name}) kind must be "llm" or "synthetic"`);
  }
  const files = entry.files as Record<string, unknown> | undefined;
  if (!files || typeof files !== 'object' || typeof files.postgres !== 'string') {
    throw new ManifestError(`entry[${index}] (${entry.name}) files.postgres must be a string`);
  }
  if (typeof entry.schema_version !== 'number') {
    throw new ManifestError(`entry[${index}] (${entry.name}) schema_version must be a number`);
  }
  if (typeof entry.deterministic !== 'boolean') {
    throw new ManifestError(`entry[${index}] (${entry.name}) deterministic must be a boolean`);
  }
}

export function findEntry(manifest: Manifest, name: string): SnapshotEntry {
  const entry = manifest.entries.find((e) => e.name === name);
  if (!entry) {
    const known = manifest.entries.map((e) => e.name).join(', ');
    throw new ManifestError(`entry not found: ${name} (known: ${known || '<none>'})`);
  }
  return entry;
}

export function entryCacheDir(entry: SnapshotEntry): string {
  return join(SNAPSHOT_CACHE_DIR, entry.name);
}

export function entryFileAbsPath(entry: SnapshotEntry, fileKey: keyof SnapshotFiles): string | null {
  const rel = entry.files[fileKey];
  if (!rel) return null;
  return join(PLATFORM_ROOT, rel);
}
