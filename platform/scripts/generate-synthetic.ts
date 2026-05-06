#!/usr/bin/env tsx
/**
 * snapshot:synthetic <name> — deterministic synthetic generator (doc 28 §3.3).
 *
 * 13-step layered process:
 *   1. DATABASE_URL guard (cognitive_test or cognitive_snapshot_*)
 *   2. drop + recreate target DB
 *   3. apply migrations (mirrors global-setup.ts)
 *   4. generate cluster_count Gaussian mode vectors
 *   5. generate N entities, assign each to a cluster mode
 *   6. generate per-entity memories (vectors drawn from entity's mode)
 *   7. inject bridge pairs — entities pinned to different modes, no shared
 *      memories/facts/aliases, NOT linked by same_as_links, labelled in
 *      the side ground_truth.json
 *   8. generate facts respecting cluster topology
 *   9. insert memory_entities + Qdrant points
 *  10. call REAL updateEntityMeta to compute centroids from memory vectors
 *  11. (optional) same_as_links between non-bridge cluster mode pairs
 *  12. dump Postgres (plain) + recreate Qdrant from snapshot
 *  13. write ground_truth.json
 *
 * Determinism: identical seed → byte-identical Postgres dump (plain format)
 * AND byte-identical ground_truth.json (stable-JSON serialisation).
 */

import { mkdirSync, rmSync, existsSync, writeFileSync, readdirSync, readFileSync, statSync } from 'fs';
import { dirname, join } from 'path';
import postgres from 'postgres';
import {
  loadManifest,
  saveManifest,
  findEntry,
  entryFileAbsPath,
  PLATFORM_ROOT,
  SnapshotEntry,
  GeneratorParams,
} from './lib/manifest.js';
import { sha256File } from './lib/hash.js';
import { loadAndAssertDatabaseUrl } from './lib/db-guard.js';
import { resolvePgTools, runPgDump, ConnInfo } from './lib/pg-tools.js';
import { dropAndRecreateDatabase, enableExtensionsAndMigrate } from './lib/db-bootstrap.js';
import {
  SeededRandom,
  uuidv5,
  SYNTHETIC_NS,
  gaussianUnitVector,
  sampleAroundMode,
  cosine,
  stableJsonStringify,
} from './lib/synthetic.js';

const ENTITY_TYPES = ['person', 'company', 'project', 'concept', 'place', 'event'] as const;
const NON_EXCLUSIVE_PREDICATES = ['knows', 'collaborates_with', 'related_to', 'works_on', 'uses', 'created'] as const;
const QDRANT_URL = process.env.QDRANT_URL || 'http://127.0.0.1:6335';
const QDRANT_COLLECTION = 'memories';
/**
 * Per-component noise stddev when sampling memory vectors around a cluster
 * mode. Modes themselves are unit-norm Gaussian. With dim=768 and sigma=0.01
 * the noise vector norm is ~0.01*sqrt(768)≈0.28, so the renormalised memory
 * vector lies well inside the cluster mode's neighbourhood. Empirically the
 * resulting centroids sit at cosine distance well under 0.05 from the mode.
 */
const SIGMA_INTRA_CLUSTER = 0.01;
const CROSS_CLUSTER_FACT_PROB = 0.05;
const CENTROID_SANITY_MAX_DISTANCE = 0.15;

interface SyntheticEntity {
  id: string;
  name: string;
  type: string;
  cluster: number;
  isBridge: boolean;
  bridgePartnerId?: string;
  bridgeIndex?: number;
  memoryIds: string[];
}

interface BridgePair {
  a: string;
  b: string;
  reason: string;
}

export async function generateSynthetic(name: string): Promise<{
  entry: SnapshotEntry;
  durationMs: number;
}> {
  const start = Date.now();
  const manifest = loadManifest();
  const entry = findEntry(manifest, name);
  if (entry.kind !== 'synthetic') {
    throw new Error(`generate-synthetic requires kind="synthetic"; "${name}" is "${entry.kind}".`);
  }
  const params = entry.generator_params;
  if (!params) throw new Error(`entry "${name}" missing generator_params`);
  validateParams(params);

  // Step 1: hard guard
  const conn = loadAndAssertDatabaseUrl();
  // The script imports the production graph-meta service, which boots its db
  // singleton against config.DATABASE_URL. Force the test URL so the singleton
  // wires up against the snapshot target rather than the dev DB. Same story
  // for QDRANT_URL — config.ts reads it at module-load time and the qdrant
  // service caches a client off the snapshot.
  process.env.DATABASE_URL = `postgres://${conn.user}:${conn.password}@${conn.host}:${conn.port}/${conn.database}`;
  process.env.NODE_ENV = 'test';
  process.env.QDRANT_URL = QDRANT_URL;

  const pgTools = resolvePgTools();
  console.log(`  pg_dump: ${pgTools.note}`);

  // Step 2: drop + recreate
  console.log(`  → drop + recreate ${conn.database}`);
  await dropAndRecreateDatabase(conn);

  // Step 3: migrate
  console.log(`  → apply migrations`);
  const { migrationsApplied } = await enableExtensionsAndMigrateForSynthetic(conn);
  console.log(`    applied ${migrationsApplied} migration files`);

  const rng = new SeededRandom(params.seed);

  // Step 4: cluster modes
  console.log(`  → generate ${params.cluster_count} cluster modes (dim=${params.centroid_dim})`);
  const modes: number[][] = [];
  for (let c = 0; c < params.cluster_count; c++) {
    modes.push(gaussianUnitVector(rng, params.centroid_dim));
  }

  // Steps 5 + 7: entities + bridge-pair assignments
  console.log(`  → generate ${params.entity_count} entities (bridges: ${params.bridge_pairs})`);
  const { entities, bridgePairs, modePairs } = layoutEntities(rng, params);

  // Step 6 + 9: per-entity memories + memory_entities + Qdrant points
  console.log(`  → generate memories + Qdrant points`);
  const memoryVectors = new Map<string, number[]>();
  for (const ent of entities) {
    const mode = modes[ent.cluster]!;
    const memoryCount = sampleMemoryCount(rng, params);
    for (let i = 0; i < memoryCount; i++) {
      const memId = uuidv5(`${params.seed}|memory|${ent.id}|${i}`, SYNTHETIC_NS);
      const vec = sampleAroundMode(rng, mode, SIGMA_INTRA_CLUSTER);
      memoryVectors.set(memId, vec);
      ent.memoryIds.push(memId);
    }
  }

  await writeEntitiesAndMemoryEntities(conn, entities, params);
  await uploadQdrantPoints(memoryVectors, params.centroid_dim);

  // Step 8: facts (after memories, so memory_entities link is available for
  // structural-similarity scoring later)
  console.log(`  → generate facts`);
  const totalFacts = await writeFacts(conn, rng, entities, params);

  // Step 10: real updateEntityMeta — exercises production code path.
  // Centroids are computed from Qdrant memory vectors, sorted by memory_id
  // (qdrant.ts:getMemoryVectors) so IEEE-754 accumulation is stable across
  // runs. This is what makes the snapshot byte-deterministic.
  console.log(`  → call updateEntityMeta for ${entities.length} entities`);
  await callUpdateEntityMeta(entities.map((e) => e.id));
  await stompEntityMetaTimestamps(conn);

  // Sanity check: each entity's centroid sits close to its assigned cluster mode.
  await assertCentroidsNearModes(conn, entities, modes);

  // Step 11: optional same_as_links between non-bridge cluster mode pairs
  console.log(`  → write same_as_links (non-bridge topology variation)`);
  await writeNonBridgeSameAsLinks(conn, rng, entities, modePairs, params);

  // Step 12: dump Postgres + (re)create Qdrant collection state
  const dumpAbs = entryFileAbsPath(entry, 'postgres');
  if (!dumpAbs) throw new Error(`entry "${name}" missing files.postgres path`);
  mkdirSync(dirname(dumpAbs), { recursive: true });

  const dumpFlags = entry.pg_dump_flags ?? defaultDumpFlags(entry.pg_dump_format ?? 'plain');
  console.log(`  → pg_dump → ${dumpAbs} (flags: ${dumpFlags.join(' ')})`);
  await runPgDump(pgTools, conn as ConnInfo, dumpFlags, dumpAbs);

  await stripPgDumpHeaderTimestamp(dumpAbs);

  // Step 13: write ground_truth.json
  const groundTruthAbs = entryFileAbsPath(entry, 'ground_truth');
  if (!groundTruthAbs) {
    throw new Error(`entry "${name}" missing files.ground_truth path`);
  }
  mkdirSync(dirname(groundTruthAbs), { recursive: true });
  const groundTruthBody = stableJsonStringify({
    snapshot: name,
    seed: params.seed,
    bridge_pairs: bridgePairs,
  }) + '\n';
  writeFileSync(groundTruthAbs, groundTruthBody, 'utf-8');

  // Update manifest
  const dumpHash = await sha256File(dumpAbs);
  const truthHash = await sha256File(groundTruthAbs);
  const dumpBaseName = dumpAbs.split(/[\\/]/).pop()!;
  const truthBaseName = groundTruthAbs.split(/[\\/]/).pop()!;
  entry.expected_hashes = {
    ...entry.expected_hashes,
    [dumpBaseName]: dumpHash,
    [truthBaseName]: truthHash,
  };
  entry.regenerated_at = new Date().toISOString();
  entry.stats = {
    ...entry.stats,
    total_entities: entities.length,
    total_memories: memoryVectors.size,
    total_facts: totalFacts,
    bridge_pairs_count: bridgePairs.length,
  };
  saveManifest(manifest);

  const durationMs = Date.now() - start;
  console.log(
    `  ✓ generated "${name}" in ${durationMs}ms ` +
    `(entities=${entities.length}, memories=${memoryVectors.size}, ` +
    `facts=${totalFacts}, bridges=${bridgePairs.length})`,
  );
  return { entry, durationMs };
}

function validateParams(p: GeneratorParams): void {
  if (p.cluster_count < 2 && p.bridge_pairs > 0) {
    throw new Error('bridge pairs require at least two cluster modes (cluster_count >= 2)');
  }
  if (p.entity_count < p.bridge_pairs * 2) {
    throw new Error('entity_count must accommodate 2 entities per bridge pair');
  }
}

function defaultDumpFlags(format: string): string[] {
  if (format === 'plain') {
    return [
      '--format=plain',
      '--no-owner',
      '--no-privileges',
      '--no-tablespaces',
      '--no-comments',
      '--no-publications',
      '--no-subscriptions',
      '--no-security-labels',
    ];
  }
  return ['--format=custom', '--no-sync', '--no-comments'];
}

function sampleMemoryCount(rng: SeededRandom, p: GeneratorParams): number {
  const expected = Math.max(1, Math.round(p.facts_per_entity_mean));
  const jitter = rng.nextInt(0, 1);
  return Math.max(1, expected + jitter - 1);
}

function layoutEntities(rng: SeededRandom, p: GeneratorParams): {
  entities: SyntheticEntity[];
  bridgePairs: BridgePair[];
  modePairs: Array<[number, number]>;
} {
  const allModePairs: Array<[number, number]> = [];
  for (let i = 0; i < p.cluster_count; i++) {
    for (let j = i + 1; j < p.cluster_count; j++) {
      allModePairs.push([i, j]);
    }
  }
  // Sample bridge_pairs cluster-mode pairs deterministically. When more
  // bridge pairs are requested than unique (unordered) cluster-mode pairs,
  // we cycle through after a single shuffled pass — multiple bridge pairs
  // can sit on the same (modeA, modeB) so long as the entity instances are
  // distinct. Doc 28 §3.3 step 7 says "selects N pairs of cluster modes",
  // which we interpret as sampling-with-replacement once unique pairs run out.
  const shuffled = [...allModePairs];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = rng.nextInt(0, i);
    [shuffled[i]!, shuffled[j]!] = [shuffled[j]!, shuffled[i]!];
  }
  const bridgeModePairs: Array<[number, number]> = [];
  for (let i = 0; i < p.bridge_pairs; i++) {
    bridgeModePairs.push(shuffled[i % shuffled.length]!);
  }

  const entities: SyntheticEntity[] = [];
  const bridgePairs: BridgePair[] = [];

  // Seed the bridge entities first so their cluster pinning is determined
  // independently of the round-robin assignment used for the rest.
  for (let bIdx = 0; bIdx < bridgeModePairs.length; bIdx++) {
    const [modeA, modeB] = bridgeModePairs[bIdx]!;
    const aId = uuidv5(`${p.seed}|bridge|${bIdx}|a`, SYNTHETIC_NS);
    const bId = uuidv5(`${p.seed}|bridge|${bIdx}|b`, SYNTHETIC_NS);
    const aType = ENTITY_TYPES[bIdx % ENTITY_TYPES.length]!;
    const bType = ENTITY_TYPES[bIdx % ENTITY_TYPES.length]!;
    entities.push({
      id: aId,
      name: `synth-bridge-${bIdx}-a`,
      type: aType,
      cluster: modeA,
      isBridge: true,
      bridgePartnerId: bId,
      bridgeIndex: bIdx,
      memoryIds: [],
    });
    entities.push({
      id: bId,
      name: `synth-bridge-${bIdx}-b`,
      type: bType,
      cluster: modeB,
      isBridge: true,
      bridgePartnerId: aId,
      bridgeIndex: bIdx,
      memoryIds: [],
    });
    bridgePairs.push({ a: aId, b: bId, reason: `bridge_pair_${bIdx}` });
  }

  for (let i = entities.length; i < p.entity_count; i++) {
    const id = uuidv5(`${p.seed}|entity|${i}`, SYNTHETIC_NS);
    const cluster = i % p.cluster_count;
    const type = ENTITY_TYPES[i % ENTITY_TYPES.length]!;
    entities.push({
      id,
      name: `synth-${i}-${id.slice(0, 8)}`,
      type,
      cluster,
      isBridge: false,
      memoryIds: [],
    });
  }

  // Sort by id so insertion order (and downstream OID assignment) is stable
  entities.sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
  bridgePairs.sort((x, y) => (x.a < y.a ? -1 : x.a > y.a ? 1 : 0));

  return { entities, bridgePairs, modePairs: bridgeModePairs };
}

async function enableExtensionsAndMigrateForSynthetic(target: ConnInfo): Promise<{
  migrationsApplied: number;
}> {
  const result = await enableExtensionsAndMigrate(target);
  const sql = postgres({
    host: target.host,
    port: target.port,
    user: target.user,
    password: target.password,
    database: target.database,
  });
  try {
    // Disable AGE entity-sync triggers on the synthetic load path. Migration
    // 003 installs sync_entity_to_graph / trigger_sync_fact, both of which
    // call cypher() on every row inserted. They have no functional impact on
    // synthetic data (we don't read AGE in tests) and add significant insert
    // overhead at 10k entities.
    await sql.unsafe(`
      DROP TRIGGER IF EXISTS sync_entity_to_graph ON public.entities;
      DROP TRIGGER IF EXISTS trigger_sync_fact ON public.facts;
    `);
    // Migration seed rows (entity_types, fact_predicates) default created_at
    // to NOW(). Stomp them so the dump bytes don't drift across regenerations.
    const tsIso = SYNTHETIC_TIMESTAMP.toISOString();
    await sql.unsafe(`UPDATE public.entity_types SET created_at = $1::timestamptz`, [tsIso]);
    await sql.unsafe(`UPDATE public.fact_predicates SET created_at = $1::timestamptz`, [tsIso]);
  } finally {
    await sql.end();
  }
  return result;
}

/**
 * A deterministic timestamp used for every NOW()-defaulted column in the
 * synthetic dataset. Without this every row's `created_at`/`updated_at`
 * carries the wall-clock at insert time, which is the dominant source of
 * dump-level non-determinism. The ISO timestamp is stable; consumers that
 * read it should not depend on its exact value.
 */
const SYNTHETIC_TIMESTAMP = new Date('2026-01-01T00:00:00.000Z');

async function writeEntitiesAndMemoryEntities(
  conn: ConnInfo,
  entities: SyntheticEntity[],
  _params: GeneratorParams,
): Promise<void> {
  const sql = postgres({
    host: conn.host,
    port: conn.port,
    user: conn.user,
    password: conn.password,
    database: conn.database,
  });
  try {
    const ts = SYNTHETIC_TIMESTAMP;
    const ENTITY_BATCH = 500;
    for (let i = 0; i < entities.length; i += ENTITY_BATCH) {
      const batch = entities.slice(i, i + ENTITY_BATCH);
      const rows = batch.map((e) => ({
        id: e.id,
        canonical_name: e.name,
        entity_type: e.type,
        description: null,
        properties: { synthetic: true, cluster: e.cluster, is_bridge: e.isBridge },
        first_seen_at: ts,
        last_seen_at: ts,
        created_at: ts,
        updated_at: ts,
      }));
      await sql`
        INSERT INTO public.entities ${sql(rows, 'id', 'canonical_name', 'entity_type', 'description', 'properties', 'first_seen_at', 'last_seen_at', 'created_at', 'updated_at')}
      `;
    }
    const ME_BATCH = 1000;
    const meRows: Array<{
      id: string;
      memory_id: string;
      entity_id: string;
      mention_text: string;
      created_at: Date;
    }> = [];
    for (const e of entities) {
      for (let mi = 0; mi < e.memoryIds.length; mi++) {
        const memId = e.memoryIds[mi]!;
        meRows.push({
          id: uuidv5(`me|${e.id}|${memId}|${mi}`, SYNTHETIC_NS),
          memory_id: memId,
          entity_id: e.id,
          mention_text: `synthetic memory mention for ${e.name}`,
          created_at: ts,
        });
      }
    }
    for (let i = 0; i < meRows.length; i += ME_BATCH) {
      const batch = meRows.slice(i, i + ME_BATCH);
      await sql`
        INSERT INTO public.memory_entities ${sql(batch, 'id', 'memory_id', 'entity_id', 'mention_text', 'created_at')}
      `;
    }
  } finally {
    await sql.end();
  }
}

async function uploadQdrantPoints(
  memoryVectors: Map<string, number[]>,
  dim: number,
): Promise<void> {
  // Reset collection so we start clean (per doc 28 §3.5 step 6, but here we
  // reset before upload too — synthetic generation is destructive)
  await fetch(`${QDRANT_URL}/collections/${QDRANT_COLLECTION}`, { method: 'DELETE' });
  const createRes = await fetch(`${QDRANT_URL}/collections/${QDRANT_COLLECTION}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ vectors: { size: dim, distance: 'Cosine' } }),
  });
  if (!createRes.ok) {
    throw new Error(`Qdrant create collection failed: ${createRes.status} ${await createRes.text()}`);
  }

  const BATCH = 500;
  const ids = [...memoryVectors.keys()];
  for (let i = 0; i < ids.length; i += BATCH) {
    const batchIds = ids.slice(i, i + BATCH);
    const points = batchIds.map((id) => ({
      id,
      vector: memoryVectors.get(id)!,
    }));
    const upsertRes = await fetch(
      `${QDRANT_URL}/collections/${QDRANT_COLLECTION}/points?wait=true`,
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ points }),
      },
    );
    if (!upsertRes.ok) {
      throw new Error(`Qdrant upsert failed: ${upsertRes.status} ${await upsertRes.text()}`);
    }
  }
}

async function writeFacts(
  conn: ConnInfo,
  rng: SeededRandom,
  entities: SyntheticEntity[],
  params: GeneratorParams,
): Promise<number> {
  const targetTotal = Math.round(params.facts_per_entity_mean * entities.length);

  // Group entities by cluster
  const byCluster = new Map<number, SyntheticEntity[]>();
  for (const e of entities) {
    if (!byCluster.has(e.cluster)) byCluster.set(e.cluster, []);
    byCluster.get(e.cluster)!.push(e);
  }

  const sql = postgres({
    host: conn.host,
    port: conn.port,
    user: conn.user,
    password: conn.password,
    database: conn.database,
  });
  try {
    const factRows: Array<{
      id: string;
      subject_entity_id: string;
      predicate: string;
      object_entity_id: string;
      confidence: number;
      created_at: Date;
    }> = [];

    for (let f = 0; f < targetTotal; f++) {
      const subject = entities[rng.nextInt(0, entities.length - 1)]!;
      const isCrossCluster = rng.next() < CROSS_CLUSTER_FACT_PROB && !subject.isBridge;
      let object: SyntheticEntity;
      if (isCrossCluster) {
        const otherCluster = pickOtherCluster(rng, subject.cluster, params.cluster_count);
        const pool = byCluster.get(otherCluster);
        if (!pool || pool.length === 0) {
          object = pickInCluster(rng, subject, byCluster);
        } else {
          object = pool[rng.nextInt(0, pool.length - 1)]!;
        }
      } else {
        object = pickInCluster(rng, subject, byCluster);
      }
      // Bridge-pair entities never get a fact pointing at their partner
      // (would link the pair through the structural-similarity signal —
      // contradicts §3.3 step 7).
      if (subject.isBridge && object.id === subject.bridgePartnerId) {
        continue;
      }
      if (object.id === subject.id) continue;
      const predicate = NON_EXCLUSIVE_PREDICATES[rng.nextInt(0, NON_EXCLUSIVE_PREDICATES.length - 1)]!;
      const factId = uuidv5(`${params.seed}|fact|${f}`, SYNTHETIC_NS);
      factRows.push({
        id: factId,
        subject_entity_id: subject.id,
        predicate,
        object_entity_id: object.id,
        confidence: 0.9,
        created_at: SYNTHETIC_TIMESTAMP,
      });
    }

    const FACT_BATCH = 1000;
    for (let i = 0; i < factRows.length; i += FACT_BATCH) {
      const batch = factRows.slice(i, i + FACT_BATCH);
      await sql`
        INSERT INTO public.facts ${sql(batch, 'id', 'subject_entity_id', 'predicate', 'object_entity_id', 'confidence', 'created_at')}
        ON CONFLICT DO NOTHING
      `;
    }

    const counted = await sql<{ c: string }[]>`SELECT COUNT(*)::text AS c FROM public.facts`;
    return parseInt(counted[0]?.c ?? '0', 10);
  } finally {
    await sql.end();
  }
}

function pickInCluster(
  rng: SeededRandom,
  subject: SyntheticEntity,
  byCluster: Map<number, SyntheticEntity[]>,
): SyntheticEntity {
  const pool = byCluster.get(subject.cluster)!;
  for (let attempt = 0; attempt < 8; attempt++) {
    const cand = pool[rng.nextInt(0, pool.length - 1)]!;
    if (cand.id !== subject.id) return cand;
  }
  return pool[0]!;
}

function pickOtherCluster(rng: SeededRandom, exclude: number, clusterCount: number): number {
  let pick = rng.nextInt(0, clusterCount - 1);
  if (pick === exclude) pick = (pick + 1) % clusterCount;
  return pick;
}

async function callUpdateEntityMeta(entityIds: string[]): Promise<void> {
  // Lazy import — production graph-meta service builds a Drizzle singleton
  // off DATABASE_URL on first import. Now that we've set it to the test DB,
  // it's safe to import.
  const mod = await import('../src/services/graph-meta.js');
  const BATCH = 200;
  for (let i = 0; i < entityIds.length; i += BATCH) {
    const slice = entityIds.slice(i, i + BATCH);
    await mod.updateEntityMeta(slice);
  }
}

async function stompEntityMetaTimestamps(conn: ConnInfo): Promise<void> {
  const sql = postgres({
    host: conn.host,
    port: conn.port,
    user: conn.user,
    password: conn.password,
    database: conn.database,
  });
  try {
    await sql`
      UPDATE public.entity_meta SET
        updated_at = ${SYNTHETIC_TIMESTAMP},
        first_mentioned_at = ${SYNTHETIC_TIMESTAMP},
        last_mentioned_at = ${SYNTHETIC_TIMESTAMP}
    `;
  } finally {
    await sql.end();
  }
}

async function assertCentroidsNearModes(
  conn: ConnInfo,
  entities: SyntheticEntity[],
  modes: number[][],
): Promise<void> {
  const sql = postgres({
    host: conn.host,
    port: conn.port,
    user: conn.user,
    password: conn.password,
    database: conn.database,
  });
  try {
    const sample = entities.slice(0, Math.min(50, entities.length));
    for (const ent of sample) {
      const rows = await sql<{ centroid: string }[]>`
        SELECT centroid::text AS centroid FROM public.entity_meta WHERE entity_id = ${ent.id}::uuid
      `;
      if (!rows[0] || !rows[0].centroid) {
        throw new Error(`entity ${ent.id} has no centroid after updateEntityMeta`);
      }
      const vec = parseVector(rows[0].centroid);
      const mode = modes[ent.cluster]!;
      const sim = cosine(vec, mode);
      const dist = 1 - sim;
      if (dist > CENTROID_SANITY_MAX_DISTANCE) {
        throw new Error(
          `centroid sanity check failed for entity ${ent.id}: ` +
          `cosine distance ${dist.toFixed(4)} from cluster mode ${ent.cluster} ` +
          `exceeds ${CENTROID_SANITY_MAX_DISTANCE}`,
        );
      }
    }
  } finally {
    await sql.end();
  }
}

function parseVector(s: string): number[] {
  return s.replace(/^\[|\]$/g, '').split(',').map(Number);
}

async function writeNonBridgeSameAsLinks(
  conn: ConnInfo,
  rng: SeededRandom,
  entities: SyntheticEntity[],
  bridgeModePairs: Array<[number, number]>,
  params: GeneratorParams,
): Promise<void> {
  // Stay clear of bridge-pair cluster pairs: per §3.3 step 7, bridge entities
  // must not be linked by same_as_links. The simplest invariant is "no
  // same_as_links between any two clusters that participate in a bridge pair."
  const bridgeClusterPairKeys = new Set(bridgeModePairs.map(([a, b]) => `${a}-${b}`));
  const linkCount = Math.max(1, Math.round(params.entity_count * 0.001));
  const sql = postgres({
    host: conn.host,
    port: conn.port,
    user: conn.user,
    password: conn.password,
    database: conn.database,
  });
  try {
    const written: Array<{
      id: string;
      entity_a_id: string;
      entity_b_id: string;
      reasoning: string;
      confidence: number;
      created_at: Date;
    }> = [];
    let attempts = 0;
    let counter = 0;
    while (written.length < linkCount && attempts < linkCount * 20) {
      attempts++;
      const a = entities[rng.nextInt(0, entities.length - 1)]!;
      const b = entities[rng.nextInt(0, entities.length - 1)]!;
      if (a.id === b.id) continue;
      if (a.isBridge || b.isBridge) continue;
      if (a.cluster === b.cluster) continue;
      const key = a.cluster < b.cluster ? `${a.cluster}-${b.cluster}` : `${b.cluster}-${a.cluster}`;
      if (bridgeClusterPairKeys.has(key)) continue;
      const [low, high] = a.id < b.id ? [a.id, b.id] : [b.id, a.id];
      written.push({
        id: uuidv5(`${params.seed}|same_as|${counter++}`, SYNTHETIC_NS),
        entity_a_id: low,
        entity_b_id: high,
        reasoning: 'synthetic non-bridge same_as topology variation',
        confidence: 0.7,
        created_at: SYNTHETIC_TIMESTAMP,
      });
    }
    if (written.length > 0) {
      await sql`
        INSERT INTO public.same_as_links ${sql(written, 'id', 'entity_a_id', 'entity_b_id', 'reasoning', 'confidence', 'created_at')}
        ON CONFLICT DO NOTHING
      `;
    }
  } finally {
    await sql.end();
  }
}

/**
 * `pg_dump --format=plain` injects per-run non-determinism that breaks the
 * §3.3 "identical seed → byte-identical dump" contract. Strip:
 *   - `-- Started on …` / `-- Completed on …` wall-clock lines
 *   - `-- Dumped from/by pg_dump version …` (varies with client version)
 *   - `\restrict <token>` / `\unrestrict <token>` from pg_dump 17+ session
 *     cookies (random per run)
 *   - `ag_catalog.ag_graph` and `ag_catalog.ag_label` COPY blocks. These hold
 *     AGE internal catalog state (graph OIDs assigned at CREATE EXTENSION
 *     time). Restore re-runs CREATE EXTENSION which repopulates them — the
 *     OIDs assigned post-restore won't match the dumped OIDs anyway, so the
 *     section is dead weight and a determinism hazard.
 */
async function stripPgDumpHeaderTimestamp(dumpPath: string): Promise<void> {
  const original = readFileSync(dumpPath, 'utf-8');
  let s = original
    .replace(/^-- Started on .+$\r?\n/m, '')
    .replace(/^-- Completed on .+$\r?\n/m, '')
    .replace(/^-- Dumped from database version .+$\r?\n/m, '')
    .replace(/^-- Dumped by pg_dump version .+$\r?\n/m, '')
    .replace(/^\\restrict .+$\r?\n/gm, '')
    .replace(/^\\unrestrict .+$\r?\n/gm, '');
  s = stripCopyBlock(s, 'ag_catalog.ag_graph');
  s = stripCopyBlock(s, 'ag_catalog.ag_label');
  if (s !== original) {
    writeFileSync(dumpPath, s, 'utf-8');
  }
}

function stripCopyBlock(dump: string, qualifiedName: string): string {
  const startMarker = new RegExp(`^COPY ${qualifiedName} \\(.*\\) FROM stdin;$`, 'm');
  const start = dump.match(startMarker);
  if (!start) return dump;
  const startIdx = start.index!;
  const tail = dump.slice(startIdx);
  const endRel = tail.indexOf('\n\\.\n');
  if (endRel < 0) return dump;
  const endIdx = startIdx + endRel + '\n\\.\n'.length;
  return dump.slice(0, startIdx) + dump.slice(endIdx);
}

const invokedDirectly = process.argv[1]?.endsWith('generate-synthetic.ts')
  || process.argv[1]?.endsWith('generate-synthetic.js');

if (invokedDirectly) {
  const name = process.argv[2];
  if (!name) {
    console.error('Usage: pnpm snapshot:synthetic <name>');
    process.exit(2);
  }
  generateSynthetic(name).catch((err) => {
    console.error(`generate-synthetic failed: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  });
}

// Quiet linter: these imports are referenced through dynamic require paths
void existsSync;
void rmSync;
void readdirSync;
void statSync;
void join;
